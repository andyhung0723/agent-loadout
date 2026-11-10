import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readOrNull } from './documents.ts';
import {
  KINDS,
  resourceId,
  SOURCE_FILE_NAME,
  TOOLS,
  type HookSpec,
  type McpServer,
  type Overrides,
  type Resource,
  type Target,
  type Tool,
} from './manifest.ts';
import { observe } from './observe.ts';
import { collapseHome } from './paths.ts';
import { compressSelectors } from './selector.ts';
import { tomlKey, tomlValue } from './toml-text.ts';
import { configFiles } from './units.ts';
import { isPlainObject, stableStringify, withoutUndefined, type Plain } from './values.ts';

const PROFILE_DIR = new RegExp(`^\\.(${TOOLS.join('|')})(?:-([\\w-]+))?$`);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Definition = DistributiveOmit<Resource, 'to'>;
type Note = (location: string, hint?: string) => void;

export interface Unmanaged {
  target: string;
  location: string;
  hint?: string;
}

export interface ImportResult {
  targets: Target[];
  resources: Resource[];
  unmanaged: Unmanaged[];
}

export async function detectTargets(home: string): Promise<Target[]> {
  const entries = await readdir(home, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const match = PROFILE_DIR.exec(entry.name);
      if (!match) return [];
      const [, tool, profile] = match;
      return [
        {
          name: entry.name.slice(1),
          tool: tool as Tool,
          dir: path.join(home, entry.name),
          tags: profile ? [profile] : [],
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function importFromTargets(targets: Target[], home: string): Promise<ImportResult> {
  const groups = new Map<string, { definition: Definition; targets: Target[] }>();
  const unmanaged: Unmanaged[] = [];

  for (const target of targets) {
    const scan = await scanTarget(target, home);
    unmanaged.push(...scan.unmanaged);
    for (const definition of scan.definitions) {
      const key = stableStringify(definition);
      const group = groups.get(key) ?? { definition, targets: [] };
      group.targets.push(target);
      groups.set(key, group);
    }
  }

  const resources = disambiguateNames(
    [...groups.values()].map(({ definition, targets: selected }) => ({
      resource: { ...definition, to: compressSelectors(selected, targets) } as Resource,
      targets: selected,
    })),
  ).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));

  return { targets, resources, unmanaged };
}

async function scanTarget(
  target: Target,
  home: string,
): Promise<{ definitions: Definition[]; unmanaged: Unmanaged[] }> {
  const definitions: Definition[] = [];
  const unmanaged: Unmanaged[] = [];
  const note: Note = (location, hint) =>
    unmanaged.push({
      target: target.name,
      location: collapseHome(location, home),
      ...(hint ? { hint } : {}),
    });

  const instructions = await observe(configFiles.instructions(target));
  if (instructions.type === 'link') {
    definitions.push({ kind: 'instructions', name: 'shared', source: instructions.to });
  } else if (instructions.type === 'other') {
    note(configFiles.instructions(target));
  }

  for (const entry of await scanDir(configFiles.skills(target))) {
    if (entry.source) definitions.push({ kind: 'skill', name: entry.name, source: entry.source });
    else note(entry.path);
  }

  if (target.tool === 'claude') {
    for (const entry of await scanDir(configFiles.commands(target))) {
      const name = entry.name.replace(/\.md$/, '');
      if (entry.source) definitions.push({ kind: 'command', name, source: entry.source });
      else note(entry.path);
    }
  }

  for (const entry of await scanDir(configFiles.agents(target))) {
    note(entry.path, 'agents are generated from a neutral source, see README "Agents"');
  }

  if (target.tool === 'claude') {
    const settings = await readJson(configFiles.claudeSettings(target));
    const state = await readJson(configFiles.claudeState(target));
    definitions.push(
      ...importHooks(settings.hooks, configFiles.claudeSettings(target), home, note),
      ...importClaudeMcp(state.mcpServers, home),
      ...importClaudePlugins(settings.enabledPlugins),
      ...importMarketplaces(settings.extraKnownMarketplaces),
    );
  } else {
    const hooks = await readJson(configFiles.codexHooks(target));
    const config = await readToml(configFiles.codexConfig(target));
    definitions.push(
      ...importHooks(hooks.hooks, configFiles.codexHooks(target), home, note),
      ...importCodexMcp(config.mcp_servers, home),
      ...importCodexPlugins(config.plugins, configFiles.codexConfig(target), note),
    );
  }

  return { definitions, unmanaged };
}

function importHooks(value: unknown, file: string, home: string, note: Note): Definition[] {
  if (!isPlainObject(value)) return [];
  const bySpec = new Map<string, { spec: HookSpec; events: string[] }>();

  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const spec = hookSpecOf(group, home);
      if (!spec) {
        note(`${file} hooks.${event}[${index}]`, 'only single-command hook groups are importable');
        return;
      }
      const key = stableStringify(spec);
      const entry = bySpec.get(key) ?? { spec, events: [] };
      entry.events.push(event);
      bySpec.set(key, entry);
    });
  }

  return [...bySpec.values()].map(({ spec, events }) => ({
    kind: 'hook',
    name: hookName(spec.command),
    events: events.sort(),
    spec,
    overrides: {},
  }));
}

