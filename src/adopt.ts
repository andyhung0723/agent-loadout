import { cp, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './documents.ts';
import type { ManifestChange } from './journal.ts';
import { planToEdit, reparse } from './manifest-edit.ts';
import { loadManifest, ManifestError, resourceId, type Manifest, type Target } from './manifest.ts';
import { observe } from './observe.ts';
import { expandHome } from './paths.ts';
import type { State } from './state.ts';
import { nextSelectors } from './toggle.ts';
import { tomlValue } from './toml-text.ts';
import { treeHash } from './tree.ts';
import { layoutOf } from './tools/index.ts';
import { unitKey } from './units.ts';

type AdoptableKind = 'skill' | 'command';

export interface AdoptPlan {
  kind: AdoptableKind;
  name: string;
  target: string;
  original: string;
  source: string;
  mode: 'move' | 'link-to-identical';
  manifestChange: 'append' | 'extend-to' | 'none';
}

export interface AdoptOptions {
  manifestPath: string;
  into: string;
  backupDir: string;
  home?: string;
}

/** Works out what adopting `input` would do, without touching anything. */
export async function planAdopt(input: string, options: AdoptOptions): Promise<AdoptPlan> {
  const manifest = await loadManifest(options.manifestPath, options.home);
  const original = expandHome(input, options.home);
  const { kind, target } = locate(original, manifest);

  if ((await observe(original)).type !== 'other') {
    throw new ManifestError(`${original} is not a real ${kind === 'skill' ? 'directory' : 'file'}`);
  }

  const fileName = path.basename(original);
  const name = kind === 'command' ? fileName.replace(/\.md$/, '') : fileName;
  const source = path.join(expandHome(options.into, options.home), fileName);

  let mode: AdoptPlan['mode'] = 'move';
  if ((await observe(source)).type !== 'missing') {
    if ((await treeHash(source)) !== (await treeHash(original))) {
      throw new ManifestError(`${source} already exists with different content`);
    }
    mode = 'link-to-identical';
  }

  const existing = manifest.resources.find((r) => r.kind === kind && r.name === name);
  let manifestChange: AdoptPlan['manifestChange'] = 'append';
  if (existing) {
    if (!('source' in existing) || existing.source !== source) {
      throw new ManifestError(`${resourceId(existing)} already exists with another source`);
    }
    manifestChange = existing.to.includes(target.name) ? 'none' : 'extend-to';
  }

  return { kind, name, target: target.name, original, source, mode, manifestChange };
}

/** Moves the real entry into the source folder, links it back, and records it in manifest + state. */
export async function applyAdopt(
  plan: AdoptPlan,
  options: AdoptOptions,
  state: State,
): Promise<State> {
  const change = await manifestChangeFor(plan, options);

  await relocate(plan, options.backupDir);
  try {
    await symlink(plan.source, plan.original);
  } catch (error) {
    if (plan.mode === 'move') await rename(plan.source, plan.original);
    throw error;
  }

  if (change) {
    if ((await readFile(change.path, 'utf8')) !== change.before) {
      throw new Error(
        `${change.path} changed during adopt — the link is in place, re-run to record it`,
      );
    }
    await writeAtomic(change.path, change.after);
  }

  const resource = `${plan.kind}:${plan.name}`;
  const locator = { driver: 'link' as const, file: plan.original, pointer: [] };
  return {
    ...state,
    units: {
      ...state.units,
      [unitKey(locator, resource)]: {
        ...locator,
        resource,
        target: plan.target,
        fingerprint: plan.source,
      },
    },
  };
}

function locate(original: string, manifest: Manifest): { kind: AdoptableKind; target: Target } {
  const parent = path.dirname(original);
  for (const target of manifest.targets) {
    const layout = layoutOf(target);
    if (layout.copy) continue; // committed copies stay real files
    if (parent === layout.skills) return { kind: 'skill', target };
    if (parent === layout.commands) return { kind: 'command', target };
  }
  throw new ManifestError(`${original} is not inside a target's skills/ or commands/ folder`);
}

async function relocate(plan: AdoptPlan, backupDir: string): Promise<void> {
  if (plan.mode === 'link-to-identical') {
    const parked = path.join(backupDir, plan.target, path.basename(plan.original));
    await mkdir(path.dirname(parked), { recursive: true });
    await move(plan.original, parked);
    return;
  }
  await mkdir(path.dirname(plan.source), { recursive: true });
  await move(plan.original, plan.source);
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(from, { recursive: true });
  }
}

/** New entries go to the root manifest; extending `to` edits the file that defines the entry. */
async function manifestChangeFor(
  plan: AdoptPlan,
  options: AdoptOptions,
): Promise<ManifestChange | null> {
  switch (plan.manifestChange) {
    case 'none':
      return null;
    case 'extend-to': {
      const manifest = await loadManifest(options.manifestPath, options.home);
      const resource = manifest.resources.find(
        (r) => r.kind === plan.kind && r.name === plan.name,
      )!;
      const to = nextSelectors(resource.to, manifest.targets, plan.target, true);
      return (await planToEdit(options.manifestPath, manifest, resource, to, options.home)).change;
    }
    case 'append': {
      const before = await readFile(options.manifestPath, 'utf8');
      const entry = [
        `[[${plan.kind}]]`,
        `name = ${tomlValue(plan.name)}`,
        `path = ${tomlValue(collapse(plan.source, options.home))}`,
        `to = ${tomlValue([plan.target])}`,
      ].join('\n');
      const after = `${before.replace(/\n*$/, '')}\n\n${entry}\n`;
      await reparse(options.manifestPath, { [options.manifestPath]: after }, options.home);
      return { path: options.manifestPath, before, after };
    }
  }
}

function collapse(file: string, home?: string): string {
  if (!home) return file;
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}
