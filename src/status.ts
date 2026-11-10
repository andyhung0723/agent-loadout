import { resourceId, type Manifest } from './manifest.ts';
import type { Action, PlanEntry } from './planner.ts';

export type CellState = 'ok' | 'pending' | 'conflict' | 'missing-source' | 'off';

export interface StatusRow {
  resource: string;
  cells: Record<string, CellState>;
}

export interface StatusMatrix {
  targets: string[];
  rows: StatusRow[];
  orphans: PlanEntry[];
}

const CELL_FOR_ACTION: Partial<Record<Action, CellState>> = {
  ok: 'ok',
  create: 'pending',
  replace: 'pending',
  adopt: 'pending',
  conflict: 'conflict',
  'missing-source': 'missing-source',
};

export function toStatusMatrix(manifest: Manifest, plan: PlanEntry[]): StatusMatrix {
  const targets = manifest.targets.map((target) => target.name);
  const cellOf = new Map<string, CellState>();
  for (const entry of plan) {
    const cell = CELL_FOR_ACTION[entry.action];
    if (cell) cellOf.set(`${entry.resource}\0${entry.target}`, cell);
  }

  const rows = manifest.resources.map((resource) => {
    const id = resourceId(resource);
    const cells = Object.fromEntries(
      targets.map((target) => [target, cellOf.get(`${id}\0${target}`) ?? 'off']),
    );
    return { resource: id, cells };
  });

  const orphans = plan.filter((entry) => entry.action === 'remove' || entry.action === 'forget');
  return { targets, rows, orphans };
}
