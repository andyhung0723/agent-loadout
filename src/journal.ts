import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot } from './drivers.ts';
import type { Action } from './planner.ts';
import type { OwnedUnit } from './state.ts';
import type { Locator } from './units.ts';

const JOURNAL = 'journal.json';

export interface JournalEntry {
  key: string;
  action: Action | 'restore';
  resource: string;
  target: string;
  locator: Locator;
  /** Present when the entry changed disk; absent for ownership-only changes (adopt, forget). */
  change?: { before: Snapshot; after: Snapshot };
  /** Ownership record before this run (null: not owned). */
  ownedBefore: OwnedUnit | null;
  ownedAfter: OwnedUnit | null;
}

export interface ManifestChange {
  path: string;
  before: string;
  after: string;
}

export interface Journal {
  version: 1;
  command: string;
  at: string;
  entries: JournalEntry[];
  manifest?: ManifestChange;
}

export interface RunSummary {
  id: string;
  command: string;
  at: string;
  changes: number;
}

/**
 * Journals hold before/after values, which may include resolved secrets, so they live in the
 * 0700 backups folder with mode 0600, like the full-file backups next to them.
 */
export async function writeJournal(runDir: string, journal: Journal): Promise<void> {
  await mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, JOURNAL);
  await writeFile(file, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function loadJournal(backupsRoot: string, id: string): Promise<Journal> {
  const runs = await listRuns(backupsRoot);
  const run = id === 'latest' ? runs[0] : runs.find((candidate) => candidate.id === id);
  if (!run) throw new JournalError(`no run "${id}" in ${backupsRoot} (see "loadout history")`);
  return JSON.parse(await readFile(path.join(backupsRoot, run.id, JOURNAL), 'utf8'));
}

export async function listRuns(backupsRoot: string): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = await readdir(backupsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs: RunSummary[] = [];
  for (const id of names.sort().reverse()) {
    try {
      const journal: Journal = JSON.parse(
        await readFile(path.join(backupsRoot, id, JOURNAL), 'utf8'),
      );
      runs.push({ id, command: journal.command, at: journal.at, changes: journal.entries.length });
    } catch {
      // Runs from before journals existed only hold full-file backups.
    }
  }
  return runs;
}

export class JournalError extends Error {}
