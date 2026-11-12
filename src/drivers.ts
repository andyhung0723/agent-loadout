import { cp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readOrNull, writeAtomic, type Backup, type Documents } from './documents.ts';
import { observe } from './observe.ts';
import { samePath } from './paths.ts';
import { treeHash } from './tree.ts';
import type { SecretResolver } from './secrets.ts';
import type { DriverName, Locator, Unit } from './units.ts';
import { fingerprintOf, isPlainObject, sha256, type Plain } from './values.ts';

export type Observation =
  { state: 'missing' | 'desired' | 'recorded' } | { state: 'other'; detail: string };

/** The value a unit occupies on disk; `value` is absent when nothing is there. */
export interface Snapshot {
  value?: unknown;
  /** json-item only: position in the array, so a removed item is put back where it was. */
  index?: number;
}

export interface Fingerprints {
  desired?: string;
  recorded?: string;
}

export interface DriverContext {
  documents: Documents;
  backup: Backup;
}

export interface PlanContext extends DriverContext {
  secrets: SecretResolver;
}

interface Driver {
  inspect(
    locator: Locator,
    fingerprints: Fingerprints,
    context: DriverContext,
  ): Promise<Observation>;
  put(unit: Unit, recorded: string | undefined, context: DriverContext): Promise<void>;
  remove(locator: Locator, recorded: string, context: DriverContext): Promise<void>;
  /** json-item finds its item by `fingerprint`; other drivers read the whole location. */
  capture(
    locator: Locator,
    fingerprint: string | undefined,
    context: DriverContext,
  ): Promise<Snapshot>;
  /** Turn `from` (verified current) into `to`. */
  revert(locator: Locator, from: Snapshot, to: Snapshot, context: DriverContext): Promise<void>;
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
  async capture({ file }) {
    const observed = await observe(file);
    return observed.type === 'link' ? { value: observed.to } : {};
  },
  async revert({ file }, from, to) {
    if (from.value !== undefined) await unlink(file);
    if (to.value === undefined) return;
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(String(to.value), file);
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
  async capture({ file: target }) {
    if ((await observe(target)).type !== 'other') return {};
    return { value: await readFile(target, 'utf8') };
  },
  async revert({ file: target }, from, to, { backup }) {
    await backup.save(target);
    if (to.value !== undefined) await writeAtomic(target, String(to.value));
    else if (from.value !== undefined) await unlink(target);
  },
};

const jsonKey: Driver = {
  async inspect(locator, fingerprints, { documents }) {
    const current = await documents.jsonGet(locator.file, locator.pointer);
    if (current === undefined) return { state: 'missing' };
    return compare(fingerprintOf(current), fingerprints, 'has a different value');
  },
  async put(unit, _recorded, { documents }) {
    await documents.jsonSet(unit.file, unit.pointer, unit.value);
  },
  async remove(locator, _recorded, { documents }) {
    await documents.jsonDelete(locator.file, locator.pointer);
  },
  async capture(locator, _fingerprint, { documents }) {
    return present(await documents.jsonGet(locator.file, locator.pointer));
  },
  async revert(locator, _from, to, { documents }) {
    if (to.value === undefined) await documents.jsonDelete(locator.file, locator.pointer);
    else await documents.jsonSet(locator.file, locator.pointer, to.value);
  },
};

const jsonItem: Driver = {
  async inspect(locator, { desired, recorded }, { documents }) {
    const items = await arrayAt(documents, locator);
    const fingerprints = items.map(fingerprintOf);
    if (desired !== undefined && fingerprints.includes(desired)) return { state: 'desired' };
    if (recorded !== undefined && fingerprints.includes(recorded)) return { state: 'recorded' };
    return { state: 'missing' };
  },
  async put(unit, recorded, { documents }) {
    const items = [...(await arrayAt(documents, unit))];
    const replaceAt = recorded === undefined ? -1 : items.map(fingerprintOf).indexOf(recorded);
    if (replaceAt >= 0) items[replaceAt] = unit.value;
    else items.push(unit.value);
    await documents.jsonSet(unit.file, unit.pointer, items);
  },
  async remove(locator, recorded, { documents }) {
    const items = (await arrayAt(documents, locator)).filter(
      (item) => fingerprintOf(item) !== recorded,
    );
    await setItems(documents, locator, items);
  },
  async capture(locator, fingerprint, { documents }) {
    const items = await arrayAt(documents, locator);
    const index = fingerprint === undefined ? -1 : items.map(fingerprintOf).indexOf(fingerprint);
    return index < 0 ? {} : { value: items[index], index };
  },
  async revert(locator, from, to, { documents }) {
    const items = [...(await arrayAt(documents, locator))];
    const index =
      from.value === undefined ? -1 : items.map(fingerprintOf).indexOf(fingerprintOf(from.value));
    if (index >= 0 && to.value !== undefined) items[index] = to.value;
    else if (index >= 0) items.splice(index, 1);
    else if (to.value !== undefined)
      items.splice(Math.min(to.index ?? items.length, items.length), 0, to.value);
    await setItems(documents, locator, items);
  },
};

const tomlTable: Driver = {
  async inspect(locator, fingerprints, { documents }) {
    const current = await documents.tomlGet(locator.file, locator.pointer);
    if (current === undefined) return { state: 'missing' };
    return compare(fingerprintOf(current), fingerprints, 'has a different value');
  },
  async put(unit, _recorded, { documents }) {
    if (!isPlainObject(unit.value)) throw new Error('toml-table value must be a table');
    await documents.tomlUpsert(unit.file, unit.pointer, unit.value as Plain);
  },
  async remove(locator, _recorded, { documents }) {
    await documents.tomlRemove(locator.file, locator.pointer);
  },
  async capture(locator, _fingerprint, { documents }) {
    return present(await documents.tomlGet(locator.file, locator.pointer));
  },
  async revert(locator, _from, to, { documents }) {
    if (to.value === undefined) await documents.tomlRemove(locator.file, locator.pointer);
    else await documents.tomlUpsert(locator.file, locator.pointer, to.value as Plain);
  },
};

/**
 * A real copy of a skill/command/instructions source, for files a repository commits (a symlink
 * into someone's home folder would dangle for everyone else). Compared by content hash.
 */
const copy: Driver = {
  async inspect({ file: target }, fingerprints) {
    const observed = await observe(target);
    if (observed.type === 'missing') return { state: 'missing' };
    if (observed.type === 'link') return { state: 'other', detail: `symlink → ${observed.to}` };
    return compare(await treeHash(target, { follow: true }), fingerprints, 'content differs');
  },
  async put(unit, _recorded, { backup }) {
    if ((await observe(unit.file)).type !== 'missing') {
      await backup.save(unit.file);
      await rm(unit.file, { recursive: true });
    }
    await mkdir(path.dirname(unit.file), { recursive: true });
    await cp(String(unit.value), unit.file, { recursive: true, dereference: true });
  },
  async remove({ file: target }, _recorded, { backup }) {
    await backup.save(target);
    await rm(target, { recursive: true });
  },
  async capture({ file: target }) {
    if ((await observe(target)).type !== 'other') return {};
    return { value: await treeHash(target, { follow: true }) };
  },
  async revert() {
    throw new Error('copied into a repository; restore it with git (the run backup also has it)');
  },
};

/** One line in a text file that loadout owns, e.g. an entry in `.git/info/exclude`. */
const line: Driver = {
  /** A line has no other version: present is the wanted line, or the recorded one when orphaned. */
  async inspect({ file: target, pointer }, { desired }) {
    if (!(await linesOf(target)).includes(pointer[0]!)) return { state: 'missing' };
    return { state: desired !== undefined ? 'desired' : 'recorded' };
  },
  async put(unit, _recorded, { backup }) {
    const text = (await readOrNull(unit.file)) ?? '';
    if (text.split('\n').includes(unit.pointer[0]!)) return;
    await backup.save(unit.file);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await writeAtomic(unit.file, `${text}${separator}${unit.pointer[0]}\n`);
  },
  async remove({ file: target, pointer }, _recorded, { backup }) {
    const text = await readOrNull(target);
    if (text === null) return;
    await backup.save(target);
    await writeAtomic(
      target,
      text
        .split('\n')
        .filter((entry) => entry !== pointer[0])
        .join('\n'),
    );
  },
  async capture({ file: target, pointer }) {
    return (await linesOf(target)).includes(pointer[0]!) ? { value: pointer[0] } : {};
  },
  async revert(locator, from, to, context) {
    if (to.value !== undefined)
      await line.put({ ...locator, value: to.value } as Unit, undefined, context);
    else if (from.value !== undefined) await line.remove(locator, '', context);
  },
};

async function linesOf(file: string): Promise<string[]> {
  return ((await readOrNull(file)) ?? '').split('\n');
}

export const DRIVERS: Record<DriverName, Driver> = {
  link,
  copy,
  line,
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

function present(value: unknown): Snapshot {
  return value === undefined ? {} : { value };
}

async function setItems(documents: Documents, locator: Locator, items: unknown[]): Promise<void> {
  if (items.length > 0) await documents.jsonSet(locator.file, locator.pointer, items);
  else await documents.jsonDelete(locator.file, locator.pointer);
}

async function arrayAt(documents: Documents, locator: Locator): Promise<unknown[]> {
  const value = await documents.jsonGet(locator.file, locator.pointer);
  return Array.isArray(value) ? value : [];
}
