import { readFile } from 'node:fs/promises';
import { writeAtomic } from './documents.ts';
import { DRIVERS, type DriverContext } from './drivers.ts';
import type { Journal, JournalEntry } from './journal.ts';
import { filterOnly } from './only.ts';
import type { State } from './state.ts';
import { fingerprintOf, stableStringify } from './values.ts';

export interface RestoreResult {
  key: string;
  resource: string;
  target: string;
  /** What restoring does on disk: `undo <action>` or `ownership only`. */
  effect: string;
  error?: string;
}

export interface RestoreOutcome {
  results: RestoreResult[];
  state: State;
  journal: JournalEntry[];
  /**
   * none: the run didn't edit the manifest · restored · restorable: would be (dry run, or held
   * back by --only) · unchanged: already the old text · diverged: edited since, left alone.
   */
  manifest: 'none' | 'restored' | 'restorable' | 'unchanged' | 'diverged';
}

/**
 * Undo a journaled run, newest change first. An entry is restored only while its location still
 * holds what the run wrote; anything changed since is reported and left alone, like a conflict.
 */
export async function restoreRun(
  journal: Journal,
  state: State,
  context: DriverContext,
  options: { only?: string[]; dryRun: boolean },
): Promise<RestoreOutcome> {
  const selected = filterOnly(journal.entries, options.only).reverse();
  const results: RestoreResult[] = [];
  const applied: JournalEntry[] = [];

  for (const entry of selected) {
    const result: RestoreResult = {
      key: entry.key,
      resource: entry.resource,
      target: entry.target,
      effect: entry.change ? `undo ${entry.action}` : 'ownership only',
    };
    results.push(result);
    if (!entry.change) {
      applied.push(entry);
      continue;
    }
    try {
      const driver = DRIVERS[entry.locator.driver];
      const { before, after } = entry.change;
      const current = await driver.capture(entry.locator, fingerprintFor(after.value), context);
      if (stableStringify(current.value) !== stableStringify(after.value)) {
        throw new Error('changed since that run, left as is');
      }
      if (!options.dryRun) await driver.revert(entry.locator, after, before, context);
      applied.push(entry);
    } catch (error) {
      result.error = (error as Error).message;
    }
  }

  if (options.dryRun) {
    return { results, state, journal: [], manifest: await restoreManifest(journal, false) };
  }

  const failedFiles = await context.documents.flush(context.backup);
  const units = { ...state.units };
  const undone: JournalEntry[] = [];
  for (const entry of applied) {
    const failure = failedFiles.get(entry.locator.file);
    if (failure) {
      results.find((result) => result.key === entry.key)!.error = failure;
      continue;
    }
    if (entry.ownedBefore) units[entry.key] = entry.ownedBefore;
    else delete units[entry.key];
    undone.push({
      ...entry,
      action: 'restore',
      ...(entry.change
        ? { change: { before: entry.change.after, after: entry.change.before } }
        : {}),
      ownedBefore: entry.ownedAfter,
      ownedAfter: entry.ownedBefore,
    });
  }

  const write = options.only === undefined && (undone.length > 0 || journal.entries.length === 0);
  return {
    results,
    state: { ...state, units },
    journal: undone,
    manifest: await restoreManifest(journal, write),
  };
}

/** json-item looks its item up by fingerprint; the others ignore it. */
function fingerprintFor(value: unknown): string | undefined {
  return value === undefined ? undefined : fingerprintOf(value);
}

/**
 * A toggle run also edited the manifest. Put the old text back only when the file is still what
 * the toggle wrote, so later hand edits are never lost.
 */
async function restoreManifest(
  journal: Journal,
  write: boolean,
): Promise<RestoreOutcome['manifest']> {
  if (!journal.manifest) return 'none';
  const { path, before, after } = journal.manifest;
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === before) return 'unchanged';
  if (current !== after) return 'diverged';
  if (!write) return 'restorable';
  await writeAtomic(path, before);
  return 'restored';
}
