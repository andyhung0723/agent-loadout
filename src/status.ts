import {
  configKey,
  resourceId,
  type Kind,
  type Manifest,
  type Resource,
  type Target,
  type Tool,
} from './manifest.ts';
import type { Action, Plan, PlanEntry } from './planner.ts';
import { selectTargets } from './selector.ts';
import type { SharedSkills } from './shared.ts';
import { supports } from './units.ts';

export type CellState =
  | 'ok'
  | 'pending'
  | 'conflict'
  | 'unresolved'
  | 'observed'
  | 'absent'
  | 'inherited'
  | 'off'
  | 'n/a';

export interface StatusRow {
  resource: string;
  kind: Kind;
  name: string;
  observe: boolean;
  cells: Record<string, CellState>;
}

export interface StatusTarget {
  name: string;
  tool: Tool;
  tags: string[];
  dir: string;
}

export interface StatusMatrix {
  targets: string[];
  targetDetails: StatusTarget[];
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
  'inherited',
  'absent',
  'observed',
  'ok',
  'pending',
  'unresolved',
  'conflict',
];

export function toStatusMatrix(
  manifest: Manifest,
  plan: Plan,
  sharedSkills: SharedSkills = new Map(),
): StatusMatrix {
  const warnings = [...plan.warnings];
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
        const shared = sharedEntry(resource, target, sharedSkills);
        if (!selected.has(target.name)) return [target.name, shared ? 'inherited' : 'off'];
        if (shared) {
          warnings.push(
            `${id} on ${target.name} is also in ${shared}; Codex loads that copy for every profile too`,
          );
        }
        return [target.name, cellOf.get(`${id}\0${target.name}`) ?? 'off'];
      }),
    );
    return {
      resource: id,
      kind: resource.kind,
      name: resource.name,
      observe: resource.mode === 'observe',
      cells,
    };
  });

  return {
    targets: manifest.targets.map((target) => target.name),
    targetDetails: manifest.targets.map(({ name, tool, tags, dir }) => ({ name, tool, tags, dir })),
    rows,
    orphans: plan.entries.filter((entry) => entry.action === 'remove' || entry.action === 'forget'),
    warnings: [...new Set(warnings)],
  };
}

export function sharedEntry(
  resource: Resource,
  target: Target,
  sharedSkills: SharedSkills,
): string | undefined {
  if (resource.kind !== 'skill' || target.tool !== 'codex') return undefined;
  return sharedSkills.get(configKey(resource));
}

function worst(current: CellState | undefined, next: CellState): CellState {
  if (current === undefined) return next;
  return SEVERITY.indexOf(next) > SEVERITY.indexOf(current) ? next : current;
}
