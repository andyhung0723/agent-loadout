import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator } from './units.ts';

export interface OwnedUnit extends Locator {
  resource: string;
  target: string;
  fingerprint: string;
}

export interface State {
  version: 2;
  units: Record<string, OwnedUnit>;
}

interface StateV1 {
  version: 1;
  links: Record<string, { resource: string; target: string; source: string }>;
}

export function emptyState(): State {
  return { version: 2, units: {} };
}

export async function loadState(file: string): Promise<State> {
  let parsed: State | StateV1;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  switch (parsed.version) {
    case 2:
      return parsed;
    case 1:
      return migrateFromV1(parsed);
    default:
      throw new Error(`unsupported state version in ${file}`);
  }
}

export async function saveState(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n');
  await rename(temp, file);
}

function migrateFromV1(state: StateV1): State {
  const units = Object.fromEntries(
    Object.entries(state.links).map(([dest, link]) => [
      `link:${dest}`,
      {
        driver: 'link' as const,
        file: dest,
        pointer: [],
        resource: link.resource,
        target: link.target,
        fingerprint: link.source,
      },
    ]),
  );
  return { version: 2, units };
}