const HOOK_KEYS = ['type', 'command', 'timeout'];
const HOOK_GROUP_KEYS = ['matcher', 'hooks'];

function hookSpecOf(group: unknown, home: string): HookSpec | null {
  if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.length !== 1) {
    return null;
  }
  const [hook] = group.hooks;
  if (!isPlainObject(hook) || hook.type !== 'command' || typeof hook.command !== 'string') {
    return null;
  }
  const hasUnknownKeys =
    Object.keys(hook).some((key) => !HOOK_KEYS.includes(key)) ||
    Object.keys(group).some((key) => !HOOK_GROUP_KEYS.includes(key));
  if (hasUnknownKeys) return null;

  return withoutUndefined({
    matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
    command: collapseLeadingHome(hook.command, home),
    timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined,
  });
}

function hookName(command: string): string {
  const tokens = command.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ''));
  const script = tokens.find((token) => token.includes('/')) ?? tokens[0] ?? 'hook';
  return path.basename(script).replace(/\.[^.]+$/, '') || 'hook';
}

function importClaudeMcp(value: unknown, home: string): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!isPlainObject(raw)) return [];
    const { type, command, args, env, url, headers, ...rest } = raw;
    const server = mcpServer({ command, args, env, url, headers }, home);
    const inferredType = server.url ? 'http' : 'stdio';
    const claude = withoutUndefined({ ...(type !== inferredType ? { type } : {}), ...rest });
    return [mcpDefinition(name, server, { claude })];
  });
}

function importCodexMcp(value: unknown, home: string): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!isPlainObject(raw)) return [];
    const { command, args, env, url, http_headers, ...rest } = raw;
    const server = mcpServer({ command, args, env, url, headers: http_headers }, home);
    return [mcpDefinition(name, server, { codex: rest })];
  });
}

function mcpServer(raw: Plain, home: string): McpServer {
  return withoutUndefined({
    command: typeof raw.command === 'string' ? collapseLeadingHome(raw.command, home) : undefined,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
    url: raw.url as string | undefined,
    headers: raw.headers as Record<string, string> | undefined,
  });
}

function mcpDefinition(name: string, server: McpServer, overrides: Overrides): Definition {
  const nonEmpty = Object.fromEntries(
    Object.entries(overrides).filter(([, table]) => table && Object.keys(table).length > 0),
  );
  return { kind: 'mcp', name, server, overrides: nonEmpty };
}

function importClaudePlugins(value: unknown): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, enabled]): Definition[] =>
    typeof enabled === 'boolean' ? [{ kind: 'plugin', name, enabled }] : [],
  );
}

