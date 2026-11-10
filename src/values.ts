import { createHash } from 'node:crypto';

export type Plain = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function fingerprintOf(value: unknown): string {
  return sha256(stableStringify(value));
}

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

export function withoutUndefined<T extends Plain>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}
