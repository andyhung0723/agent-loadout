import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentSource } from '../agent-render.ts';
import {
  importHooks,
  isAppManaged,
  mcpDefinition,
  mcpServer,
  readJson,
  readToml,
  type Note,
} from '../import-common.ts';
import type { Definition } from '../importer.ts';
import { gitExcludeFile, type Layout } from '../layout.ts';
import { configKey, isProject, type McpResource, type Resource, type Target } from '../manifest.ts';
import { collapseHome } from '../paths.ts';
import { tomlKey, tomlMultiline, tomlValue } from '../toml-text.ts';
import { isPlainObject, withoutUndefined, type Plain } from '../values.ts';
import { hookGroup } from './hooks.ts';
import { isCodexMarketplace } from './marketplace.ts';
import type { Unit } from '../units.ts';
import type { Placement, ToolAdapter, ValueKind } from './types.ts';

interface CodexLayout extends Layout {
  config?: string;
  hooks?: string;
}

/** Plugins bundled with the Codex app change on app updates: observe, don't own. */
const APP_BUNDLED_PLUGIN = /@openai-bundled$/;

/** Marketplaces the Codex app unpacks from its own bundle or runtime download. */
const APP_MARKETPLACE_SOURCE = /\/\.tmp\/bundled-marketplaces\/|\/\.cache\/codex-runtimes\//;

function codexLayout(target: Target): CodexLayout {
  const at = (...parts: string[]) => path.join(target.dir, ...parts);
  if (!isProject(target)) {
    return {
      instructions: at('AGENTS.md'),
      skills: at('skills'),
      agents: at('agents'),
      config: at('config.toml'),
      hooks: at('hooks.json'),
      copy: false,
      committed: false,
    };
  }
  if (target.visibility === 'shared') {
    return {
      instructions: at('AGENTS.md'),
      skills: at('.agents', 'skills'),
      config: at('.codex', 'config.toml'),
      hooks: at('.codex', 'hooks.json'),
      copy: true,
      committed: true,
    };
  }
  // Codex has no personal layer inside a repository: only repo skills can stay local.
  const gitExclude = gitExcludeFile(target.dir);
  return {
    skills: at('.agents', 'skills'),
    copy: false,
    ...(gitExclude ? { gitExclude } : {}),
    committed: false,
  };
}

