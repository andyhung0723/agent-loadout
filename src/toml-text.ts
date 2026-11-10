import { isPlainObject, type Plain } from './values.ts';

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

export function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  throw new Error(`cannot express ${String(value)} as TOML`);
}

export function tomlMultiline(text: string): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"');
  return `"""\n${escaped}\n"""`;
}

export function tomlTableBlock(path: string[], table: Plain): string {
  const lines = [`[${path.map(tomlKey).join('.')}]`];
  for (const [key, value] of Object.entries(table)) {
    if (value !== undefined) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  }
  return lines.join('\n') + '\n';
}

interface Section {
  path: string[] | null;
  isArray: boolean;
  start: number;
  end: number;
}

export function removeTomlTable(text: string, path: string[]): string {
  return replaceTomlTable(text, path, null);
}

export function upsertTomlTable(text: string, path: string[], table: Plain): string {
  return replaceTomlTable(text, path, tomlTableBlock(path, table));
}

function replaceTomlTable(text: string, path: string[], block: string | null): string {
  const lines = text.split('\n');
  const owned = sections(lines).filter(
    (section) => !section.isArray && section.path !== null && startsWith(section.path, path),
  );

  if (owned.length === 0) {
    if (block === null) return text;
    const base = text.replace(/\n*$/, '');
    return base === '' ? block : `${base}\n\n${block}`;
  }

  const first = owned[0]!;
  const ownedLines = new Set(owned.flatMap((section) => range(section.start, section.end)));
  const replacement = block === null ? [] : [...block.split('\n').slice(0, -1), ''];
  const result = lines.flatMap((line, index) => {
    if (index === first.start) return replacement;
    return ownedLines.has(index) ? [] : [line];
  });
  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

function sections(lines: string[]): Section[] {
  const result: Section[] = [{ path: null, isArray: false, start: 0, end: lines.length }];
  let openDelimiter: string | null = null;

  lines.forEach((line, index) => {
    if (openDelimiter) {
      if (line.includes(openDelimiter)) openDelimiter = null;
      return;
    }
    const header = parseHeader(line);
    if (header) {
      result.at(-1)!.end = index;
      result.push({ ...header, start: index, end: lines.length });
      return;
    }
    openDelimiter = unclosedMultilineDelimiter(line);
  });
  return result;
}

function unclosedMultilineDelimiter(line: string): string | null {
  for (const delimiter of ['"""', "'''"]) {
    if (line.split(delimiter).length % 2 === 0) return delimiter;
  }
  return null;
}

const KEY_TOKEN = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*/y;

function parseHeader(line: string): { path: string[]; isArray: boolean } | null {
  const match = /^\s*(\[\[?)(.*?)(\]\]?)\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  const isArray = match[1] === '[[';
  if (isArray !== (match[3] === ']]')) return null;

  const body = match[2]!;
  const path: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    KEY_TOKEN.lastIndex = cursor;
    const token = KEY_TOKEN.exec(body);
    if (!token) return null;
    const [, bare, basic, literal] = token;
    path.push(bare ?? (basic !== undefined ? JSON.parse(`"${basic}"`) : literal!));
    cursor = KEY_TOKEN.lastIndex;
    if (cursor < body.length) {
      if (body[cursor] !== '.') return null;
      cursor++;
    }
  }
  return path.length > 0 ? { path, isArray } : null;
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((key, index) => path[index] === key);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

export function replaceKeyInArrayTable(
  text: string,
  table: string,
  index: number,
  key: string,
  valueToml: string,
): string {
  const lines = text.split('\n');
  const section = sections(lines).filter(
    (candidate) => candidate.isArray && candidate.path?.length === 1 && candidate.path[0] === table,
  )[index];
  if (!section) throw new Error(`[[${table}]] #${index + 1} not found`);

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(tomlKey(key))}\\s*=`);
  const start = range(section.start + 1, section.end).find((line) => keyPattern.test(lines[line]!));
  if (start === undefined) throw new Error(`[[${table}]] #${index + 1} has no "${key}"`);

  let end = start;
  while (!isBalanced(lines.slice(start, end + 1).join('\n')) && end + 1 < section.end) end++;

  const indent = /^\s*/.exec(lines[start]!)![0];
  lines.splice(start, end - start + 1, `${indent}${tomlKey(key)} = ${valueToml}`);
  return lines.join('\n');
}

function isBalanced(assignment: string): boolean {
  const value = assignment.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|#.*$/gm, '');
  return (value.match(/\[/g) ?? []).length === (value.match(/\]/g) ?? []).length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
