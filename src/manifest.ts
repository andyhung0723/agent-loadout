import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
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
  /**
   * Claude only: the `.claude.json` holding this target's MCP servers. For a local project target
   * it is the one of its `profile` (servers go under `projects[<dir>]`).
   */
  claudeJson?: string;
  /** Set for a repository: `dir` is the project root and paths follow the project layout. */
  scope?: 'project';
  /** Project targets: `local` (default) writes only files kept out of git; `shared` the committed ones. */
  visibility?: 'local' | 'shared';
  /** Local Claude project targets: the user target whose `.claude.json` stores local MCP servers. */
  profile?: string;
}

export function isProject(target: Target): boolean {
  return target.scope === 'project';
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
  /** Folders a tool loads for every profile, regardless of CODEX_HOME / CLAUDE_CONFIG_DIR. */
  shared?: SharedLayers;
  backups?: Retention;
  /** File each resource is defined in (resourceId → path), when the manifest came from files. */
  origins?: Map<string, string>;
  /** Every manifest file read, root first (the root plus everything it includes). */
  files?: string[];
}

export interface ParseOptions {
  /** Path of `text`; relative `include`s resolve against its folder (default: cwd). */
  file?: string;
  /** Reads included files; tests and manifest edits substitute pending text through it. */
  read?: (file: string) => string;
}

/** A run is kept while it is among the newest `keep` runs or younger than `maxAgeDays`. */
export interface Retention {
  keep: number;
  maxAgeDays: number;
}

export const DEFAULT_RETENTION: Retention = { keep: 20, maxAgeDays: 30 };

export interface SharedLayers {
  codexSkills: string[];
}

export const DEFAULT_CODEX_SHARED_SKILLS = '~/.agents/skills';

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
  return parseManifest(text, home, { file });
}

interface ManifestDocument {
  file: string | undefined;
  root: Reader;
  /** Errors in included files name the file; the root keeps its plain messages. */
  label: string | undefined;
}

/**
 * Parses a manifest and everything it `include`s. Targets, sources and resources from all files
 * form one manifest (names must stay unique across files); `[shared]` / `[backups]` belong to
 * the root file only.
 */
export function parseManifest(text: string, home?: string, options: ParseOptions = {}): Manifest {
  const read = options.read ?? ((file: string) => readFileSync(file, 'utf8'));
  const documents = collectDocuments(text, options.file, home, read);

  const targets: Target[] = [];
  const sources = new Map<string, string>();
  for (const document of documents) {
    inFile(document.label, () => {
      for (const target of parseTargets(document.root.optTable('targets'), home)) {
        if (targets.some((known) => known.name === target.name)) {
          throw new ManifestError(`duplicate target: ${target.name}`);
        }
        targets.push(target);
      }
      const sourceTable = document.root.optTable('sources');
      for (const alias of Object.keys(sourceTable.raw)) {
        const dir = sourceTable.path(alias);
        if (sources.has(alias) && sources.get(alias) !== dir) {
          throw new ManifestError(`source "${alias}" is defined twice with different paths`);
        }
        sources.set(alias, dir);
      }
    });
  }

  linkProfiles(targets);

  const resources: Resource[] = [];
  const origins = new Map<string, string>();
  for (const document of documents) {
    inFile(document.label, () => {
      const own: Resource[] = [];
      for (const kind of KINDS) {
        for (const entry of document.root.tableArray(kind)) {
          const resource = withMode(parseResource(kind, entry, sources), entry);
          const id = resourceId(resource);
          if (resources.some((known) => resourceId(known) === id)) {
            const first = origins.get(id);
            throw new ManifestError(
              `duplicate resource: ${id}${first ? ` (also in ${first})` : ''}`,
            );
          }
          resources.push(resource);
          own.push(resource);
          if (document.file) origins.set(id, document.file);
        }
      }
      for (const resource of own)
        assertSelectorsResolve(resource.to, targets, resourceId(resource));
    });
  }

  const root = documents[0]!.root;
  const sharedTable = root.optTable('shared');
  const shared: SharedLayers = {
    codexSkills: (sharedTable.optStringArray('codex_skills') ?? [DEFAULT_CODEX_SHARED_SKILLS]).map(
      (dir) => expandHome(dir, home),
    ),
  };
  const backupTable = root.optTable('backups');
  const backups: Retention = {
    keep: count(backupTable.optNumber('keep'), 'backups.keep') ?? DEFAULT_RETENTION.keep,
    maxAgeDays:
      count(backupTable.optNumber('max_age_days'), 'backups.max_age_days') ??
      DEFAULT_RETENTION.maxAgeDays,
  };
  const files = documents.flatMap((document) => (document.file ? [document.file] : []));
  return { targets, resources, shared, backups, origins, files };
}

const ROOT_ONLY = ['shared', 'backups'] as const;

