import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { expandHome } from './paths.ts';
import { assertSelectorsResolve } from './selector.ts';
import { isPlainObject, type Plain } from './values.ts';

export const TOOLS = ['claude', 'codex'] as const;
export type Tool = (typeof TOOLS)[number];

export const KINDS = [
  'instructions',
  'skill',
  'command',
  'agent',
  'hook',
  'mcp',
  'plugin',
  'marketplace',
] as const;
export type Kind = (typeof KINDS)[number];

export interface Target {
  name: string;
  tool: Tool;
  dir: string;
  tags: string[];
}

interface ResourceBase {
  name: string;
  key?: string;
  mode?: 'observe';
  to: string[];
}

export type Overrides = Partial<Record<Tool, Plain>>;

export interface LinkResource extends ResourceBase {
  kind: 'instructions' | 'skill' | 'command';
  source: string;
}

export interface AgentResource extends ResourceBase {
  kind: 'agent';
  source: string;
}

export interface HookSpec {
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface HookResource extends ResourceBase {
  kind: 'hook';
  events: string[];
  spec: HookSpec;
  overrides: Overrides;
}

export interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpResource extends ResourceBase {
  kind: 'mcp';
  server: McpServer;
  overrides: Overrides;
}

export interface PluginResource extends ResourceBase {
  kind: 'plugin';
  enabled: boolean;
}

export interface MarketplaceResource extends ResourceBase {
  kind: 'marketplace';
  config: Plain;
}

export type Resource =
  LinkResource | AgentResource | HookResource | McpResource | PluginResource | MarketplaceResource;

export interface Manifest {
  targets: Target[];
  resources: Resource[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

export const SOURCE_FILE_NAME: Record<'skill' | 'command' | 'agent', (name: string) => string> = {
  skill: (name) => name,
  command: (name) => `${name}.md`,
  agent: (name) => `${name}.md`,
};

export function configKey(resource: Pick<Resource, 'name' | 'key'>): string {
  return resource.key ?? resource.name;
}

export function resourceId(resource: Pick<Resource, 'kind' | 'name'>): string {
  return `${resource.kind}:${resource.name}`;
}

export async function loadManifest(file: string, home?: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ManifestError(`not found: ${file} (bootstrap with "loadout import --write")`);
    }
    throw error;
  }
  return parseManifest(text, home);
}

export function parseManifest(text: string, home?: string): Manifest {
  let raw: Plain;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ManifestError(`invalid TOML: ${(error as Error).message}`);
  }

  const root = new Reader(raw, '', home);
  const targets = parseTargets(root.optTable('targets'), home);
  const sourceTable = root.optTable('sources');
  const sources = new Map(
    Object.keys(sourceTable.raw).map((alias) => [alias, sourceTable.path(alias)]),
  );

  const resources = KINDS.flatMap((kind) =>
    root.tableArray(kind).map((entry) => withMode(parseResource(kind, entry, sources), entry)),
  );

  assertUniqueResources(resources);
  for (const resource of resources) {
    assertSelectorsResolve(resource.to, targets, resourceId(resource));
  }
  return { targets, resources };
}

function parseTargets(table: Reader, home?: string): Target[] {
  return Object.keys(table.raw).map((name) => {
    const entry = table.table(name);
    const tool = entry.string('tool');
    if (!(TOOLS as readonly string[]).includes(tool)) {
      throw new ManifestError(`${entry.where('tool')} must be one of: ${TOOLS.join(', ')}`);
    }
    return {
      name,
      tool: tool as Tool,
      dir: expandHome(entry.string('dir'), home),
      tags: entry.optStringArray('tags') ?? [],
    };
  });
}

function parseResource(kind: Kind, entry: Reader, sources: Map<string, string>): Resource {
  const name = entry.string('name');
  const to = entry.list('to');
  const key = entry.optString('key');

  switch (kind) {
    case 'instructions':
      return { kind, name, key, to, source: entry.path('path') };
    case 'skill':
    case 'command':
    case 'agent':
      return {
        kind,
        name,
        key,
        to,
        source: resolveSource(entry, SOURCE_FILE_NAME[kind](name), sources),
      };
    case 'hook':
      return {
        kind,
        name,
        key,
        to,
        events: entry.stringArray('events'),
        spec: {
          matcher: entry.optString('matcher'),
          command: entry.command('command')!,
          timeout: entry.optNumber('timeout'),
        },
        overrides: parseOverrides(entry),
      };
    case 'mcp': {
      const server: McpServer = {
        command: entry.command('command'),
        args: entry.optStringArray('args'),
        env: entry.optStringMap('env'),
        url: entry.optString('url'),
        headers: entry.optStringMap('headers'),
      };
      if ((server.command === undefined) === (server.url === undefined)) {
        throw new ManifestError(`${entry.where()}: needs exactly one of "command" or "url"`);
      }
      return { kind, name, key, to, server, overrides: parseOverrides(entry) };
    }
    case 'plugin':
      return { kind, name, key, to, enabled: entry.optBoolean('enabled') ?? true };
    case 'marketplace': {
      const { name: _name, key: _key, mode: _mode, to: _to, ...config } = entry.raw;
      if (Object.keys(config).length === 0) {
        throw new ManifestError(`${entry.where()}: needs marketplace settings such as "source"`);
      }
      return { kind, name, key, to, config };
    }
  }
}

