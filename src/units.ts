import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderAgent } from './agent-render.ts';
import {
  configKey,
  ManifestError,
  resourceId,
  type Manifest,
  type Resource,
  type Target,
} from './manifest.ts';
import { exists } from './observe.ts';
import { selectTargets } from './selector.ts';
import type { Layout } from './layout.ts';
import { adapterOf, layoutOf, supports } from './tools/index.ts';
import { describeRef, findRefs, interpolate, type SecretResolver } from './secrets.ts';
import { treeHash } from './tree.ts';
import { fingerprintOf, sha256 } from './values.ts';

export type DriverName =
  'link' | 'copy' | 'file' | 'json-key' | 'json-item' | 'toml-table' | 'line';

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
  observe?: boolean;
}

export { supports } from './tools/index.ts';

export function unitKey(locator: Locator, resource: string): string {
  const base = `${locator.driver}:${locator.file}`;
  const withPointer = locator.pointer.length ? `${base}#${locator.pointer.join('/')}` : base;
  return locator.driver === 'json-item' ? `${withPointer}@${resource}` : withPointer;
}

/** Units several resources may need identically (one exclude line), owned by the first. */
const SHAREABLE_DRIVERS: ReadonlySet<DriverName> = new Set(['line']);

export function describeLocation(locator: Locator): string {
  return locator.pointer.length ? `${locator.file} ${locator.pointer.join('.')}` : locator.file;
}

const VALUE_DRIVERS: ReadonlySet<DriverName> = new Set(['json-key', 'json-item', 'toml-table']);

interface RawUnit extends Unit {
  /** Its file is committed to a repository: resolved secrets must not go in. */
  committed?: boolean;
}

export async function desiredUnits(manifest: Manifest, secrets: SecretResolver): Promise<Unit[]> {
  const byKey = new Map<string, Unit>();
  for (const resource of manifest.resources) {
    const targets = selectTargets(resource.to, manifest.targets).filter((target) =>
      supports(resource, target),
    );
    for (const target of targets) {
      for (const raw of await unitsFor(resource, target)) {
        const unit = await resolveSecrets(raw, secrets);
        const clash = byKey.get(unit.key);
        if (clash && SHAREABLE_DRIVERS.has(unit.driver) && clash.fingerprint === unit.fingerprint) {
          continue;
        }
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

async function resolveSecrets(raw: RawUnit, secrets: SecretResolver): Promise<Unit> {
  const { committed, ...unit } = raw;
  if (!VALUE_DRIVERS.has(unit.driver) || unit.problem) return unit;
  if (committed && findRefs(unit.value).length > 0) {
    return {
      ...unit,
      problem:
        'secrets would be written into a committed file; use "$${env:NAME}" so the tool expands ${NAME} itself',
    };
  }
  const { value, missing } = await interpolate(unit.value, secrets);
  if (missing.length > 0) {
    return { ...unit, problem: `unresolved secret ${missing.map(describeRef).join(', ')}` };
  }
  return { ...unit, value, fingerprint: fingerprintOf(value) };
}

async function unitsFor(resource: Resource, target: Target): Promise<RawUnit[]> {
  const id = resourceId(resource);
  const layout = layoutOf(target);
  const make = (
    locator: Locator,
    value: unknown,
    fingerprint: string,
    problem?: string,
  ): RawUnit => ({
    ...locator,
    key: unitKey(locator, id),
    resource: id,
    target: target.name,
    value,
    fingerprint,
    ...(problem ? { problem } : {}),
    ...(resource.mode === 'observe' ? { observe: true } : {}),
    ...(layout.committed ? { committed: true } : {}),
  });
  const valueUnit = (locator: Locator, value: unknown) =>
    make(locator, value, fingerprintOf(value));
  /** Keeps a file loadout puts in a repository out of `git status`. */
  const excluded = (file: string, units: RawUnit[]): RawUnit[] => {
    const relative = path.relative(target.dir, file);
    if (!layout.gitExclude || relative.startsWith('..') || path.isAbsolute(relative)) return units;
    const line = '/' + path.relative(target.dir, file).split(path.sep).join('/');
    return [
      ...units,
      make({ driver: 'line', file: layout.gitExclude, pointer: [line] }, line, sha256(line)),
    ];
  };

  switch (resource.kind) {
    case 'instructions':
    case 'skill':
    case 'command': {
      const dest = linkDestination(resource.kind, configKey(resource), layout);
      if (!(await exists(resource.source))) {
        return [make({ driver: 'link', file: dest, pointer: [] }, '', '', 'source does not exist')];
      }
      if (layout.copy) {
        const hash = await treeHash(resource.source, { follow: true });
        return [make({ driver: 'copy', file: dest, pointer: [] }, resource.source, hash)];
      }
      return excluded(dest, [
        make({ driver: 'link', file: dest, pointer: [] }, resource.source, resource.source),
      ]);
    }
    case 'agent': {
      const extension = adapterOf(target.tool).agent.extension;
      const locator: Locator = {
        driver: 'file',
        file: path.join(layout.agents!, `${configKey(resource)}.${extension}`),
        pointer: [],
      };
      try {
        const content = renderAgent(
          await readFile(resource.source, 'utf8'),
          configKey(resource),
          target.tool,
        );
        return excluded(locator.file, [make(locator, content, sha256(content))]);
      } catch (error) {
        const problem =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'source does not exist'
            : (error as Error).message;
        return [make(locator, '', '', problem)];
      }
    }
    case 'hook':
    case 'mcp':
    case 'plugin':
    case 'marketplace': {
      const placements = adapterOf(target.tool).place(resource.kind, resource, target);
      const units = placements.map(({ locator, value }) => valueUnit(locator, value));
      return [...new Set(placements.map(({ locator }) => locator.file))].reduce(
        (all, file) => excluded(file, all),
        units,
      );
    }
  }
}

function linkDestination(
  kind: 'instructions' | 'skill' | 'command',
  name: string,
  layout: Layout,
): string {
  switch (kind) {
    case 'instructions':
      return layout.instructions!;
    case 'skill':
      return path.join(layout.skills!, name);
    case 'command':
      return path.join(layout.commands!, `${name}.md`);
  }
}