function collectDocuments(
  text: string,
  file: string | undefined,
  home: string | undefined,
  read: (file: string) => string,
): ManifestDocument[] {
  const documents: ManifestDocument[] = [];
  const loaded = new Set<string>();

  const visit = (text: string, file: string | undefined, chain: string[]) => {
    const label = chain.length > 0 ? file : undefined;
    const raw = inFile(label, () => {
      try {
        return parse(text);
      } catch (error) {
        throw new ManifestError(`invalid TOML: ${(error as Error).message}`);
      }
    });
    const root = new Reader(raw, '', home);
    if (file) loaded.add(file);
    documents.push({ file, root, label });

    const includes = inFile(label, () => {
      if (chain.length > 0) {
        for (const key of ROOT_ONLY) {
          if (root.has(key))
            throw new ManifestError(`[${key}] is only allowed in the root manifest`);
        }
      }
      return root.optStringArray('include') ?? [];
    });
    const base = file ? path.dirname(file) : process.cwd();
    for (const include of includes) {
      const target = include.startsWith('~')
        ? expandHome(include, home)
        : path.resolve(base, include);
      if (chain.includes(target) || target === file) {
        throw new ManifestError(`include cycle: ${[...chain, file, target].join(' → ')}`);
      }
      if (loaded.has(target)) continue;
      let included: string;
      try {
        included = read(target);
      } catch (error) {
        const reason =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'not found'
            : (error as Error).message;
        throw new ManifestError(
          `${file ?? '<manifest>'}: include "${include}": ${reason} (${target})`,
        );
      }
      visit(included, target, file ? [...chain, file] : chain);
    }
  };

  visit(text, file, []);
  return documents;
}

/** Prefixes errors from an included file with that file. */
function inFile<T>(label: string | undefined, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ManifestError && label && !error.message.startsWith(label)) {
      throw new ManifestError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

function count(value: number | undefined, where: string): number | undefined {
  if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
    throw new ManifestError(`${where} must be a whole number >= 0`);
  }
  return value;
}

function parseTargets(table: Reader, home?: string): Target[] {
  return Object.keys(table.raw).map((name) => {
    const entry = table.table(name);
    const tool = entry.string('tool');
    if (!(TOOLS as readonly string[]).includes(tool)) {
      throw new ManifestError(`${entry.where('tool')} must be one of: ${TOOLS.join(', ')}`);
    }
    const dir = expandHome(entry.string('dir'), home);
    const scope = entry.optString('scope') ?? 'user';
    if (scope !== 'user' && scope !== 'project') {
      throw new ManifestError(`${entry.where('scope')} must be "user" or "project"`);
    }
    const base = { name, tool: tool as Tool, dir, tags: entry.optStringArray('tags') ?? [] };

    if (scope === 'project') {
      const visibility = entry.optString('visibility') ?? 'local';
      if (visibility !== 'local' && visibility !== 'shared') {
        throw new ManifestError(`${entry.where('visibility')} must be "local" or "shared"`);
      }
      const profile = entry.optString('profile');
      if (profile !== undefined && (tool !== 'claude' || visibility !== 'local')) {
        throw new ManifestError(
          `${entry.where('profile')} only applies to local Claude project targets`,
        );
      }
      return { ...base, scope: 'project' as const, visibility, ...(profile ? { profile } : {}) };
    }
    for (const key of ['visibility', 'profile']) {
      if (entry.has(key)) throw new ManifestError(`${entry.where(key)} needs scope = "project"`);
    }
    return {
      ...base,
      ...(tool === 'claude'
        ? {
            claudeJson: entry.has('claude_json')
              ? entry.path('claude_json')
              : detectClaudeJson(dir, home),
          }
        : {}),
    };
  });
}

/** A local Claude project keeps its MCP servers in its profile's `.claude.json`. */
function linkProfiles(targets: Target[]): void {
  for (const target of targets) {
    if (!target.profile) continue;
    const profile = targets.find((candidate) => candidate.name === target.profile);
    if (!profile || isProject(profile) || profile.tool !== 'claude') {
      throw new ManifestError(
        `targets.${target.name}.profile: "${target.profile}" must name a user-scope Claude target`,
      );
    }
    target.claudeJson = profile.claudeJson;
  }
}

/**
 * Claude Code keeps `.claude.json` inside CLAUDE_CONFIG_DIR when that is set, and in the home
 * folder when it isn't. `~/.claude` is ambiguous, so prefer whichever file exists.
 */
export function detectClaudeJson(dir: string, home = os.homedir()): string {
  const inside = path.join(dir, '.claude.json');
  const atHome = path.join(home, '.claude.json');
  if (existsSync(inside)) return inside;
  if (dir === path.join(home, '.claude') && existsSync(atHome)) return atHome;
  return inside;
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