const MODES = ['manage', 'observe'] as const;

function withMode(resource: Resource, entry: Reader): Resource {
  const mode = entry.optString('mode') ?? 'manage';
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new ManifestError(`${entry.where('mode')} must be one of: ${MODES.join(', ')}`);
  }
  return mode === 'observe' ? { ...resource, mode } : resource;
}

function resolveSource(entry: Reader, fileName: string, sources: Map<string, string>): string {
  if (entry.has('path')) return entry.path('path');
  if (!entry.has('from')) {
    throw new ManifestError(`${entry.where()}: needs either "from" (source alias) or "path"`);
  }
  const alias = entry.string('from');
  const root = sources.get(alias);
  if (root === undefined)
    throw new ManifestError(`${entry.where('from')}: unknown source "${alias}"`);
  return path.join(root, fileName);
}

function parseOverrides(entry: Reader): Overrides {
  return Object.fromEntries(
    TOOLS.filter((tool) => entry.has(tool)).map((tool) => {
      const table = entry.table(tool);
      return [
        tool,
        table.has('command') ? { ...table.raw, command: table.command('command') } : table.raw,
      ];
    }),
  );
}

function assertUniqueResources(resources: Resource[]): void {
  const seen = new Set<string>();
  for (const resource of resources) {
    const id = resourceId(resource);
    if (seen.has(id)) throw new ManifestError(`duplicate resource: ${id}`);
    seen.add(id);
  }
}

class Reader {
  readonly raw: Plain;
  readonly #where: string;
  readonly #home: string | undefined;

  constructor(raw: Plain, where: string, home?: string) {
    this.raw = raw;
    this.#where = where;
    this.#home = home;
  }

  where(key?: string): string {
    if (key === undefined) return this.#where || '<root>';
    return this.#where ? `${this.#where}.${key}` : key;
  }

  has(key: string): boolean {
    return this.raw[key] !== undefined;
  }

  table(key: string): Reader {
    const value = this.raw[key];
    if (!isPlainObject(value)) throw new ManifestError(`${this.where(key)} must be a table`);
    return new Reader(value, this.where(key), this.#home);
  }

  optTable(key: string): Reader {
    return this.has(key) ? this.table(key) : new Reader({}, this.where(key), this.#home);
  }

  tableArray(key: string): Reader[] {
    const value = this.raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isPlainObject)) {
      throw new ManifestError(`${this.where(key)} must be an array of tables ([[${key}]])`);
    }
    return value.map((entry, index) => new Reader(entry, `${key}[${index}]`, this.#home));
  }

  string(key: string): string {
    const value = this.raw[key];
    if (typeof value !== 'string' || value === '') {
      throw new ManifestError(`${this.where(key)} must be a non-empty string`);
    }
    return value;
  }

  optString(key: string): string | undefined {
    return this.has(key) ? this.string(key) : undefined;
  }

  command(key: string): string | undefined {
    const value = this.optString(key);
    if (value === undefined) return undefined;
    const [head = '', ...rest] = value.split(' ');
    return [head.startsWith('~/') ? expandHome(head, this.#home) : head, ...rest].join(' ');
  }

  path(key: string): string {
    return expandHome(this.string(key), this.#home);
  }

  optNumber(key: string): number | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number') throw new ManifestError(`${this.where(key)} must be a number`);
    return value;
  }

  optBoolean(key: string): boolean | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new ManifestError(`${this.where(key)} must be a boolean`);
    return value;
  }

  list(key: string): string[] {
    const value = this.optStringArray(key);
    if (value === undefined) {
      throw new ManifestError(`${this.where(key)} is required (use [] to keep it everywhere off)`);
    }
    return value;
  }

  stringArray(key: string): string[] {
    const value = this.optStringArray(key);
    if (value === undefined || value.length === 0) {
      throw new ManifestError(`${this.where(key)} must be a non-empty array of strings`);
    }
    return value;
  }

  optStringArray(key: string): string[] | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new ManifestError(`${this.where(key)} must be an array of strings`);
    }
    return value;
  }

  optStringMap(key: string): Record<string, string> | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || !Object.values(value).every((v) => typeof v === 'string')) {
      throw new ManifestError(`${this.where(key)} must be a table of strings`);
    }
    return value as Record<string, string>;
  }
}
