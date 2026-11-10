import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderAgent } from './agent-render.ts';
import {
  configKey,
  ManifestError,
  resourceId,
  type HookResource,
  type Kind,
  type Manifest,
  type McpResource,
  type Resource,
  type Target,
  type Tool,
} from './manifest.ts';
import { exists } from './observe.ts';
import { selectTargets } from './selector.ts';
import { describeRef, interpolate, type SecretResolver } from './secrets.ts';
import { fingerprintOf, sha256, withoutUndefined, type Plain } from './values.ts';

export type DriverName = 'link' | 'file' | 'json-key' | 'json-item' | 'toml-table';

export interface Locator {
  driver: DriverName;
  file: string;
  pointer: string[];
}

export interface Unit extends Locator {
  key: string;
  resource: string;
  target: string;
  value: unknown;
  fingerprint: string;
  problem?: string;
}

const UNSUPPORTED: Record<Tool, readonly Kind[]> = {
  claude: [],
  codex: ['command', 'marketplace'],
};

export function supports(kind: Kind, tool: Tool): boolean {
  return !UNSUPPORTED[tool].includes(kind);
}

export function unitKey(locator: Locator, resource: string): string {
  const base = `${locator.driver}:${locator.file}`;
  const withPointer = locator.pointer.length ? `${base}#${locator.pointer.join('/')}` : base;
  return locator.driver === 'json-item' ? `${withPointer}@${resource}` : withPointer;
}

export function describeLocation(locator: Locator): string {
  return locator.pointer.length ? `${locator.file} ${locator.pointer.join('.')}` : locator.file;
}

