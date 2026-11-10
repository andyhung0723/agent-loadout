import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { writeAtomic } from './documents.ts';
import {
  ManifestError,
  parseManifest,
  resourceId,
  type Manifest,
  type Resource,
  type Target,
} from './manifest.ts';
import { selectTargets } from './selector.ts';
import { replaceKeyInArrayTable, tomlValue } from './toml-text.ts';
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
): Promise<{ manifest: Manifest; result: ToggleResult }> {
  const text = await readFile(file, 'utf8');
  const manifest = parseManifest(text, home);
  const resource = findResource(manifest, request.resource);
  const target = findTarget(manifest, request.target);

  if (!supports(resource.kind, target.tool)) {
    throw new ManifestError(`${resourceId(resource)} is not supported on ${target.tool} targets`);
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

  const index = arrayIndexOf(text, resource);
  const nextText = replaceKeyInArrayTable(text, resource.kind, index, 'to', tomlValue(after));
  const nextManifest = parseManifest(nextText, home);
  const reparsed = findResource(nextManifest, resourceId(resource));
  if (isSelected(reparsed.to, manifest.targets, target.name) !== request.enabled) {
    throw new Error(
      `internal: rewritten manifest does not reflect the toggle for ${result.resource}`,
    );
  }

  if ((await readFile(file, 'utf8')) !== text) {
    throw new Error(`${file} changed while toggling — try again`);
  }
  await writeAtomic(file, nextText);
  return { manifest: nextManifest, result };
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

function findTarget(manifest: Manifest, name: string): Target {
  const target = manifest.targets.find((candidate) => candidate.name === name);
  if (!target) {
    const known = manifest.targets.map((candidate) => candidate.name).join(', ');
    throw new ManifestError(`unknown target "${name}" (known: ${known})`);
  }
  return target;
}

function isSelected(selectors: string[], targets: Target[], targetName: string): boolean {
  return selectTargets(selectors, targets).some((target) => target.name === targetName);
}

export function arrayIndexOf(text: string, resource: Resource): number {
  const entries = parse(text)[resource.kind];
  const index = Array.isArray(entries)
    ? entries.findIndex((entry) => (entry as { name?: unknown }).name === resource.name)
    : -1;
  if (index < 0) throw new Error(`internal: [[${resource.kind}]] "${resource.name}" not found`);
  return index;
}
