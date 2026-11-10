import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './documents.ts';
import {
  ManifestError,
  parseManifest,
  resourceId,
  type Manifest,
  type Target,
} from './manifest.ts';
import { observe } from './observe.ts';
import { expandHome } from './paths.ts';
import type { State } from './state.ts';
import { arrayIndexOf, nextSelectors } from './toggle.ts';
import { replaceKeyInArrayTable, tomlValue } from './toml-text.ts';
import { configFiles, unitKey } from './units.ts';

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
  const manifestText = await readFile(options.manifestPath, 'utf8');
  const manifest = parseManifest(manifestText, options.home);
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
  const manifestText = await readFile(options.manifestPath, 'utf8');
  const nextText = rewriteManifest(manifestText, plan, options);
  parseManifest(nextText, options.home);

  await relocate(plan, options.backupDir);
  try {
    await symlink(plan.source, plan.original);
  } catch (error) {
    if (plan.mode === 'move') await rename(plan.source, plan.original);
    throw error;
  }

  if ((await readFile(options.manifestPath, 'utf8')) !== manifestText) {
    throw new Error(
      `${options.manifestPath} changed during adopt — the link is in place, re-run to record it`,
    );
  }
  await writeAtomic(options.manifestPath, nextText);

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
    if (parent === configFiles.skills(target)) return { kind: 'skill', target };
    if (parent === configFiles.commands(target) && target.tool === 'claude') {
      return { kind: 'command', target };
    }
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

function rewriteManifest(text: string, plan: AdoptPlan, options: AdoptOptions): string {
  switch (plan.manifestChange) {
    case 'none':
      return text;
    case 'extend-to': {
      const manifest = parseManifest(text, options.home);
      const resource = manifest.resources.find(
        (r) => r.kind === plan.kind && r.name === plan.name,
      )!;
      const to = nextSelectors(resource.to, manifest.targets, plan.target, true);
      return replaceKeyInArrayTable(
        text,
        plan.kind,
        arrayIndexOf(text, resource),
        'to',
        tomlValue(to),
      );
    }
    case 'append': {
      const entry = [
        `[[${plan.kind}]]`,
        `name = ${tomlValue(plan.name)}`,
        `path = ${tomlValue(collapse(plan.source, options.home))}`,
        `to = ${tomlValue([plan.target])}`,
      ].join('\n');
      return `${text.replace(/\n*$/, '')}\n\n${entry}\n`;
    }
  }
}

function collapse(file: string, home?: string): string {
  if (!home) return file;
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  const stats = await lstat(root);
  if (stats.isFile()) return hash.update(await readFile(root)).digest('hex');

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await walk(full, relative);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\n`).update(await readFile(full));
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${relative}->${await readlink(full)}\n`);
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}
