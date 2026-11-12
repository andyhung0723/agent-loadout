import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Retention } from './manifest.ts';

/** `2026-11-12T02-48-56.410Z`, optionally `-2` when two runs started in the same millisecond. */
const RUN_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?)Z(?:-\d+)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrunedRun {
  id: string;
  ageDays: number;
}

export function runStartedAt(id: string): Date | null {
  const match = RUN_ID.exec(id);
  if (!match) return null;
  const [, date, hours, minutes, seconds] = match;
  const at = new Date(`${date}T${hours}:${minutes}:${seconds}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Runs (journal + full-file backups, possibly holding resolved secrets) beyond the policy.
 * Only folders named like a run id are considered; anything else in the folder is never touched.
 */
export async function planPrune(
  backupsRoot: string,
  policy: Retention,
  now = new Date(),
): Promise<PrunedRun[]> {
  let names: string[];
  try {
    names = await readdir(backupsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs = names
    .map((id) => ({ id, at: runStartedAt(id) }))
    .filter((run): run is { id: string; at: Date } => run.at !== null)
    .sort((a, b) => b.id.localeCompare(a.id));

  return runs.flatMap(({ id, at }, index) => {
    const ageDays = (now.getTime() - at.getTime()) / DAY_MS;
    return index >= policy.keep && ageDays > policy.maxAgeDays
      ? [{ id, ageDays: Math.floor(ageDays) }]
      : [];
  });
}

export async function prune(backupsRoot: string, runs: PrunedRun[]): Promise<void> {
  for (const { id } of runs) {
    if (runStartedAt(id) === null) throw new Error(`internal: refusing to delete ${id}`);
    await rm(path.join(backupsRoot, id), { recursive: true, force: true });
  }
}
