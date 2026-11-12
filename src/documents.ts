import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { removeTomlTable, upsertTomlTable } from './toml-text.ts';
import { isPlainObject, stableStringify, type Plain } from './values.ts';

type Format = 'json' | 'toml';

type Edit =
  | { op: 'json-set'; pointer: string[]; value: unknown }
  | { op: 'json-delete'; pointer: string[] }
  | { op: 'toml-upsert'; pointer: string[]; table: Plain }
  | { op: 'toml-remove'; pointer: string[] };

interface LoadedDocument {
  original: string | null;
  text: string;
  dirty: boolean;
  format?: Format;
  /** Pointers whose value the plan depends on: everything read or edited. */
  touched: Map<string, string[]>;
  edits: Edit[];
}

export class Documents {
  readonly #loaded = new Map<string, LoadedDocument>();
  readonly #json = new Map<string, Plain>();

  async jsonGet(file: string, pointer: string[]): Promise<unknown> {
    const data = await this.#jsonData(file);
    touch(this.#loaded.get(file)!, pointer);
    return getIn(data, pointer);
  }

  async jsonSet(file: string, pointer: string[], value: unknown): Promise<void> {
    setIn(await this.#jsonData(file), pointer, value);
    this.#edit(file, { op: 'json-set', pointer, value });
  }

  async jsonDelete(file: string, pointer: string[]): Promise<void> {
    deleteIn(await this.#jsonData(file), pointer);
    this.#edit(file, { op: 'json-delete', pointer });
  }

  async tomlGet(file: string, pointer: string[]): Promise<unknown> {
    const document = await this.#load(file, 'toml');
    touch(document, pointer);
    return getIn(parseTomlText(file, document.text), pointer);
  }

  async tomlUpsert(file: string, pointer: string[], table: Plain): Promise<void> {
    const document = await this.#load(file, 'toml');
    document.text = upsertTomlTable(document.text, pointer, table);
    this.#edit(file, { op: 'toml-upsert', pointer, table });
  }

  async tomlRemove(file: string, pointer: string[]): Promise<void> {
    const document = await this.#load(file, 'toml');
    document.text = removeTomlTable(document.text, pointer);
    this.#edit(file, { op: 'toml-remove', pointer });
  }

  /**
   * Writes every edited file. A file another process changed since it was read is rebased: if
   * none of the values this plan read or edits moved, the edits are replayed onto the new
   * content (a running Claude session bumping `numStartups` doesn't block an apply); otherwise
   * the file is skipped and the moved key is named.
   */
  async flush(backup: Backup): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    for (const [file, document] of this.#loaded) {
      if (!document.dirty) continue;
      try {
        const current = await readOrNull(file);
        const text =
          current === document.original
            ? this.#render(file, document)
            : rebase(file, document, current);
        await backup.save(file);
        await writeAtomic(file, text);
        document.original = text;
        document.text = text;
        document.dirty = false;
        document.edits = [];
        document.touched.clear();
        this.#json.delete(file);
      } catch (error) {
        failures.set(file, (error as Error).message);
      }
    }
    return failures;
  }

  #render(file: string, document: LoadedDocument): string {
    const json = this.#json.get(file);
    return json ? renderJson(json) : document.text;
  }

  #edit(file: string, edit: Edit): void {
    const document = this.#loaded.get(file)!;
    touch(document, edit.pointer);
    document.edits.push(edit);
    document.dirty = true;
  }

  async #load(file: string, format: Format): Promise<LoadedDocument> {
    let document = this.#loaded.get(file);
    if (!document) {
      const original = await readOrNull(file);
      document = { original, text: original ?? '', dirty: false, touched: new Map(), edits: [] };
      this.#loaded.set(file, document);
    }
    document.format ??= format;
    return document;
  }

  async #jsonData(file: string): Promise<Plain> {
    const cached = this.#json.get(file);
    if (cached) return cached;
    const document = await this.#load(file, 'json');
    const data = parseJsonText(file, document.text);
    this.#json.set(file, data);
    return data;
  }
}

function touch(document: LoadedDocument, pointer: string[]): void {
  document.touched.set(JSON.stringify(pointer), pointer);
}

function rebase(file: string, document: LoadedDocument, current: string | null): string {
  const parse = document.format === 'toml' ? parseTomlText : parseJsonText;
  const before = parse(file, document.original ?? '');
  const after = parse(file, current ?? '');
  for (const pointer of document.touched.values()) {
    if (stableStringify(getIn(before, pointer)) !== stableStringify(getIn(after, pointer))) {
      throw new Error(`${pointer.join('.')} changed on disk since it was read — re-run plan`);
    }
  }

  if (document.format === 'toml') {
    return document.edits.reduce(
      (text, edit) =>
        edit.op === 'toml-upsert'
          ? upsertTomlTable(text, edit.pointer, edit.table)
          : removeTomlTable(text, edit.pointer),
      current ?? '',
    );
  }
  for (const edit of document.edits) {
    if (edit.op === 'json-set') setIn(after, edit.pointer, edit.value);
    else deleteIn(after, edit.pointer);
  }
  return renderJson(after);
}

function renderJson(data: Plain): string {
  return JSON.stringify(data, null, 2) + '\n';
}

function parseJsonText(file: string, text: string): Plain {
  if (text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(data)) throw new Error(`${file}: top level must be a JSON object`);
  return data;
}

function parseTomlText(file: string, text: string): Plain {
  try {
    return parseToml(text);
  } catch (error) {
    throw new Error(`${file}: invalid TOML (${(error as Error).message})`);
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
