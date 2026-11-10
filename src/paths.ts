import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MANIFEST_PATH = '~/.config/agent-loadout/loadout.toml';
export const DEFAULT_STATE_PATH = '~/.local/state/agent-loadout/state.json';

export function expandHome(input: string, home = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return path.resolve(input);
}

export function collapseHome(input: string, home = os.homedir()): string {
  if (input === home) return '~';
  if (input.startsWith(home + path.sep)) return '~' + input.slice(home.length);
  return input;
}

export async function samePath(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  const [realA, realB] = await Promise.all([realpathOrNull(a), realpathOrNull(b)]);
  return realA !== null && realA === realB;
}

async function realpathOrNull(input: string): Promise<string | null> {
  try {
    return await realpath(input);
  } catch {
    return null;
  }
}
