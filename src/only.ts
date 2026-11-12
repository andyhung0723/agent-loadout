/**
 * `--only` selectors: `<resource>[@<target>]`, where `<resource>` is `kind:name`, a bare name,
 * `kind:*` or `*`. Several selectors are OR'ed.
 */
const SELECTOR = /^([^@]+)(?:@([^@]+))?$/;

export class OnlyError extends Error {}

export function matchesOnly(
  item: { resource: string; target: string },
  selectors: readonly string[] | undefined,
): boolean {
  if (!selectors || selectors.length === 0) return true;
  return selectors.some((selector) => matches(item, selector));
}

/** Keep the items any selector matches; a selector that matches nothing is a usage error. */
export function filterOnly<T extends { resource: string; target: string }>(
  items: T[],
  selectors: readonly string[] | undefined,
): T[] {
  if (!selectors || selectors.length === 0) return items;
  const unmatched = selectors.filter((selector) => !items.some((item) => matches(item, selector)));
  if (unmatched.length > 0) {
    throw new OnlyError(`--only matches nothing: ${unmatched.join(', ')}`);
  }
  return items.filter((item) => matchesOnly(item, selectors));
}

function matches({ resource, target }: { resource: string; target: string }, selector: string) {
  const parsed = SELECTOR.exec(selector);
  if (!parsed) throw new OnlyError(`invalid --only "${selector}" (expected <resource>[@<target>])`);
  const [, pattern, wantedTarget] = parsed;
  if (wantedTarget !== undefined && wantedTarget !== target) return false;

  const [kind, name] = splitId(resource);
  if (pattern === '*' || pattern === resource) return true;
  if (pattern!.endsWith(':*')) return pattern!.slice(0, -2) === kind;
  return !pattern!.includes(':') && pattern === name;
}

function splitId(resource: string): [string, string] {
  const colon = resource.indexOf(':');
  return [resource.slice(0, colon), resource.slice(colon + 1)];
}
