import type { Resource } from './manifest.ts';
import { isPlainObject } from './values.ts';

/**
 * Finds secrets by what the value looks like, not only by the key it sits under: a token in a
 * positional arg, a header or a URL query is caught as well as `API_KEY = "…"`.
 *
 * - known: a recognisable token format (sk-…, ghp_…, ctx7sk-…, JWT, …) → converted
 * - named: the value of a secret-named env/header/flag/query key → converted
 * - suspected: long high-entropy string with nothing else to go on → only flagged
 */
const KNOWN_TOKENS = [
  /\bsk-ant-[\w-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bctx7sk-[\w-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bglpat-[\w-]{20,}/g,
  /\bxox[abposr]-[\w-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{35}/g,
  /\bfigd_[\w-]{20,}/g,
  /\bntn_\w{30,}/g,
  /\b[sr]k_live_\w{20,}/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
];

const SECRET_NAME =
  /(token|secret|passw(or)?d|api[-_]?key|apikey|auth|credential|private[-_]?key|\bpat\b)/i;
const AUTH_SCHEME = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;
const INLINE_AUTH = /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/;
const FLAG = /^--?([\w-]+)(?:=(.*))?$/;
const STRUCTURAL_KEYS = new Set(['kind', 'name', 'key', 'to', 'mode', 'events', 'source']);

export interface Finding {
  value: string;
  /** Where it was found, used to name the reference (e.g. "API_KEY", "api-key", "token"). */
  hint?: string;
  confidence: 'known' | 'named' | 'suspected';
}

interface Context {
  key?: string;
  previous?: string;
}

export function findSecretsIn(text: string, context: Context = {}): Finding[] {
  if (text.includes('${')) return [];
  const findings = new Map<string, Finding>();
  const add = (finding: Finding) => {
    if (!findings.has(finding.value)) findings.set(finding.value, finding);
  };

  for (const pattern of KNOWN_TOKENS) {
    for (const [value] of text.matchAll(pattern)) {
      add({ value, hint: hintFrom(context), confidence: 'known' });
    }
  }

  const named = namedValue(text, context);
  if (named && !isSetting(named.value)) {
    add({ ...named, confidence: named.value.length >= 8 ? 'named' : 'suspected' });
  }

  if (findings.size === 0) {
    for (const value of text.split(/[\s"'=&?,;]+/)) {
      if (highEntropy(value)) add({ value, hint: hintFrom(context), confidence: 'suspected' });
    }
  }
  return [...findings.values()];
}

function namedValue(text: string, { key, previous }: Context): Omit<Finding, 'confidence'> | null {
  const unwrap = (value: string) => AUTH_SCHEME.exec(value)?.[1] ?? value;

  if (key && SECRET_NAME.test(key)) return { value: unwrap(text), hint: key };
  if (key && /^authorization$/i.test(key)) return { value: unwrap(text), hint: 'authorization' };

  const flag = FLAG.exec(text);
  if (flag?.[2] !== undefined && SECRET_NAME.test(flag[1]!)) {
    return { value: unwrap(flag[2]), hint: flag[1] };
  }
  const previousFlag = previous ? FLAG.exec(previous) : null;
  if (previousFlag && previousFlag[2] === undefined && SECRET_NAME.test(previousFlag[1]!)) {
    return { value: unwrap(text), hint: previousFlag[1] };
  }

  const inline = INLINE_AUTH.exec(text);
  if (inline) return { value: inline[1]!, hint: 'authorization' };

  if (/^https?:\/\//.test(text)) {
    try {
      for (const [param, value] of new URL(text).searchParams) {
        if (SECRET_NAME.test(param) || param === 'key') return { value, hint: param };
      }
    } catch {
      // not a URL after all
    }
  }
  return null;
}

/** A secret-named key also holds paths, switches and numbers; those aren't credentials. */
function isSetting(value: string): boolean {
  return (
    value === '' ||
    /\s/.test(value) ||
    /^(true|false|\d+)$/i.test(value) ||
    /^[~./]/.test(value) ||
    value.includes('://')
  );
}

function highEntropy(value: string): boolean {
  if (value.length < 24 || !/^[A-Za-z0-9_+/=.-]+$/.test(value)) return false;
  if (/^[~./]/.test(value) || /^[\w.-]+\/[\w./-]+$/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((pattern) => pattern.test(value)).length;
  if (classes < 3) return false;
  return shannon(value) >= 3.5;
}

function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hintFrom({ key, previous }: Context): string | undefined {
  if (key) return key;
  const flag = previous ? FLAG.exec(previous) : null;
  return flag?.[1];
}

export interface ResourceSecret extends Finding {
  resource: string;
}

/** Every string a resource will write into a target config, with its key / previous sibling. */
export function scanResource(resource: Resource): ResourceSecret[] {
  if (resource.kind !== 'mcp' && resource.kind !== 'hook' && resource.kind !== 'marketplace') {
    return [];
  }
  const found: ResourceSecret[] = [];
  walk(resource, {}, (text, context) => {
    for (const finding of findSecretsIn(text, context)) {
      found.push({ ...finding, resource: resource.name });
    }
  });
  return found;
}

/** Same traversal as `scanResource`, rewriting strings instead of collecting findings. */
export function mapResourceStrings(resource: Resource, map: (text: string) => string): Resource {
  return transform(resource, map, true) as Resource;
}

function walk(value: unknown, context: Context, visit: (text: string, context: Context) => void) {
  if (typeof value === 'string') return visit(value, context);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const previous = typeof value[index - 1] === 'string' ? value[index - 1] : undefined;
      walk(item, { key: context.key, previous }, visit);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (context.key === undefined && STRUCTURAL_KEYS.has(key)) continue;
    walk(item, { key }, visit);
  }
}

function transform(value: unknown, map: (text: string) => string, root = false): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => transform(item, map));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      root && STRUCTURAL_KEYS.has(key) ? item : transform(item, map),
    ]),
  );
}
