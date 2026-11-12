import type { Resource } from './manifest.ts';
import { mapResourceStrings, scanResource } from './secret-scan.ts';
import type { SecretScheme } from './secrets.ts';

export const KEYCHAIN_PREFIX = 'agent-loadout/';

export interface ExtractedSecret {
  scheme: SecretScheme;
  /** Keychain service or environment variable name. */
  name: string;
  value: string;
  resources: string[];
}

export interface SecretExtraction {
  resources: Resource[];
  secrets: ExtractedSecret[];
}

/**
 * Replace every confidently detected secret with a reference. One value used in several
 * resources (the same API key in two profiles) becomes one reference.
 */
export function extractSecrets(resources: Resource[], scheme: SecretScheme): SecretExtraction {
  const byValue = new Map<string, ExtractedSecret>();
  const taken = new Set<string>();

  const rewritten = resources.map((resource) => {
    const findings = scanResource(resource).filter((finding) => finding.confidence !== 'suspected');
    if (findings.length === 0) return resource;

    const fresh = findings.filter((finding) => !byValue.has(finding.value));
    const distinct = new Set(fresh.map((finding) => finding.value)).size;
    fresh.forEach((finding, index) => {
      if (byValue.has(finding.value)) return;
      const qualifier = distinct > 1 ? (finding.hint ?? String(index + 1)) : undefined;
      const base = referenceName(scheme, resource.name, qualifier);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}${scheme === 'env' ? '_' : '-'}${n}`;
      taken.add(name);
      byValue.set(finding.value, { scheme, name, value: finding.value, resources: [] });
    });

    const replacements = [...new Set(findings.map((finding) => finding.value))]
      .map((value) => byValue.get(value)!)
      .sort((a, b) => b.value.length - a.value.length);
    for (const secret of replacements) {
      if (!secret.resources.includes(resource.name)) secret.resources.push(resource.name);
    }
    return mapResourceStrings(resource, (text) =>
      replacements.reduce(
        (current, secret) => current.replaceAll(secret.value, `\${${scheme}:${secret.name}}`),
        text,
      ),
    );
  });

  return { resources: rewritten, secrets: [...byValue.values()] };
}

function referenceName(scheme: SecretScheme, resource: string, qualifier?: string): string {
  if (scheme === 'keychain') {
    return `${KEYCHAIN_PREFIX}${resource}${qualifier ? `/${slug(qualifier).toLowerCase()}` : ''}`;
  }
  const parts = ['LOADOUT', resource, ...(qualifier ? [qualifier] : [])];
  return parts.map((part) => slug(part).toUpperCase()).join('_');
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
