import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPlainObject } from './values.ts';

export const SECRET_SCHEMES = ['env', 'keychain'] as const;
export type SecretScheme = (typeof SECRET_SCHEMES)[number];

export interface SecretRef {
  scheme: SecretScheme;
  name: string;
}

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string | undefined>;
}

const REFERENCE = /\$(\$?)\{(env|keychain):([^}\s]+)\}/g;

export function describeRef(ref: SecretRef): string {
  return `${ref.scheme}:${ref.name}`;
}

export function findRefs(value: unknown): SecretRef[] {
  const refs = new Map<string, SecretRef>();
  visitStrings(value, (text) => {
    for (const [, escaped, scheme, name] of text.matchAll(REFERENCE)) {
      if (escaped) continue;
      const ref = { scheme: scheme as SecretScheme, name: name! };
      refs.set(describeRef(ref), ref);
    }
  });
  return [...refs.values()];
}

export async function interpolate(
  value: unknown,
  resolver: SecretResolver,
): Promise<{ value: unknown; missing: SecretRef[] }> {
  const resolved = new Map<string, string>();
  const missing: SecretRef[] = [];
  for (const ref of findRefs(value)) {
    const secret = await resolver.resolve(ref);
    if (secret === undefined) missing.push(ref);
    else resolved.set(describeRef(ref), secret);
  }
  if (missing.length > 0) return { value, missing };

  const substitute = (text: string) =>
    text.replace(REFERENCE, (whole, escaped: string, scheme: string, name: string) =>
      escaped ? whole.slice(1) : resolved.get(`${scheme}:${name}`)!,
    );
  return { value: mapStrings(value, substitute), missing };
}

export function createDefaultResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  const cache = new Map<string, Promise<string | undefined>>();
  return {
    resolve(ref) {
      const key = describeRef(ref);
      if (!cache.has(key)) cache.set(key, lookup(ref, env));
      return cache.get(key)!;
    },
  };
}

const execFileAsync = promisify(execFile);

async function lookup(ref: SecretRef, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  switch (ref.scheme) {
    case 'env':
      return env[ref.name];
    case 'keychain':
      return readKeychain(ref.name);
  }
}

async function readKeychain(service: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ]);
    return stdout.replace(/\n$/, '');
  } catch {
    return undefined;
  }
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((item) => visitStrings(item, visit));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => visitStrings(item, visit));
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, map)]));
  }
  return value;
}
