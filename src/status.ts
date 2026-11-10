import { resourceId, type Manifest } from './manifest.ts';
import type { Action, Plan, PlanEntry } from './planner.ts';
import { selectTargets } from './selector.ts';
import { supports } from './units.ts';

export type CellState =
  'ok' | 'pending' | 'conflict' | 'unresolved' | 'observed' | 'absent' | 'off' | 'n/a';

export interface StatusRow {
  resource: string;
  cells: Record<string, CellState>;
}

export interface StatusMatrix {
  targets: string[];
  rows: StatusRow[];
  orphans: PlanEntry[];
  warnings: string[];
}

const CELL_FOR_ACTION: Partial<Record<Action, CellState>> = {
  ok: 'ok',
  create: 'pending',
  replace: 'pending',
  adopt: 'pending',
  conflict: 'conflict',
  unresolved: 'unresolved',
};

const SEVERITY: CellState[] = [
  'n/a',
  'off',
  'absent',
  'observed',
  'ok',
  'pending',
  'unresolved',
  'conflict',
];

export function toStatusMatrix(manifest: Manifest, plan: Plan): StatusMatrix {
  const cellOf = new Map<string, CellState>();
  for (const entry of plan.entries) {
    const cell =
      entry.action === 'observe'
        ? entry.observation === 'absent'
          ? 'absent'
          : 'observed'
        : CELL_FOR_ACTION[entry.action];
    if (!cell) continue;
    const key = `${entry.resource}\0${entry.target}`;
    cellOf.set(key, worst(cellOf.get(key), cell));
  }

  const rows = manifest.resources.map((resource) => {
    const id = resourceId(resource);
    const selected = new Set(selectTargets(resource.to, manifest.targets).map((t) => t.name));
    const cells: Record<string, CellState> = Object.fromEntries(
      manifest.targets.map((target): [string, CellState] => {
        if (!supports(resource.kind, target.tool)) return [target.name, 'n/a'];
        if (!selected.has(target.name)) return [target.name, 'off'];
        return [target.name, cellOf.get(`${id}\0${target.name}`) ?? 'off'];
      }),
    );
    return { resource: id, cells };
  });

  return {
    targets: manifest.targets.map((target) => target.name),
    rows,
    orphans: plan.entries.filter((entry) => entry.action === 'remove' || entry.action === 'forget'),
    warnings: plan.warnings,
  };
}

function worst(current: CellState | undefined, next: CellState): CellState {
  if (current === undefined) return next;
  return SEVERITY.indexOf(next) > SEVERITY.indexOf(current) ? next : current;
}
