import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { expandHome } from './paths.ts';
import { assertSelectorsResolve } from './selector.ts';

export const TOOLS = ['claude', 'codex'] as const;
export type Tool = (typeof TOOLS)[number];

export type LinkKind = 'skill' | 'instructions';

export interface Target {
  name: string;
  tool: Tool;
  dir: string;
  tags: string[];
}

export interface LinkResource {
  kind: LinkKind;
  name: string;
  source: string;
  to: string[];
}

export interface Manifest {
  targets: Target[];
  resources: LinkResource[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

type Table = Record<string, unknown>;

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
  let raw: Table;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ManifestError(`invalid TOML: ${(error as Error).message}`);
  }

  const targets = parseTargets(raw.targets, home);
  const sources = parseSources(raw.sources, home);
  const resources = [
    ...tableArray(raw.skill, 'skill').map((entry, index) =>
      parseSkill(entry, `skill[${index}]`, sources, home),
    ),
    ...tableArray(raw.instructions, 'instructions').map((entry, index) =>
      parseInstructions(entry, `instructions[${index}]`, home),
    ),
  ];

  assertUniqueResources(resources);
  for (const resource of resources) {
    assertSelectorsResolve(resource.to, targets, resourceId(resource));
  }
  return { targets, resources };
}

export function resourceId(resource: Pick<LinkResource, 'kind' | 'name'>): string {
  return `${resource.kind}:${resource.name}`;
}

function parseTargets(value: unknown, home?: string): Target[] {
  return Object.entries(optionalTable(value, 'targets')).map(([name, entry]) => {
    const where = `targets.${name}`;
    const table = requireTable(entry, where);
    const tool = requireString(table.tool, `${where}.tool`);
    if (!isTool(tool)) {
      throw new ManifestError(`${where}.tool must be one of: ${TOOLS.join(', ')}`);
    }
    return {
      name,
      tool,
      dir: expandHome(requireString(table.dir, `${where}.dir`), home),
      tags: optionalStringArray(table.tags, `${where}.tags`),
    };
  });
}

function parseSources(value: unknown, home?: string): Map<string, string> {
  const entries = Object.entries(optionalTable(value, 'sources')).map(
    ([alias, dir]) => [alias, expandHome(requireString(dir, `sources.${alias}`), home)] as const,
  );
  return new Map(entries);
}

function parseSkill(
  entry: Table,
  where: string,
  sources: Map<string, string>,
  home?: string,
): LinkResource {
  const name = requireString(entry.name, `${where}.name`);
  return {
    kind: 'skill',
    name,
    source: resolveSkillSource(entry, where, name, sources, home),
    to: requireStringArray(entry.to, `${where}.to`),
  };
}

function resolveSkillSource(
  entry: Table,
  where: string,
  name: string,
  sources: Map<string, string>,
  home?: string,
): string {
  if (entry.path !== undefined) {
    return expandHome(requireString(entry.path, `${where}.path`), home);
  }
  if (entry.from === undefined) {
    throw new ManifestError(`${where}: needs either "from" (source alias) or "path"`);
  }
  const alias = requireString(entry.from, `${where}.from`);
  const root = sources.get(alias);
  if (root === undefined) {
    throw new ManifestError(`${where}.from: unknown source "${alias}"`);
  }
  return path.join(root, name);
}

function parseInstructions(entry: Table, where: string, home?: string): LinkResource {
  return {
    kind: 'instructions',
    name: entry.name === undefined ? 'default' : requireString(entry.name, `${where}.name`),
    source: expandHome(requireString(entry.path, `${where}.path`), home),
    to: requireStringArray(entry.to, `${where}.to`),
  };
}

function assertUniqueResources(resources: LinkResource[]): void {
  const seen = new Set<string>();
  for (const resource of resources) {
    const id = resourceId(resource);
    if (seen.has(id)) throw new ManifestError(`duplicate resource: ${id}`);
    seen.add(id);
  }
}

function isTool(value: string): value is Tool {
  return (TOOLS as readonly string[]).includes(value);
}

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalTable(value: unknown, where: string): Table {
  return value === undefined ? {} : requireTable(value, where);
}

function requireTable(value: unknown, where: string): Table {
  if (!isTable(value)) throw new ManifestError(`${where} must be a table`);
  return value;
}

function tableArray(value: unknown, where: string): Table[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable)) {
    throw new ManifestError(`${where} must be an array of tables ([[${where}]])`);
  }
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, where: string): string[] {
  const strings = optionalStringArray(value, where);
  if (strings.length === 0) throw new ManifestError(`${where} must not be empty`);
  return strings;
}

function optionalStringArray(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ManifestError(`${where} must be an array of strings`);
  }
  return value;
}
