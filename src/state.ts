import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DriverName, Locator } from './units.ts';
import { sha256 } from './values.ts';

export interface OwnedUnit extends Locator {
  resource: string;
  target: string;
  fingerprint: string;
}

export interface State {
  version: 3;
  units: Record<string, OwnedUnit>;
}

interface StateV2 {
  version: 2;
  units: Record<string, OwnedUnit>;
}

interface StateV1 {
  version: 1;
  links: Record<string, { resource: string; target: string; source: string }>;
}

const PLAINTEXT_FINGERPRINT_DRIVERS: ReadonlySet<DriverName> = new Set([
  'json-key',
  'json-item',
  'toml-table',
]);

export function emptyState(): State {
  return { version: 3, units: {} };
}

export async function loadState(file: string): Promise<State> {
  let parsed: State | StateV2 | StateV1;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  switch (parsed.version) {
    case 3:
      return parsed;
    case 2:
      return migrateFromV2(parsed);
    case 1:
      return migrateFromV2(migrateFromV1(parsed));
    default:
      throw new Error(`unsupported state version in ${file}`);
  }
}

export async function saveState(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

function migrateFromV2(state: StateV2): State {
  const units = Object.fromEntries(
    Object.entries(state.units).map(([key, unit]) => [
      key,
      PLAINTEXT_FINGERPRINT_DRIVERS.has(unit.driver)
        ? { ...unit, fingerprint: sha256(unit.fingerprint) }
        : unit,
    ]),
  );
  return { version: 3, units };
}

function migrateFromV1(state: StateV1): StateV2 {
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
