import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { writeAtomic } from './documents.ts';
import type { ManifestChange } from './journal.ts';
import { parseManifest, resourceId, type Manifest, type Resource } from './manifest.ts';
import { replaceKeyInArrayTable, tomlValue } from './toml-text.ts';

/** The file a resource is defined in: an included file, or the root manifest. */
export function fileOf(manifest: Manifest, manifestPath: string, resource: Resource): string {
  return manifest.origins?.get(resourceId(resource)) ?? manifestPath;
}

/**
 * Rewrites only the `to` line of `resource` in the file that defines it, then validates the
 * whole manifest (root + includes) as it would read after the edit. Nothing is written yet.
 */
export async function planToEdit(
  manifestPath: string,
  manifest: Manifest,
  resource: Resource,
  to: string[],
  home?: string,
): Promise<{ manifest: Manifest; change: ManifestChange }> {
  const file = fileOf(manifest, manifestPath, resource);
  const before = await readFile(file, 'utf8');
  const after = replaceKeyInArrayTable(
    before,
    resource.kind,
    arrayIndexOf(before, resource),
    'to',
    tomlValue(to),
  );
  return {
    manifest: await reparse(manifestPath, { [file]: after }, home),
    change: { path: file, before, after },
  };
}

/** Parses the manifest with some files replaced by pending text. */
export async function reparse(
  manifestPath: string,
  pending: Record<string, string>,
  home?: string,
): Promise<Manifest> {
  const read = (file: string) => pending[file] ?? readFileSync(file, 'utf8');
  return parseManifest(read(manifestPath), home, { file: manifestPath, read });
}

export async function writeChange(change: ManifestChange): Promise<void> {
  if ((await readFile(change.path, 'utf8')) !== change.before) {
    throw new Error(`${change.path} changed while editing — try again`);
  }
  await writeAtomic(change.path, change.after);
}

export function arrayIndexOf(text: string, resource: Resource): number {
  const entries = parse(text)[resource.kind];
  const index = Array.isArray(entries)
    ? entries.findIndex((entry) => (entry as { name?: unknown }).name === resource.name)
    : -1;
  if (index < 0) throw new Error(`internal: [[${resource.kind}]] "${resource.name}" not found`);
  return index;
}
