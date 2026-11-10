import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Manifest } from './manifest.ts';

/** Skill name → the shared folder entry every Codex profile loads it from. */
export type SharedSkills = Map<string, string>;

export async function scanSharedCodexSkills(manifest: Manifest): Promise<SharedSkills> {
  const found: SharedSkills = new Map();
  for (const dir of manifest.shared?.codexSkills ?? []) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => !entry.startsWith('.')).sort()) {
      if (!found.has(name)) found.set(name, path.join(dir, name));
    }
  }
  return found;
}
