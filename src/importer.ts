import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  KINDS,
  resourceId,
  SOURCE_FILE_NAME,
  TOOLS,
  type Kind,
  type Overrides,
  type Resource,
  type Target,
  type Tool,
} from './manifest.ts';
import { observe } from './observe.ts';
import { collapseHome } from './paths.ts';
import { scanResource } from './secret-scan.ts';
import { compressSelectors } from './selector.ts';
import { tomlKey, tomlValue } from './toml-text.ts';
import { adapterOf, layoutOf } from './tools/index.ts';
import type { Note } from './import-common.ts';
import { stableStringify, type Plain } from './values.ts';

const PROFILE_DIR = new RegExp(`^\\.(${TOOLS.join('|')})(?:-([\\w-]+))?$`);

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Definition = DistributiveOmit<Resource, 'to'>;

export interface Unmanaged {
  target: string;
  kind: Kind;
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
          ...adapterOf(tool as Tool).detectProfile?.(path.join(home, entry.name), home),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function importFromTargets(targets: Target[], home: string): Promise<ImportResult> {
  const groups = new Map<string, Group[]>();
  const unmanaged: Unmanaged[] = [];

  for (const target of targets) {
    const scan = await scanTarget(target, home);
    unmanaged.push(...scan.unmanaged);
    for (const definition of scan.definitions) addToGroup(groups, definition, target);
  }

  const resources = disambiguateNames(
    [...groups.values()].flat().map(({ definition, targets: selected }) => ({
      resource: { ...definition, to: compressSelectors(selected, targets) } as Resource,
      targets: selected,
    })),
  ).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));

  return { targets, resources, unmanaged };
}

interface Group {
  definition: Definition;
  targets: Target[];
}

/**
 * Same base definition → same resource, even when each tool needs its own overrides
 * (e.g. Claude's explicit `type = "stdio"`). Only conflicting overrides for one tool split it.
 */
function addToGroup(groups: Map<string, Group[]>, definition: Definition, target: Target): void {
  const overrides = 'overrides' in definition ? definition.overrides : {};
  const own = overrides[target.tool];
  const baseKey = stableStringify({ ...definition, overrides: undefined });
  const candidates = groups.get(baseKey) ?? [];

  const compatible = candidates.find((group) => {
    const usesTool = group.targets.some((member) => member.tool === target.tool);
    const theirs =
      'overrides' in group.definition ? group.definition.overrides[target.tool] : undefined;
    return !usesTool || stableStringify(theirs) === stableStringify(own);
  });

  if (!compatible) {
    groups.set(baseKey, [...candidates, { definition, targets: [target] }]);
    return;
  }
  compatible.targets.push(target);
  if (own && 'overrides' in compatible.definition) {
    compatible.definition = {
      ...compatible.definition,
      overrides: { ...compatible.definition.overrides, [target.tool]: own },
    };
  }
}

export async function scanTarget(
  target: Target,
  home: string,
): Promise<{ definitions: Definition[]; unmanaged: Unmanaged[] }> {
  const definitions: Definition[] = [];
  const unmanaged: Unmanaged[] = [];
  const note: Note = (kind, location, hint) =>
    unmanaged.push({
      target: target.name,
      kind,
      location: collapseHome(location, home),
      ...(hint ? { hint } : {}),
    });

  const layout = layoutOf(target);
  if (layout.instructions) {
    const instructions = await observe(layout.instructions);
    if (instructions.type === 'link') {
      definitions.push({ kind: 'instructions', name: 'shared', source: instructions.to });
    } else if (instructions.type === 'other') {
      note('instructions', layout.instructions, 'a real file, not a symlink');
    }
  }

  for (const entry of layout.skills ? await scanDir(layout.skills) : []) {
    if (entry.source) definitions.push({ kind: 'skill', name: entry.name, source: entry.source });
    else note('skill', entry.path, 'a real directory, not a symlink (see `loadout adopt`)');
  }

  for (const entry of layout.commands ? await scanDir(layout.commands) : []) {
    const name = entry.name.replace(/\.md$/, '');
    if (entry.source) definitions.push({ kind: 'command', name, source: entry.source });
    else note('command', entry.path, 'a real file, not a symlink (see `loadout adopt`)');
  }

  for (const entry of layout.agents ? await scanDir(layout.agents) : []) {
    note('agent', entry.path, 'hand-written; convert with `loadout agent extract`');
  }

  definitions.push(...(await adapterOf(target.tool).importSettings(target, home, note)));

  return { definitions, unmanaged };
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
      ...(target.claudeJson ? [`claude_json = ${show(target.claudeJson)}`] : []),
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
          '# ⚠ may contain a secret (not converted) — use "${keychain:service}" / "${env:NAME}" if it is one',
        ]
      : []),
    `[[${resource.kind}]]`,
    `name = ${tomlValue(resource.name)}`,
    ...(resource.key ? [`key = ${tomlValue(resource.key)}`] : []),
    ...(resource.mode
      ? [`mode = ${tomlValue(resource.mode)}  # managed by the app itself; loadout only reports it`]
      : []),
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

function looksSecret(resource: Resource): boolean {
  return scanResource(resource).length > 0;
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
