import { mkdir, readFile, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic, type Backup, type Documents } from './documents.ts';
import { observe } from './observe.ts';
import { samePath } from './paths.ts';
import type { DriverName, Locator, Unit } from './units.ts';
import { isPlainObject, sha256, stableStringify, type Plain } from './values.ts';

export type Observation =
  { state: 'missing' | 'desired' | 'recorded' } | { state: 'other'; detail: string };

export interface Fingerprints {
  desired?: string;
  recorded?: string;
}

export interface DriverContext {
  documents: Documents;
  backup: Backup;
}

interface Driver {
  inspect(
    locator: Locator,
    fingerprints: Fingerprints,
    context: DriverContext,
  ): Promise<Observation>;
  put(unit: Unit, recorded: string | undefined, context: DriverContext): Promise<void>;
  remove(locator: Locator, recorded: string, context: DriverContext): Promise<void>;
}

const link: Driver = {
  async inspect({ file }, { desired, recorded }) {
    const observed = await observe(file);
    if (observed.type === 'missing') return { state: 'missing' };
    if (observed.type === 'other') return { state: 'other', detail: 'exists and is not a symlink' };
    if (desired !== undefined && (await samePath(observed.to, desired)))
      return { state: 'desired' };
    if (recorded !== undefined && (await samePath(observed.to, recorded)))
      return { state: 'recorded' };
    return { state: 'other', detail: `symlink → ${observed.to}` };
  },
  async put(unit) {
    await mkdir(path.dirname(unit.file), { recursive: true });
    if ((await observe(unit.file)).type === 'link') await unlink(unit.file);
    await symlink(String(unit.value), unit.file);
  },
  async remove({ file }) {
    await unlink(file);
  },
};

const file: Driver = {
  async inspect({ file: target }, fingerprints) {
    const observed = await observe(target);
    if (observed.type === 'missing') return { state: 'missing' };
    if (observed.type === 'link') return { state: 'other', detail: `symlink → ${observed.to}` };
    return compare(sha256(await readFile(target, 'utf8')), fingerprints, 'content differs');
  },
  async put(unit, _recorded, { backup }) {
    await backup.save(unit.file);
    await writeAtomic(unit.file, String(unit.value));
  },
  async remove({ file: target }, _recorded, { backup }) {
    await backup.save(target);
    await unlink(target);
  },
};

const jsonKey: Driver = {
  async inspect(locator, fingerprints, { documents }) {
    const current = await documents.jsonGet(locator.file, locator.pointer);
    if (current === undefined) return { state: 'missing' };
    return compare(stableStringify(current), fingerprints, `has a different value`);
  },
  async put(unit, _recorded, { documents }) {
    await documents.jsonSet(unit.file, unit.pointer, unit.value);
  },
  async remove(locator, _recorded, { documents }) {
    await documents.jsonDelete(locator.file, locator.pointer);
  },
};

const jsonItem: Driver = {
  async inspect(locator, { desired, recorded }, { documents }) {
    const items = await arrayAt(documents, locator);
    const fingerprints = items.map(stableStringify);
    if (desired !== undefined && fingerprints.includes(desired)) return { state: 'desired' };
    if (recorded !== undefined && fingerprints.includes(recorded)) return { state: 'recorded' };
    return { state: 'missing' };
  },
  async put(unit, recorded, { documents }) {
    const items = [...(await arrayAt(documents, unit))];
    const replaceAt = recorded === undefined ? -1 : items.map(stableStringify).indexOf(recorded);
    if (replaceAt >= 0) items[replaceAt] = unit.value;
    else items.push(unit.value);
    await documents.jsonSet(unit.file, unit.pointer, items);
  },
  async remove(locator, recorded, { documents }) {
    const items = (await arrayAt(documents, locator)).filter(
      (item) => stableStringify(item) !== recorded,
    );
    if (items.length > 0) await documents.jsonSet(locator.file, locator.pointer, items);
    else await documents.jsonDelete(locator.file, locator.pointer);
  },
};

const tomlTable: Driver = {
  async inspect(locator, fingerprints, { documents }) {
    const current = await documents.tomlGet(locator.file, locator.pointer);
    if (current === undefined) return { state: 'missing' };
    return compare(stableStringify(current), fingerprints, 'has a different value');
  },
  async put(unit, _recorded, { documents }) {
    if (!isPlainObject(unit.value)) throw new Error('toml-table value must be a table');
    await documents.tomlUpsert(unit.file, unit.pointer, unit.value as Plain);
  },
  async remove(locator, _recorded, { documents }) {
    await documents.tomlRemove(locator.file, locator.pointer);
  },
};

export const DRIVERS: Record<DriverName, Driver> = {
  link,
  file,
  'json-key': jsonKey,
  'json-item': jsonItem,
  'toml-table': tomlTable,
};

function compare(
  current: string,
  { desired, recorded }: Fingerprints,
  detail: string,
): Observation {
  if (current === desired) return { state: 'desired' };
  if (current === recorded) return { state: 'recorded' };
  return { state: 'other', detail };
}

async function arrayAt(documents: Documents, locator: Locator): Promise<unknown[]> {
  const value = await documents.jsonGet(locator.file, locator.pointer);
  return Array.isArray(value) ? value : [];
}
