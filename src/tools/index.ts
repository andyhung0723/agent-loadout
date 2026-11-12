import type { Layout } from '../layout.ts';
import type { Kind, Resource, Target, Tool } from '../manifest.ts';
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

function isValueResource(resource: Resource): resource is Resource & { kind: ValueKind } {
  return isValueKind(resource.kind);
}

/** Whether this target has a place for the resource; unsupported cells show "n/a". */
export function supports(resource: Resource, target: Target): boolean {
  if (isValueResource(resource)) return adapterOf(target.tool).holds(resource, target);
  const layout = layoutOf(target);
  switch (resource.kind) {
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
