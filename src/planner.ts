import { DRIVERS, type DriverContext, type PlanContext } from './drivers.ts';
import { isProject, type Manifest } from './manifest.ts';
import type { OwnedUnit, State } from './state.ts';
import { configFiles, describeLocation, desiredUnits, type Unit } from './units.ts';

export type Action =
  | 'ok'
  | 'create'
  | 'replace'
  | 'adopt'
  | 'remove'
  | 'forget'
  | 'conflict'
  | 'unresolved'
  | 'observe';

export interface PlanEntry {
  key: string;
  action: Action;
  resource: string;
  target: string;
  location: string;
  detail?: string;
  observation?: Observation;
}

export type Observation = 'match' | 'differs' | 'absent';

export interface Plan {
  entries: PlanEntry[];
  warnings: string[];
  desired: Map<string, Unit>;
  owned: Record<string, OwnedUnit>;
}

export const CHANGING_ACTIONS: ReadonlySet<Action> = new Set([
  'create',
  'replace',
  'adopt',
  'remove',
  'forget',
]);

export const BLOCKED_ACTIONS: ReadonlySet<Action> = new Set(['conflict', 'unresolved']);

export async function buildPlan(
  manifest: Manifest,
  state: State,
  context: PlanContext,
): Promise<Plan> {
  const units = await desiredUnits(manifest, context.secrets);
  const desired = new Map(units.map((unit) => [unit.key, unit]));
  const entries: PlanEntry[] = [];

  for (const unit of units) {
    entries.push(await planDesired(unit, state.units[unit.key], context));
  }
  for (const [key, owned] of Object.entries(state.units)) {
    if (!desired.has(key)) entries.push(await planOrphan(key, owned, context));
  }

  return {
    entries,
    warnings: await collectWarnings(manifest, units, entries, context),
    desired,
    owned: state.units,
  };
}

async function planDesired(
  unit: Unit,
  owned: OwnedUnit | undefined,
  context: DriverContext,
): Promise<PlanEntry> {
  const entry = (action: Action, detail?: string): PlanEntry => ({
    key: unit.key,
    action,
    resource: unit.resource,
    target: unit.target,
    location: describeLocation(unit),
    ...(detail ? { detail } : {}),
  });

  if (unit.observe) return observeEntry(unit, context, entry);
  if (unit.problem) return entry('unresolved', unit.problem);

  const observed = await DRIVERS[unit.driver].inspect(
    unit,
    { desired: unit.fingerprint, recorded: owned?.fingerprint },
    context,
  );
  switch (observed.state) {
    case 'missing':
      return entry('create');
    case 'desired':
      return entry(owned ? 'ok' : 'adopt');
    case 'recorded':
      return entry('replace');
    case 'other':
      return entry(
        'conflict',
        owned ? `modified outside loadout: ${observed.detail}` : `unmanaged: ${observed.detail}`,
      );
  }
}

const OBSERVATION_DETAIL: Record<Observation, string> = {
  match: 'present, matches manifest',
  differs: 'present, differs from manifest',
  absent: 'not present',
};

async function observeEntry(
  unit: Unit,
  context: DriverContext,
  entry: (action: Action, detail?: string) => PlanEntry,
): Promise<PlanEntry> {
  const observed = await DRIVERS[unit.driver].inspect(unit, { desired: unit.fingerprint }, context);
  const observation: Observation =
    observed.state === 'missing' ? 'absent' : observed.state === 'desired' ? 'match' : 'differs';
  return { ...entry('observe', OBSERVATION_DETAIL[observation]), observation };
}

async function planOrphan(
  key: string,
  owned: OwnedUnit,
  context: DriverContext,
): Promise<PlanEntry> {
  const observed = await DRIVERS[owned.driver].inspect(
    owned,
    { recorded: owned.fingerprint },
    context,
  );
  const base = {
    key,
    resource: owned.resource,
    target: owned.target,
    location: describeLocation(owned),
  };
  if (observed.state === 'recorded') return { ...base, action: 'remove' };
  const detail =
    observed.state === 'missing' ? 'already gone' : 'changed outside loadout, left as is';
  return { ...base, action: 'forget', detail };
}

async function collectWarnings(
  manifest: Manifest,
  units: Unit[],
  entries: PlanEntry[],
  context: DriverContext,
): Promise<string[]> {
  const warnings: string[] = [];
  const codexTargets = manifest.targets.filter(
    (target) => target.tool === 'codex' && !isProject(target),
  );

  for (const target of codexTargets) {
    const hooksFile = configFiles.codexHooks(target);
    const hookUnits = units.filter((unit) => unit.file === hooksFile);
    if (hookUnits.length === 0) continue;

    const config = configFiles.codexConfig(target);
    const enabled = await context.documents.tomlGet(config, ['features', 'hooks']);
    if (enabled !== true) {
      warnings.push(
        `${target.name}: hooks are ignored until ${config} has [features] hooks = true`,
      );
    }

    const created = entries.some(
      (entry) =>
        entry.target === target.name &&
        (entry.action === 'create' || entry.action === 'replace') &&
        hookUnits.some((unit) => unit.key === entry.key),
    );
    if (created) {
      warnings.push(
        `${target.name}: Codex will ask you to trust new or changed hooks on next start`,
      );
    }
  }
  return warnings;
}
