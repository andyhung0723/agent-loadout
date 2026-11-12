import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
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

export interface SecretStore {
  read(service: string): Promise<string | undefined>;
  write(service: string, value: string): Promise<void>;
}

export type StoreResult = 'stored' | 'updated' | 'unchanged';

export async function storeSecrets(
  secrets: { name: string; value: string }[],
  store: SecretStore,
): Promise<Map<string, StoreResult>> {
  const results = new Map<string, StoreResult>();
  for (const { name, value } of secrets) {
    const existing = await store.read(name);
    if (existing === value) {
      results.set(name, 'unchanged');
      continue;
    }
    await store.write(name, value);
    results.set(name, existing === undefined ? 'stored' : 'updated');
  }
  return results;
}

/**
 * macOS login keychain via `security`. The secret goes through `security -i` on stdin, never
 * argv, so it can't be read from the process list.
 */
export function keychainStore(): SecretStore {
  return {
    read: readKeychain,
    async write(service, value) {
      if (process.platform !== 'darwin') throw new Error('the keychain is only available on macOS');
      const command = [
        'add-generic-password',
        '-U',
        '-a',
        quoteForSecurity(os.userInfo().username),
        '-s',
        quoteForSecurity(service),
        '-w',
        quoteForSecurity(value),
      ].join(' ');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 && stderr.trim() === ''
            ? resolve()
            : reject(new Error(`keychain: could not store ${service}: ${stderr.trim() || code}`)),
        );
        child.stdin.end(`${command}\n`);
      });
      if ((await readKeychain(service)) !== value) {
        throw new Error(`keychain: ${service} did not read back as written`);
      }
    },
  };
}

function quoteForSecurity(text: string): string {
  return `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;
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
