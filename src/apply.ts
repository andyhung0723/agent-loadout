import { DRIVERS, type DriverContext } from './drivers.ts';
import type { Plan, PlanEntry } from './planner.ts';
import type { State } from './state.ts';

export interface ApplyResult {
  entry: PlanEntry;
  error?: string;
}

export async function applyPlan(
  plan: Plan,
  state: State,
  context: DriverContext,
): Promise<{ state: State; results: ApplyResult[] }> {
  const results: ApplyResult[] = [];
  for (const entry of plan.entries) {
    try {
      await execute(plan, entry, context);
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
  for (const { entry, error } of results) {
    if (!error) recordOwnership(plan, entry, units);
  }
  return { state: { ...state, units }, results };
}

async function execute(plan: Plan, entry: PlanEntry, context: DriverContext): Promise<void> {
  switch (entry.action) {
    case 'create':
    case 'replace': {
      const unit = plan.desired.get(entry.key)!;
      await DRIVERS[unit.driver].put(unit, plan.owned[entry.key]?.fingerprint, context);
      return;
    }
    case 'remove': {
      const owned = plan.owned[entry.key]!;
      await DRIVERS[owned.driver].remove(owned, owned.fingerprint, context);
      return;
    }
    case 'ok':
    case 'adopt':
    case 'forget':
    case 'conflict':
    case 'unresolved':
    case 'observe':
      return;
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
