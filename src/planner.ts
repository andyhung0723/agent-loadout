import { linkDestination } from './adapters.ts';
import { ManifestError, resourceId, type Manifest } from './manifest.ts';
import { exists, observe } from './observe.ts';
import { samePath } from './paths.ts';
import { selectTargets } from './selector.ts';
import type { State } from './state.ts';

export type Action =
  'ok' | 'create' | 'replace' | 'adopt' | 'remove' | 'forget' | 'conflict' | 'missing-source';

export interface PlanEntry {
  action: Action;
  resource: string;
  target: string;
  dest: string;
  source: string;
  detail?: string;
}

interface DesiredLink {
  resource: string;
  target: string;
  dest: string;
  source: string;
}

export const CHANGING_ACTIONS: ReadonlySet<Action> = new Set([
  'create',
  'replace',
  'adopt',
  'remove',
  'forget',
]);

export const BLOCKED_ACTIONS: ReadonlySet<Action> = new Set(['conflict', 'missing-source']);

export async function buildPlan(manifest: Manifest, state: State): Promise<PlanEntry[]> {
  const desired = desiredLinks(manifest);
  const desiredDests = new Set(desired.map((link) => link.dest));

  const forDesired = await Promise.all(desired.map((link) => planDesired(link, state)));
  const forOrphans = await Promise.all(
    Object.entries(state.links)
      .filter(([dest]) => !desiredDests.has(dest))
      .map(([dest, owned]) => planOrphan({ dest, ...owned })),
  );
  return [...forDesired, ...forOrphans];
}

function desiredLinks(manifest: Manifest): DesiredLink[] {
  const byDest = new Map<string, DesiredLink>();
  for (const resource of manifest.resources) {
    for (const target of selectTargets(resource.to, manifest.targets)) {
      const link = {
        resource: resourceId(resource),
        target: target.name,
        dest: linkDestination(resource.kind, resource.name, target),
        source: resource.source,
      };
      const clash = byDest.get(link.dest);
      if (clash) {
        throw new ManifestError(
          `${link.resource} and ${clash.resource} both claim ${link.dest} on target ${target.name}`,
        );
      }
      byDest.set(link.dest, link);
    }
  }
  return [...byDest.values()];
}

async function planDesired(link: DesiredLink, state: State): Promise<PlanEntry> {
  if (!(await exists(link.source))) {
    return { action: 'missing-source', ...link };
  }

  const observed = await observe(link.dest);
  const owned = link.dest in state.links;

  switch (observed.type) {
    case 'missing':
      return { action: 'create', ...link };
    case 'other':
      return { action: 'conflict', ...link, detail: 'exists and is not a symlink' };
    case 'link':
      if (await samePath(observed.to, link.source)) {
        return { action: owned ? 'ok' : 'adopt', ...link };
      }
      return owned
        ? { action: 'replace', ...link, detail: `was → ${observed.to}` }
        : { action: 'conflict', ...link, detail: `unmanaged symlink → ${observed.to}` };
  }
}

async function planOrphan(link: DesiredLink): Promise<PlanEntry> {
  const observed = await observe(link.dest);
  if (observed.type === 'link' && (await samePath(observed.to, link.source))) {
    return { action: 'remove', ...link };
  }
  const detail =
    observed.type === 'missing' ? 'already gone' : 'changed outside loadout, left as is';
  return { action: 'forget', ...link, detail };
}