function importCodexPlugins(value: unknown, file: string, note: Note): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]): Definition[] => {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== 'enabled')) {
      note(`${file} plugins.${name}`, 'has settings beyond "enabled"');
      return [];
    }
    return [{ kind: 'plugin', name, enabled: raw.enabled !== false }];
  });
}

function importMarketplaces(value: unknown): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, config]): Definition[] =>
    isPlainObject(config) ? [{ kind: 'marketplace', name, config }] : [],
  );
}

function disambiguateNames(items: { resource: Resource; targets: Target[] }[]): Resource[] {
  const count = new Map<string, number>();
  for (const { resource } of items) {
    const id = resourceId(resource);
    count.set(id, (count.get(id) ?? 0) + 1);
  }

  const taken = new Set<string>();
  return items.map(({ resource, targets }) => {
    if (count.get(resourceId(resource)) === 1) return resource;
    const tools = new Set(targets.map((target) => target.tool));
    const suffix = targets.length === 1 || tools.size > 1 ? targets[0]!.name : [...tools][0]!;
    let name = `${resource.name}-${suffix}`;
    for (let n = 2; taken.has(`${resource.kind}:${name}`); n++) {
      name = `${resource.name}-${suffix}-${n}`;
    }
    taken.add(`${resource.kind}:${name}`);
    return resource.kind === 'hook'
      ? { ...resource, name }
      : { ...resource, name, key: resource.name };
  });
}

async function scanDir(dir: string): Promise<{ name: string; path: string; source?: string }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const visible = names.filter((name) => !name.startsWith('.')).sort();
  return Promise.all(
    visible.map(async (name) => {
      const entryPath = path.join(dir, name);
      const observed = await observe(entryPath);
      return observed.type === 'link'
        ? { name, path: entryPath, source: observed.to }
        : { name, path: entryPath };
    }),
  );
}

