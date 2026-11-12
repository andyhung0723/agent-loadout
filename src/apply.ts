import { DRIVERS, type DriverContext, type Snapshot } from './drivers.ts';
import type { JournalEntry } from './journal.ts';
import type { Plan, PlanEntry } from './planner.ts';
import type { State } from './state.ts';

export interface ApplyResult {
  entry: PlanEntry;
  error?: string;
}

/** Kept out of ApplyResult: snapshots can hold resolved secrets and results are printed. */
type Change = { before: Snapshot; after: Snapshot };

export async function applyPlan(
  plan: Plan,
  state: State,
  context: DriverContext,
): Promise<{ state: State; results: ApplyResult[]; journal: JournalEntry[] }> {
  const results: ApplyResult[] = [];
  const changes = new Map<string, Change>();
  for (const entry of plan.entries) {
    try {
      const change = await execute(plan, entry, context);
      if (change) changes.set(entry.key, change);
      results.push({ entry });
    } catch (error) {
      results.push({ entry, error: (error as Error).message });
    }
  }

  const failedFiles = await context.documents.flush(context.backup);
  for (const result of results) {
    const file = fileOf(plan, result.entry.key);
    const failure = file === undefined ? undefined : failedFiles.get(file);
    if (failure && !result.error) result.error = failure;
  }

  const units = { ...state.units };
  const journal: JournalEntry[] = [];
  for (const { entry, error } of results) {
    if (error) continue;
    const change = changes.get(entry.key);
    const ownedBefore = units[entry.key] ?? null;
    recordOwnership(plan, entry, units);
    const ownedAfter = units[entry.key] ?? null;
    if (!change && JSON.stringify(ownedBefore) === JSON.stringify(ownedAfter)) continue;
    const { driver, file, pointer } = plan.desired.get(entry.key) ?? plan.owned[entry.key]!;
    journal.push({
      key: entry.key,
      action: entry.action,
      resource: entry.resource,
      target: entry.target,
      locator: { driver, file, pointer },
      ...(change ? { change } : {}),
      ownedBefore,
      ownedAfter,
    });
  }
  return { state: { ...state, units }, results, journal };
}

async function execute(
  plan: Plan,
  entry: PlanEntry,
  context: DriverContext,
): Promise<Change | undefined> {
  switch (entry.action) {
    case 'create':
    case 'replace': {
      const unit = plan.desired.get(entry.key)!;
      const driver = DRIVERS[unit.driver];
      const recorded = plan.owned[entry.key]?.fingerprint;
      const before = await driver.capture(unit, recorded, context);
      await driver.put(unit, recorded, context);
      return { before, after: await driver.capture(unit, unit.fingerprint, context) };
    }
    case 'remove': {
      const owned = plan.owned[entry.key]!;
      const driver = DRIVERS[owned.driver];
      const before = await driver.capture(owned, owned.fingerprint, context);
      await driver.remove(owned, owned.fingerprint, context);
      return { before, after: {} };
    }
    case 'ok':
    case 'adopt':
    case 'forget':
    case 'conflict':
    case 'unresolved':
    case 'observe':
      return undefined;
  }
}

function recordOwnership(plan: Plan, entry: PlanEntry, units: State['units']): void {
  switch (entry.action) {
    case 'create':
    case 'replace':
    case 'adopt':
    case 'ok': {
      const { driver, file, pointer, resource, target, fingerprint } = plan.desired.get(entry.key)!;
      units[entry.key] = { driver, file, pointer, resource, target, fingerprint };
      return;
    }
    case 'remove':
    case 'forget':
    case 'observe':
      delete units[entry.key];
      return;
    case 'conflict':
    case 'unresolved':
      return;
  }
}

function fileOf(plan: Plan, key: string): string | undefined {
  return plan.desired.get(key)?.file ?? plan.owned[key]?.file;
}