export const configFiles = {
  claudeSettings: (target: Target) => path.join(target.dir, 'settings.json'),
  claudeState: (target: Target) => path.join(target.dir, '.claude.json'),
  codexConfig: (target: Target) => path.join(target.dir, 'config.toml'),
  codexHooks: (target: Target) => path.join(target.dir, 'hooks.json'),
  instructions: (target: Target) =>
    path.join(target.dir, target.tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'),
  skills: (target: Target) => path.join(target.dir, 'skills'),
  commands: (target: Target) => path.join(target.dir, 'commands'),
  agents: (target: Target) => path.join(target.dir, 'agents'),
};

const VALUE_DRIVERS: ReadonlySet<DriverName> = new Set(['json-key', 'json-item', 'toml-table']);

export async function desiredUnits(manifest: Manifest, secrets: SecretResolver): Promise<Unit[]> {
  const byKey = new Map<string, Unit>();
  for (const resource of manifest.resources) {
    const targets = selectTargets(resource.to, manifest.targets).filter((target) =>
      supports(resource.kind, target.tool),
    );
    for (const target of targets) {
      for (const raw of await unitsFor(resource, target)) {
        const unit = await resolveSecrets(raw, secrets);
        const clash = byKey.get(unit.key);
        if (clash) {
          throw new ManifestError(
            `${unit.resource} and ${clash.resource} both claim ${describeLocation(unit)} on ${target.name}`,
          );
        }
        byKey.set(unit.key, unit);
      }
    }
  }
  return [...byKey.values()];
}

async function resolveSecrets(unit: Unit, secrets: SecretResolver): Promise<Unit> {
  if (!VALUE_DRIVERS.has(unit.driver) || unit.problem) return unit;
  const { value, missing } = await interpolate(unit.value, secrets);
  if (missing.length > 0) {
    return { ...unit, problem: `unresolved secret ${missing.map(describeRef).join(', ')}` };
  }
  return { ...unit, value, fingerprint: fingerprintOf(value) };
}

async function unitsFor(resource: Resource, target: Target): Promise<Unit[]> {
  const id = resourceId(resource);
  const make = (locator: Locator, value: unknown, fingerprint: string, problem?: string): Unit => ({
    ...locator,
    key: unitKey(locator, id),
    resource: id,
    target: target.name,
    value,
    fingerprint,
    ...(problem ? { problem } : {}),
  });
  const valueUnit = (locator: Locator, value: unknown) =>
    make(locator, value, fingerprintOf(value));

  switch (resource.kind) {
    case 'instructions':
    case 'skill':
    case 'command': {
      const dest = linkDestination(resource.kind, configKey(resource), target);
      const problem = (await exists(resource.source)) ? undefined : 'source does not exist';
      return [
        make(
          { driver: 'link', file: dest, pointer: [] },
          resource.source,
          resource.source,
          problem,
        ),
      ];
    }
    case 'agent': {
      const extension = target.tool === 'claude' ? 'md' : 'toml';
      const locator: Locator = {
        driver: 'file',
        file: path.join(configFiles.agents(target), `${configKey(resource)}.${extension}`),
        pointer: [],
      };
      try {
        const content = renderAgent(
          await readFile(resource.source, 'utf8'),
          configKey(resource),
          target.tool,
        );
        return [make(locator, content, sha256(content))];
      } catch (error) {
        const problem =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'source does not exist'
            : (error as Error).message;
        return [make(locator, '', '', problem)];
      }
    }
    case 'hook': {
      const file =
        target.tool === 'claude'
          ? configFiles.claudeSettings(target)
          : configFiles.codexHooks(target);
      const group = hookGroup(resource, target.tool);
      return resource.events.map((event) =>
        valueUnit({ driver: 'json-item', file, pointer: ['hooks', event] }, group),
      );
    }
    case 'mcp':
      return target.tool === 'claude'
        ? [
            valueUnit(
              {
                driver: 'json-key',
                file: configFiles.claudeState(target),
                pointer: ['mcpServers', configKey(resource)],
              },
              claudeMcp(resource),
            ),
          ]
        : [
            valueUnit(
              {
                driver: 'toml-table',
                file: configFiles.codexConfig(target),
                pointer: ['mcp_servers', configKey(resource)],
              },
              codexMcp(resource),
            ),
          ];
    case 'plugin':
      return target.tool === 'claude'
        ? [
            valueUnit(
              {
                driver: 'json-key',
                file: configFiles.claudeSettings(target),
                pointer: ['enabledPlugins', configKey(resource)],
              },
              resource.enabled,
            ),
          ]
        : [
            valueUnit(
              {
                driver: 'toml-table',
                file: configFiles.codexConfig(target),
                pointer: ['plugins', configKey(resource)],
              },
              { enabled: resource.enabled },
            ),
          ];
    case 'marketplace':
      return [
        valueUnit(
          {
            driver: 'json-key',
            file: configFiles.claudeSettings(target),
            pointer: ['extraKnownMarketplaces', configKey(resource)],
          },
          resource.config,
        ),
      ];
  }
}

function linkDestination(kind: 'instructions' | 'skill' | 'command', name: string, target: Target) {
  switch (kind) {
    case 'instructions':
      return configFiles.instructions(target);
    case 'skill':
      return path.join(configFiles.skills(target), name);
    case 'command':
      return path.join(configFiles.commands(target), `${name}.md`);
  }
}

export function hookGroup(resource: HookResource, tool: Tool): Plain {
  const spec = { ...resource.spec, ...resource.overrides[tool] };
  return withoutUndefined({
    matcher: spec.matcher,
    hooks: [
      withoutUndefined({
        type: 'command',
        command: spec.command,
        timeout: spec.timeout,
      }),
    ],
  });
}

function claudeMcp(resource: McpResource): Plain {
  const { command, args, env, url, headers } = resource.server;
  const base = url ? { type: 'http', url, headers } : { type: 'stdio', command, args, env };
  return withoutUndefined({ ...base, ...resource.overrides.claude });
}

function codexMcp(resource: McpResource): Plain {
  const { command, args, env, url, headers } = resource.server;
  const base = url ? { url, http_headers: headers } : { command, args, env };
  return withoutUndefined({ ...base, ...resource.overrides.codex });
}
