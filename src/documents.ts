import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { removeTomlTable, upsertTomlTable } from './toml-text.ts';
import { isPlainObject, type Plain } from './values.ts';

interface LoadedDocument {
  original: string | null;
  text: string;
  dirty: boolean;
}

export class Documents {
  readonly #loaded = new Map<string, LoadedDocument>();
  readonly #json = new Map<string, Plain>();

  async jsonGet(file: string, pointer: string[]): Promise<unknown> {
    return getIn(await this.#jsonData(file), pointer);
  }

  async jsonSet(file: string, pointer: string[], value: unknown): Promise<void> {
    setIn(await this.#jsonData(file), pointer, value);
    this.#loaded.get(file)!.dirty = true;
  }

  async jsonDelete(file: string, pointer: string[]): Promise<void> {
    deleteIn(await this.#jsonData(file), pointer);
    this.#loaded.get(file)!.dirty = true;
  }

  async tomlGet(file: string, pointer: string[]): Promise<unknown> {
    const document = await this.#load(file);
    try {
      return getIn(parseToml(document.text), pointer);
    } catch (error) {
      throw new Error(`${file}: invalid TOML (${(error as Error).message})`);
    }
  }

  async tomlUpsert(file: string, pointer: string[], table: Plain): Promise<void> {
    const document = await this.#load(file);
    document.text = upsertTomlTable(document.text, pointer, table);
    document.dirty = true;
  }

  async tomlRemove(file: string, pointer: string[]): Promise<void> {
    const document = await this.#load(file);
    document.text = removeTomlTable(document.text, pointer);
    document.dirty = true;
  }

  async flush(backup: Backup): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    for (const [file, document] of this.#loaded) {
      if (!document.dirty) continue;
      try {
        if ((await readOrNull(file)) !== document.original) {
          throw new Error('changed on disk since it was read — re-run plan');
        }
        const json = this.#json.get(file);
        const text = json ? JSON.stringify(json, null, 2) + '\n' : document.text;
        await backup.save(file);
        await writeAtomic(file, text);
        document.original = text;
        document.dirty = false;
      } catch (error) {
        failures.set(file, (error as Error).message);
      }
    }
    return failures;
  }

  async #load(file: string): Promise<LoadedDocument> {
    let document = this.#loaded.get(file);
    if (!document) {
      const original = await readOrNull(file);
      document = { original, text: original ?? '', dirty: false };
      this.#loaded.set(file, document);
    }
    return document;
  }

  async #jsonData(file: string): Promise<Plain> {
    const cached = this.#json.get(file);
    if (cached) return cached;
    const document = await this.#load(file);
    let data: unknown = {};
    if (document.text.trim() !== '') {
      try {
        data = JSON.parse(document.text);
      } catch (error) {
        throw new Error(`${file}: invalid JSON (${(error as Error).message})`);
      }
    }
    if (!isPlainObject(data)) throw new Error(`${file}: top level must be a JSON object`);
    this.#json.set(file, data);
    return data;
  }
}

export class Backup {
  readonly #root: string;
  readonly #saved = new Set<string>();

  constructor(root: string) {
    this.#root = root;
  }

  async save(file: string): Promise<void> {
    if (this.#saved.has(file)) return;
    this.#saved.add(file);
    try {
      const dest = path.join(this.#root, file);
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.loadout-${process.pid}.tmp`;
  await writeFile(temp, text);
  const mode = await modeOrNull(file);
  if (mode !== null) await chmod(temp, mode);
  await rename(temp, file);
}

export async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function modeOrNull(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mode & 0o777;
  } catch {
    return null;
  }
}

function getIn(root: unknown, pointer: string[]): unknown {
  let current = root;
  for (const key of pointer) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setIn(root: Plain, pointer: string[], value: unknown): void {
  const parent = pointer.slice(0, -1).reduce<Plain>((node, key) => {
    if (!isPlainObject(node[key])) node[key] = {};
    return node[key] as Plain;
  }, root);
  parent[pointer.at(-1)!] = value;
}

function deleteIn(root: Plain, pointer: string[]): void {
  const parent = getIn(root, pointer.slice(0, -1));
  if (isPlainObject(parent)) delete parent[pointer.at(-1)!];
}
