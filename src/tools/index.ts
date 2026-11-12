import type { Layout } from '../layout.ts';
import type { Kind, Target, Tool } from '../manifest.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import type { ToolAdapter, ValueKind } from './types.ts';

export type { Placement, ToolAdapter, ValueKind } from './types.ts';

/** Every tool loadout can manage. `Record<Tool, …>` makes a missing adapter a type error. */
export const ADAPTERS: Record<Tool, ToolAdapter> = { claude, codex };

export function adapterOf(tool: Tool): ToolAdapter {
  return ADAPTERS[tool];
}

export function layoutOf(target: Target): Layout {
  return adapterOf(target.tool).layout(target);
}

const VALUE_KINDS: ReadonlySet<Kind> = new Set<ValueKind>(['hook', 'mcp', 'plugin', 'marketplace']);

export function isValueKind(kind: Kind): kind is ValueKind {
  return VALUE_KINDS.has(kind);
}

/** Whether this target has a place for the kind; unsupported cells show "n/a". */
export function supports(kind: Kind, target: Target): boolean {
  if (isValueKind(kind)) return adapterOf(target.tool).holds(kind, target);
  const layout = layoutOf(target);
  switch (kind) {
    case 'instructions':
      return layout.instructions !== undefined;
    case 'skill':
      return layout.skills !== undefined;
    case 'command':
      return layout.commands !== undefined;
    case 'agent':
      return layout.agents !== undefined;
  }
}
