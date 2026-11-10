import { styleText } from 'node:util';
import type { ApplyResult } from './apply.ts';
import { collapseHome } from './paths.ts';
import { CHANGING_ACTIONS, type Action, type Plan, type PlanEntry } from './planner.ts';
import type { CellState, StatusMatrix } from './status.ts';

type Color = Parameters<typeof styleText>[0];

const ACTION_STYLE: Record<Action, { symbol: string; color: Color }> = {
  ok: { symbol: ' ', color: 'gray' },
  create: { symbol: '+', color: 'green' },
  replace: { symbol: '~', color: 'yellow' },
  adopt: { symbol: '=', color: 'cyan' },
  remove: { symbol: '-', color: 'red' },
  forget: { symbol: '?', color: 'gray' },
  conflict: { symbol: '!', color: 'red' },
  'missing-source': { symbol: '✗', color: 'red' },
};

const CELL_STYLE: Record<CellState, { glyph: string; color: Color }> = {
  ok: { glyph: '✓', color: 'green' },
  pending: { glyph: '+', color: 'yellow' },
  conflict: { glyph: '!', color: 'red' },
  'missing-source': { glyph: '✗', color: 'red' },
  off: { glyph: '·', color: 'gray' },
  'n/a': { glyph: '-', color: 'gray' },
};

export function renderPlan(plan: Plan): string {
  const visible = plan.entries.filter((entry) => entry.action !== 'ok');
  const body =
    visible.length === 0
      ? ['Nothing to do — all targets match the manifest.']
      : [...visible.map(renderEntry), '', summarize(plan.entries)];
  return [...body, ...renderWarnings(plan.warnings)].join('\n');
}

export function renderApply(results: ApplyResult[], warnings: string[]): string {
  return [renderApplyResults(results), ...renderWarnings(warnings)].join('\n');
}

function renderApplyResults(results: ApplyResult[]): string {
  const changed = results.filter(({ entry }) => CHANGING_ACTIONS.has(entry.action));
  const failed = results.filter((result) => result.error);
  const blocked = results.filter(
    ({ entry }) => !CHANGING_ACTIONS.has(entry.action) && entry.action !== 'ok',
  );

  if (changed.length === 0 && blocked.length === 0) {
    return 'Nothing to do — all targets match the manifest.';
  }
  const lines = [
    ...changed.map((result) =>
      result.error
        ? `${renderEntry(result.entry)}  ${styleText('red', `FAILED: ${result.error}`)}`
        : renderEntry(result.entry),
    ),
    ...blocked.map((result) => renderEntry(result.entry)),
    '',
    `Applied ${changed.length - failed.length}, failed ${failed.length}, skipped ${blocked.length}.`,
  ];
  return lines.join('\n');
}

export function renderStatus(matrix: StatusMatrix): string {
  const resourceWidth = Math.max(8, ...matrix.rows.map((row) => row.resource.length));
  const header = ['resource'.padEnd(resourceWidth), ...matrix.targets].join('  ');
  const rows = matrix.rows.map((row) =>
    [
      row.resource.padEnd(resourceWidth),
      ...matrix.targets.map((target) => {
        const { glyph, color } = CELL_STYLE[row.cells[target] ?? 'off'];
        return styleText(color, glyph) + ' '.repeat(target.length - 1);
      }),
    ].join('  '),
  );
  const legend = styleText(
    'gray',
    '✓ in place  + pending apply  ! conflict  ✗ missing source  · off  - unsupported',
  );
  const orphans = matrix.orphans.map(renderEntry);
  return [
    header,
    ...rows,
    '',
    legend,
    ...(orphans.length ? ['', 'Orphans:', ...orphans] : []),
    ...renderWarnings(matrix.warnings),
  ].join('\n');
}

function renderEntry(entry: PlanEntry): string {
  const { symbol, color } = ACTION_STYLE[entry.action];
  const head = styleText(color, `${symbol} ${entry.action.padEnd(14)}`);
  const detail = entry.detail ? styleText('gray', `  (${entry.detail})`) : '';
  return `${head} ${entry.resource} → ${entry.target}  ${styleText('gray', collapseHome(entry.location))}${detail}`;
}

function summarize(plan: PlanEntry[]): string {
  const counts = new Map<Action, number>();
  for (const entry of plan) counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  return [...counts]
    .filter(([action]) => action !== 'ok')
    .map(([action, count]) => `${count} ${action}`)
    .join(', ');
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) return [];
  return ['', ...warnings.map((warning) => styleText('yellow', `⚠ ${warning}`))];
}
