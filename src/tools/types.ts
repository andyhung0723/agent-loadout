import type { AgentSource } from '../agent-render.ts';
import type { DriverContext } from '../drivers.ts';
import type { Note } from '../import-common.ts';
import type { Definition } from '../importer.ts';
import type { Layout } from '../layout.ts';
import type { Resource, Target, Tool } from '../manifest.ts';
import type { PlanEntry } from '../planner.ts';
import type { Locator, Unit } from '../units.ts';
import type { Plain } from '../values.ts';

/** Kinds written as values into a tool's config files rather than as files of their own. */
export type ValueKind = 'hook' | 'mcp' | 'plugin' | 'marketplace';

export interface Placement {
  locator: Locator;
  value: unknown;
}

/**
 * Everything loadout knows about one tool. Adding a tool means adding its name to `TOOLS` and an
 * adapter to `src/tools/index.ts`; nothing else branches on the tool name.
 */
export interface ToolAdapter {
  readonly name: Tool;
  /** Name in messages, e.g. "Claude". */
  readonly displayName: string;
  /** Extra fields for a profile folder found by `import` (e.g. where its state file lives). */
  detectProfile?(dir: string, home: string): Partial<Target>;
  /** Paths for instructions, skills, commands and agents on this target. */
  layout(target: Target): Layout;
  /**
   * Whether this target has a place for a value resource (unsupported cells show "n/a"). Takes the
   * resource, not just its kind: a marketplace is written in one tool's own format.
   */
  holds(resource: Resource & { kind: ValueKind }, target: Target): boolean;
  /** Where and in what shape a value resource is written; only called when `holds` is true. */
  place(kind: ValueKind, resource: Resource, target: Target): Placement[];
  readonly agent: {
    /** File extension of a rendered agent, e.g. "md". */
    extension: string;
    render(agent: AgentSource): string;
    /** The reverse, for `agent extract`: tool-specific fields (shared keys included) and body. */
    parse(text: string): { fields: Plain; body?: string };
  };
  /** Import hooks, MCP servers, plugins … from a profile folder's own config files. */
  importSettings(target: Target, home: string, note: Note): Promise<Definition[]>;
  /** Plan-time warnings about this tool's config (e.g. a feature flag the plan depends on). */
  warnings?(
    target: Target,
    units: Unit[],
    entries: PlanEntry[],
    context: DriverContext,
  ): Promise<string[]>;
  /** The tool also loads skills from a folder every profile shares (Codex `~/.agents/skills`). */
  readonly sharesSkillsAcrossProfiles?: boolean;
}
