import { ManifestError, type Target } from './manifest.ts';

const EXCLUDE_PREFIX = '!';

export function selectTargets(selectors: string[], targets: Target[]): Target[] {
  const includes = selectors.filter((selector) => !selector.startsWith(EXCLUDE_PREFIX));
  const excludes = selectors
    .filter((selector) => selector.startsWith(EXCLUDE_PREFIX))
    .map((selector) => selector.slice(EXCLUDE_PREFIX.length));

  return targets.filter(
    (target) =>
      includes.some((selector) => matches(selector, target)) &&
      !excludes.some((selector) => matches(selector, target)),
  );
}

export function assertSelectorsResolve(
  selectors: string[],
  targets: Target[],
  owner: string,
): void {
  const targetNames = new Set(targets.map((target) => target.name));
  for (const raw of selectors) {
    const selector = raw.startsWith(EXCLUDE_PREFIX) ? raw.slice(EXCLUDE_PREFIX.length) : raw;
    if (isPatternSelector(selector)) continue;
    if (!targetNames.has(selector)) {
      throw new ManifestError(`${owner}: unknown target "${selector}"`);
    }
  }
}

export function compressSelectors(selected: Target[], all: Target[]): string[] {
  const selectedNames = new Set(selected.map((target) => target.name));
  if (all.every((target) => selectedNames.has(target.name))) return ['*'];

  const tools = new Set(all.map((target) => target.tool));
  for (const tool of tools) {
    const ofTool = all.filter((target) => target.tool === tool);
    const exact =
      ofTool.length === selected.length && ofTool.every((target) => selectedNames.has(target.name));
    if (exact) return [`tool:${tool}`];
  }
  return selected.map((target) => target.name);
}

function isPatternSelector(selector: string): boolean {
  return selector === '*' || selector.startsWith('tag:') || selector.startsWith('tool:');
}

function matches(selector: string, target: Target): boolean {
  if (selector === '*') return true;
  if (selector.startsWith('tag:')) return target.tags.includes(selector.slice('tag:'.length));
  if (selector.startsWith('tool:')) return target.tool === selector.slice('tool:'.length);
  return target.name === selector;
}
