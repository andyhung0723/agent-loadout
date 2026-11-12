// Import helpers shared by the tool adapters (src/tools/*): each adapter reads its own config
// files and turns entries into manifest definitions with these.
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readOrNull } from './documents.ts';
import type { Definition } from './importer.ts';
import type { HookSpec, Kind, McpServer, Overrides } from './manifest.ts';
import { collapseHome } from './paths.ts';
import { isPlainObject, stableStringify, withoutUndefined, type Plain } from './values.ts';

/** Records something found in a target that loadout can't import as it is. */
export type Note = (kind: Kind, location: string, hint?: string) => void;

const HOOK_KEYS = ['type', 'command', 'timeout'];
const HOOK_GROUP_KEYS = ['matcher', 'hooks'];
const APP_BUNDLE_PATH = /\/Applications\/|\.app\//;

export function importHooks(value: unknown, file: string, home: string, note: Note): Definition[] {
  if (!isPlainObject(value)) return [];
  const bySpec = new Map<string, { spec: HookSpec; events: string[] }>();

  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const spec = hookSpecOf(group, home);
      if (!spec) {
        note(
          'hook',
          `${file} hooks.${event}[${index}]`,
          'only single-command hook groups are importable',
        );
        return;
      }
      const key = stableStringify(spec);
      const entry = bySpec.get(key) ?? { spec, events: [] };
      entry.events.push(event);
      bySpec.set(key, entry);
    });
  }

  return [...bySpec.values()].map(({ spec, events }) => ({
    kind: 'hook',
    name: hookName(spec.command),
    events: events.sort(),
    spec,
    overrides: {},
  }));
}

function hookSpecOf(group: unknown, home: string): HookSpec | null {
  if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.length !== 1) {
    return null;
  }
  const [hook] = group.hooks;
  if (!isPlainObject(hook) || hook.type !== 'command' || typeof hook.command !== 'string') {
    return null;
  }
  const hasUnknownKeys =
    Object.keys(hook).some((key) => !HOOK_KEYS.includes(key)) ||
    Object.keys(group).some((key) => !HOOK_GROUP_KEYS.includes(key));
  if (hasUnknownKeys) return null;

  return withoutUndefined({
    matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
    command: collapseLeadingHome(hook.command, home),
    timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined,
  });
}

function hookName(command: string): string {
  const tokens = command.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ''));
  const script = tokens.find((token) => token.includes('/')) ?? tokens[0] ?? 'hook';
  return path.basename(script).replace(/\.[^.]+$/, '') || 'hook';
}

export function mcpServer(raw: Plain, home: string): McpServer {
  return withoutUndefined({
    command: typeof raw.command === 'string' ? collapseLeadingHome(raw.command, home) : undefined,
    args: raw.args as string[] | undefined,
    env: raw.env as Record<string, string> | undefined,
    url: raw.url as string | undefined,
    headers: raw.headers as Record<string, string> | undefined,
  });
}

export function mcpDefinition(name: string, server: McpServer, overrides: Overrides): Definition {
  const nonEmpty = Object.fromEntries(
    Object.entries(overrides).filter(([, table]) => table && Object.keys(table).length > 0),
  );
  return { kind: 'mcp', name, server, overrides: nonEmpty };
}

export function isAppManaged(server: Plain): boolean {
  return APP_BUNDLE_PATH.test(stableStringify({ command: server.command, env: server.env }));
}

export async function readJson(file: string): Promise<Plain> {
  const text = await readOrNull(file);
  if (!text?.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  return isPlainObject(parsed) ? parsed : {};
}

export async function readToml(file: string): Promise<Plain> {
  const text = await readOrNull(file);
  return text ? parseToml(text) : {};
}

export function collapseLeadingHome(command: string, home: string): string {
  const [head = '', ...rest] = command.split(' ');
  return [collapseHome(head, home), ...rest].join(' ');
}
