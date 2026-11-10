import { mkdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PlanEntry } from './planner.ts';
import type { State } from './state.ts';

export interface ApplyResult {
  entry: PlanEntry;
  error?: string;
}

export async function applyPlan(
  plan: PlanEntry[],
  state: State,
): Promise<{ state: State; results: ApplyResult[] }> {
  const links = { ...state.links };
  const results: ApplyResult[] = [];

  for (const entry of plan) {
    try {
      await execute(entry);
      recordOwnership(links, entry);
      results.push({ entry });
    } catch (error) {
      results.push({ entry, error: (error as Error).message });
    }
  }
  return { state: { ...state, links }, results };
}

async function execute(entry: PlanEntry): Promise<void> {
  switch (entry.action) {
    case 'create':
      await mkdir(path.dirname(entry.dest), { recursive: true });
      await symlink(entry.source, entry.dest);
      return;
    case 'replace':
      await unlink(entry.dest);
      await symlink(entry.source, entry.dest);
      return;
    case 'remove':
      await unlink(entry.dest);
      return;
    case 'ok':
    case 'adopt':
    case 'forget':
    case 'conflict':
    case 'missing-source':
      return;
  }
}

function recordOwnership(links: State['links'], entry: PlanEntry): void {
  switch (entry.action) {
    case 'create':
    case 'replace':
    case 'adopt':
    case 'ok':
      links[entry.dest] = { resource: entry.resource, target: entry.target, source: entry.source };
      return;
    case 'remove':
    case 'forget':
      delete links[entry.dest];
      return;
    case 'conflict':
    case 'missing-source':
      return;
  }
}
