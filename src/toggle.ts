import type { ManifestChange } from './journal.ts';
import { planToEdit, writeChange } from './manifest-edit.ts';
import {
  loadManifest,
  ManifestError,
  resourceId,
  type Manifest,
  type Resource,
  type Target,
} from './manifest.ts';
import { selectTargets } from './selector.ts';
import { scanSharedCodexSkills } from './shared.ts';
import { sharedEntry } from './status.ts';
import { supports } from './units.ts';

export interface ToggleResult {
  resource: string;
  target: string;
  enabled: boolean;
  before: string[];
  after: string[];
  changed: boolean;
  /** Set when the target already gets the resource from a shared layer. */
  inheritedFrom?: string;
}

export async function toggleInManifest(
  file: string,
  request: { resource: string; target: string; enabled: boolean },
  home?: string,
): Promise<{ manifest: Manifest; result: ToggleResult; change?: ManifestChange }> {
  const manifest = await loadManifest(file, home);
  const resource = findResource(manifest, request.resource);
  const target = findTarget(manifest, request.target);

  if (!supports(resource.kind, target)) {
    throw new ManifestError(
      `${resourceId(resource)} has no place on ${target.name} (${describeTarget(target)})`,
    );
  }

  const shared = sharedEntry(resource, target, await scanSharedCodexSkills(manifest));
  const selected = selectTargets(resource.to, manifest.targets).some((t) => t.name === target.name);
  if (shared && !selected) {
    if (!request.enabled) {
      throw new ManifestError(
        `${resourceId(resource)} is loaded by every Codex profile from ${shared}; ` +
          `it can't be switched off for ${target.name} alone. Move it out of the shared folder ` +
          `and enable it per profile instead.`,
      );
    }
    const result: ToggleResult = {
      resource: resourceId(resource),
      target: target.name,
      enabled: true,
      before: resource.to,
      after: resource.to,
      changed: false,
      inheritedFrom: shared,
    };
    return { manifest, result };
  }

  const after = nextSelectors(resource.to, manifest.targets, target.name, request.enabled);
  const result: ToggleResult = {
    resource: resourceId(resource),
    target: target.name,
    enabled: request.enabled,
    before: resource.to,
    after,
    changed: after !== resource.to,
  };
  if (!result.changed) return { manifest, result };

  const edit = await planToEdit(file, manifest, resource, after, home);
  const reparsed = findResource(edit.manifest, resourceId(resource));
  if (isSelected(reparsed.to, manifest.targets, target.name) !== request.enabled) {
    throw new Error(
      `internal: rewritten manifest does not reflect the toggle for ${result.resource}`,
    );
  }
  await writeChange(edit.change);
  return { manifest: edit.manifest, result, change: edit.change };
}

export function nextSelectors(
  selectors: string[],
  targets: Target[],
  targetName: string,
  enabled: boolean,
): string[] {
  if (isSelected(selectors, targets, targetName) === enabled) return selectors;

  const direct = enabled ? `!${targetName}` : targetName;
  let next = selectors.filter((selector) => selector !== direct);
  if (isSelected(next, targets, targetName) !== enabled) {
    next = [...next, enabled ? targetName : `!${targetName}`];
  }
  if (isSelected(next, targets, targetName) !== enabled) {
    const blocking = next.filter((selector) => selector.startsWith('!'));
    throw new ManifestError(
      `cannot enable ${targetName}: excluded by ${blocking.join(', ')}; edit "to" by hand`,
    );
  }
  return next;
}

export function findResource(manifest: Manifest, query: string): Resource {
  const exact = manifest.resources.find((resource) => resourceId(resource) === query);
  if (exact) return exact;

  const byName = manifest.resources.filter((resource) => resource.name === query);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const ids = byName.map(resourceId).join(', ');
    throw new ManifestError(`"${query}" is ambiguous: ${ids}`);
  }
  throw new ManifestError(`unknown resource "${query}"`);
}

function describeTarget(target: Target): string {
  return target.scope === 'project'
    ? `${target.visibility} ${target.tool} project`
    : `${target.tool} profile`;
}

export function findTarget(manifest: Manifest, name: string): Target {
  const target = manifest.targets.find((candidate) => candidate.name === name);
  if (!target) {
    const known = manifest.targets.map((candidate) => candidate.name).join(', ');
    throw new ManifestError(`unknown target "${name}" (known: ${known})`);
  }
  return target;
}

export function isSelected(selectors: string[], targets: Target[], targetName: string): boolean {
  return selectTargets(selectors, targets).some((target) => target.name === targetName);
}

export { arrayIndexOf } from './manifest-edit.ts';