async function readJson(file: string): Promise<Plain> {
  const text = await readOrNull(file);
  if (!text?.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  return isPlainObject(parsed) ? parsed : {};
}

async function readToml(file: string): Promise<Plain> {
  const text = await readOrNull(file);
  return text ? parseToml(text) : {};
}

function collapseLeadingHome(command: string, home: string): string {
  const [head = '', ...rest] = command.split(' ');
  return [collapseHome(head, home), ...rest].join(' ');
}

export function renderManifest(result: ImportResult, home: string): string {
  const show = (p: string) => JSON.stringify(collapseHome(p, home));
  const aliases = assignSourceAliases(result.resources, home);
  const lines: string[] = [
    '# Generated by `loadout import`. Edit freely; this file is the source of truth.',
    '',
  ];

  for (const target of result.targets) {
    lines.push(
      `[targets.${tomlKey(target.name)}]`,
      `tool = ${tomlValue(target.tool)}`,
      `dir = ${show(target.dir)}`,
      `tags = ${tomlValue(target.tags)}`,
      '',
    );
  }

  if (aliases.size > 0) {
    lines.push('[sources]');
    for (const [root, alias] of aliases) lines.push(`${tomlKey(alias)} = ${show(root)}`);
    lines.push('');
  }

  let previousKind: string | undefined;
  for (const resource of result.resources) {
    if (resource.kind !== previousKind) lines.push(`# ── ${resource.kind} ──`, '');
    previousKind = resource.kind;
    lines.push(...renderResource(resource, aliases, show), '');
  }

  if (result.unmanaged.length > 0) {
    lines.push('# Not managed (left untouched):');
    for (const item of result.unmanaged) {
      lines.push(`#   ${item.target}: ${item.location}${item.hint ? `  — ${item.hint}` : ''}`);
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

function renderResource(
  resource: Resource,
  aliases: Map<string, string>,
  show: (p: string) => string,
): string[] {
  const head = [
    ...(looksSecret(resource)
      ? [
          '# ⚠ looks like it contains a secret — replace it with "${env:NAME}" or "${keychain:service}" before committing',
        ]
      : []),
    `[[${resource.kind}]]`,
    `name = ${tomlValue(resource.name)}`,
    ...(resource.key ? [`key = ${tomlValue(resource.key)}`] : []),
  ];
  const to = `to = ${tomlValue(resource.to)}`;
  const entries = (table: Plain) =>
    Object.entries(table)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`);
  const overrideTables = (overrides: Overrides) =>
    Object.entries(overrides).flatMap(([tool, table]) => [
      `[${resource.kind}.${tool}]`,
      ...entries(table ?? {}),
    ]);

  switch (resource.kind) {
    case 'instructions':
      return [...head, `path = ${show(resource.source)}`, to];
    case 'skill':
    case 'command':
    case 'agent': {
      const alias = aliasFor(resource.kind, resource.name, resource.source, aliases);
      const from = alias ? `from = ${tomlValue(alias)}` : `path = ${show(resource.source)}`;
      return [...head, from, to];
    }
    case 'hook':
      return [
        ...head,
        `events = ${tomlValue(resource.events)}`,
        ...entries({ ...resource.spec }),
        to,
        ...overrideTables(resource.overrides),
      ];
    case 'mcp':
      return [
        ...head,
        ...entries({ ...resource.server }),
        to,
        ...overrideTables(resource.overrides),
      ];
    case 'plugin':
      return [...head, `enabled = ${resource.enabled}`, to];
    case 'marketplace':
      return [...head, ...entries(resource.config), to];
  }
}

const SECRET_PATTERN = /(api[-_]?key|token|secret|password|bearer|\bsk-|ctx7sk)/i;

function looksSecret(resource: Resource): boolean {
  if (resource.kind !== 'mcp') return false;
  const { args, env, headers } = resource.server;
  return SECRET_PATTERN.test(stableStringify({ args, env, headers, ...resource.overrides }));
}

function aliasFor(
  kind: 'skill' | 'command' | 'agent',
  name: string,
  source: string,
  aliases: Map<string, string>,
): string | undefined {
  if (path.basename(source) !== SOURCE_FILE_NAME[kind](name)) return undefined;
  return aliases.get(path.dirname(source));
}

function assignSourceAliases(resources: Resource[], home: string): Map<string, string> {
  const roots = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== 'skill' && resource.kind !== 'command' && resource.kind !== 'agent') {
      continue;
    }
    if (path.basename(resource.source) === SOURCE_FILE_NAME[resource.kind](resource.name)) {
      roots.add(path.dirname(resource.source));
    }
  }

  const sortedRoots = [...roots].sort();
  const bases = new Map(sortedRoots.map((root) => [root, aliasBase(root, home)]));
  const baseCount = new Map<string, number>();
  for (const base of bases.values()) baseCount.set(base, (baseCount.get(base) ?? 0) + 1);

  const aliases = new Map<string, string>();
  const taken = new Set<string>();
  for (const root of sortedRoots) {
    const base = bases.get(root)!;
    const distinct = baseCount.get(base)! > 1 ? `${base}-${slug(path.basename(root))}` : base;
    let alias = distinct;
    for (let n = 2; taken.has(alias); n++) alias = `${distinct}-${n}`;
    taken.add(alias);
    aliases.set(root, alias);
  }
  return aliases;
}

const UNINFORMATIVE_SEGMENT = /^(skills|commands|agents|\..*)$/;

function aliasBase(root: string, home: string): string {
  let current = root;
  while (
    UNINFORMATIVE_SEGMENT.test(path.basename(current)) &&
    path.dirname(current) !== home &&
    path.dirname(current) !== current
  ) {
    current = path.dirname(current);
  }
  return slug(path.basename(current)) || 'source';
}

function slug(segment: string): string {
  return segment
    .replace(/^\./, '')
    .replace(/[^\w-]/g, '-')
    .toLowerCase();
}