export const codex: ToolAdapter = {
  name: 'codex',
  displayName: 'Codex',
  layout: codexLayout,
  sharesSkillsAcrossProfiles: true,

  holds(resource, target: Target) {
    const layout = codexLayout(target);
    switch (resource.kind) {
      case 'hook':
        return layout.hooks !== undefined;
      case 'mcp':
      case 'plugin':
        return layout.config !== undefined;
      case 'marketplace':
        // Codex reads marketplaces from the user config only.
        return !isProject(target) && isCodexMarketplace(resource.config);
    }
  },

  place(kind: ValueKind, resource: Resource, target: Target): Placement[] {
    const layout = codexLayout(target);
    const key = configKey(resource);
    switch (resource.kind) {
      case 'hook': {
        const group = hookGroup(resource, 'codex');
        return resource.events.map((event) => ({
          locator: { driver: 'json-item', file: layout.hooks!, pointer: ['hooks', event] },
          value: group,
        }));
      }
      case 'mcp':
        return [
          {
            locator: { driver: 'toml-table', file: layout.config!, pointer: ['mcp_servers', key] },
            value: mcpValue(resource),
          },
        ];
      case 'plugin':
        return [
          {
            locator: { driver: 'toml-table', file: layout.config!, pointer: ['plugins', key] },
            value: { enabled: resource.enabled },
          },
        ];
      case 'marketplace':
        return [
          {
            locator: { driver: 'toml-table', file: layout.config!, pointer: ['marketplaces', key] },
            value: resource.config,
          },
        ];
      default:
        throw new Error(`internal: codex has no place for ${kind}`);
    }
  },

  agent: {
    extension: 'toml',
    render(agent: AgentSource) {
      const fields = { ...agent.shared, ...agent.perTool.codex };
      const lines = Object.entries(fields).map(
        ([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`,
      );
      return `${lines.join('\n')}\n\ndeveloper_instructions = ${tomlMultiline(agent.body)}\n`;
    },
    parse(text: string) {
      const { developer_instructions: instructions, ...fields } = parseToml(text);
      return typeof instructions === 'string' ? { fields, body: instructions.trim() } : { fields };
    },
  },

  async importSettings(target: Target, home: string, note: Note): Promise<Definition[]> {
    const layout = codexLayout(target);
    const hooks = await readJson(layout.hooks!);
    const config = await readToml(layout.config!);
    return [
      ...importHooks(hooks.hooks, layout.hooks!, home, note),
      ...importMcp(config.mcp_servers, home),
      ...importPlugins(config.plugins, layout.config!, note),
      ...importMarketplaces(config.marketplaces, home),
    ];
  },

  async warnings(target, units, entries, context) {
    if (isProject(target)) return [];
    return [
      ...(await hookWarnings(target, units, entries, context)),
      ...fetchWarnings(target, units),
    ];
  },
};

/** Codex ignores hooks.json until `[features] hooks = true`, and asks to trust new hooks. */
const hookWarnings: NonNullable<ToolAdapter['warnings']> = async (
  target,
  units,
  entries,
  { documents },
) => {
  const layout = codexLayout(target);
  if (!layout.hooks || !layout.config) return [];
  const hookUnits = units.filter((unit) => unit.file === layout.hooks);
  if (hookUnits.length === 0) return [];

  const warnings: string[] = [];
  if ((await documents.tomlGet(layout.config, ['features', 'hooks'])) !== true) {
    warnings.push(
      `${target.name}: hooks are ignored until ${layout.config} has [features] hooks = true`,
    );
  }
  const changed = entries.some(
    (entry) =>
      entry.target === target.name &&
      (entry.action === 'create' || entry.action === 'replace') &&
      hookUnits.some((unit) => unit.key === entry.key),
  );
  if (changed) {
    warnings.push(`${target.name}: Codex will ask you to trust new or changed hooks on next start`);
  }
  return warnings;
};

/**
 * Codex only reads its config: a Git marketplace is cloned by `codex plugin marketplace
 * add|upgrade`, and a plugin is unpacked into plugins/cache by `codex plugin add`. Say which
 * command a managed entry still needs instead of running it (it reaches the network).
 */
function fetchWarnings(target: Target, units: Unit[]): string[] {
  const layout = codexLayout(target);
  const own = units.filter(
    (unit) => unit.target === target.name && unit.file === layout.config && !unit.observe,
  );
  const codex =
    target.dir === path.join(os.homedir(), '.codex')
      ? 'codex'
      : `CODEX_HOME=${collapseHome(target.dir)} codex`;
  const warnings: string[] = [];

  const unfetched = own.filter(
    (unit) =>
      unit.pointer[0] === 'marketplaces' &&
      isPlainObject(unit.value) &&
      unit.value.source_type === 'git' &&
      !existsSync(path.join(target.dir, '.tmp', 'marketplaces', unit.pointer[1]!)),
  );
  if (unfetched.length > 0) {
    const names = unfetched.map((unit) => unit.pointer[1]).join(', ');
    warnings.push(
      `${target.name}: marketplace ${names} not fetched yet; run \`${codex} plugin marketplace upgrade\``,
    );
  }

  for (const unit of own) {
    if (unit.pointer[0] !== 'plugins' || !isPlainObject(unit.value) || !unit.value.enabled)
      continue;
    const id = unit.pointer[1]!;
    const [plugin, marketplace] = id.split('@');
    if (!plugin || !marketplace) continue;
    if (!existsSync(path.join(target.dir, 'plugins', 'cache', marketplace, plugin))) {
      warnings.push(
        `${target.name}: plugin ${id} not installed yet; run \`${codex} plugin add ${id}\``,
      );
    }
  }
  return warnings;
}

function mcpValue(resource: McpResource): Plain {
  const { command, args, env, url, headers } = resource.server;
  const base = url ? { url, http_headers: headers } : { command, args, env };
  return withoutUndefined({ ...base, ...resource.overrides.codex });
}

function importMcp(value: unknown, home: string): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!isPlainObject(raw)) return [];
    const { command, args, env, url, http_headers, ...rest } = raw;
    const server = mcpServer({ command, args, env, url, headers: http_headers }, home);
    const definition = mcpDefinition(name, server, { codex: rest });
    return [isAppManaged(raw) ? { ...definition, mode: 'observe' as const } : definition];
  });
}

function importPlugins(value: unknown, file: string, note: Note): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]): Definition[] => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== 'enabled')) {
      note('plugin', `${file} plugins.${name}`, 'has settings beyond "enabled"');
      return [];
    }
    const definition: Definition = { kind: 'plugin', name, enabled: raw.enabled !== false };
    return [APP_BUNDLED_PLUGIN.test(name) ? { ...definition, mode: 'observe' } : definition];
  });
}

function importMarketplaces(value: unknown, home: string): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]): Definition[] => {
    if (!isPlainObject(raw) || typeof raw.source !== 'string') return [];
    const config =
      raw.source_type === 'local' ? { ...raw, source: collapseHome(raw.source, home) } : raw;
    const definition: Definition = { kind: 'marketplace', name, config };
    return [
      APP_MARKETPLACE_SOURCE.test(raw.source) ? { ...definition, mode: 'observe' } : definition,
    ];
  });
}
