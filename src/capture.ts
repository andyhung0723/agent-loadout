import { readFile } from 'node:fs/promises';
import type { ManifestChange } from './journal.ts';
import { renderEntry, scanTarget } from './importer.ts';
import { planToEdit, reparse } from './manifest-edit.ts';
import {
  configKey,
  isProject,
  loadManifest,
  ManifestError,
  resourceId,
  type Kind,
  type Resource,
} from './manifest.ts';
import { extractSecrets, type ExtractedSecret } from './secret-import.ts';
import type { SecretResolver, SecretScheme } from './secrets.ts';
import { findTarget, isSelected, nextSelectors } from './toggle.ts';
import { desiredUnits } from './units.ts';
import { withAbsoluteCommand } from './unmanaged.ts';

const CAPTURABLE: ReadonlySet<Kind> = new Set(['hook', 'mcp', 'plugin', 'marketplace']);

const ELSEWHERE: Partial<Record<Kind, string>> = {
  skill: 'use "loadout adopt <path> --into <dir>" for skills',
  command: 'use "loadout adopt <path> --into <dir>" for commands',
  agent: 'use "loadout agent extract <name> --out <file> --add" for agents',
  instructions: 'point an [[instructions]] entry at the file instead',
};

export interface CapturePlan {
  resource: string;
  target: string;
  /** append: a new entry in the root manifest; extend-to: add the target to an identical entry. */
  change: 'append' | 'extend-to' | 'none';
  /** The entry as written (secrets already replaced by references). */
  entry?: string;
  /** Secrets moved out of the entry: reference → value. Never print `value`. */
  secrets: ExtractedSecret[];
  manifestChange: ManifestChange | null;
}

export interface CaptureOptions {
  manifestPath: string;
  home: string;
  /** keep: leave literal values in the entry. */
  secrets: SecretScheme | 'keep';
  resolver: SecretResolver;
}

/**
 * Turns a hook, MCP server, plugin or marketplace that a tool installed on its own (e.g. `claude
 * mcp add`, `/plugin install`) into a manifest entry, so loadout owns it from now on.
 */
export async function planCapture(
  query: string,
  targetName: string,
  options: CaptureOptions,
): Promise<CapturePlan> {
  const manifest = await loadManifest(options.manifestPath, options.home);
  const target = findTarget(manifest, targetName);
  if (isProject(target)) {
    throw new ManifestError(`capture reads profile targets only; ${target.name} is a project`);
  }

  const [kind, ...rest] = query.split(':') as [Kind, ...string[]];
  const name = rest.join(':');
  if (!name) throw new ManifestError(`expected <kind>:<name>, got "${query}"`);
  if (ELSEWHERE[kind]) throw new ManifestError(`${kind} can't be captured: ${ELSEWHERE[kind]}`);
  if (!CAPTURABLE.has(kind)) throw new ManifestError(`unknown kind "${kind}"`);

  const { definitions } = await scanTarget(target, options.home);
  const ofKind = definitions.filter((definition) => definition.kind === kind);
  const found =
    ofKind.find((definition) => definition.name === name) ??
    ofKind.find((definition) => configKey(definition) === name);
  if (!found) {
    const present = ofKind.map((definition) => definition.name).join(', ') || 'none';
    throw new ManifestError(`no ${kind} "${name}" on ${target.name} (present: ${present})`);
  }
  const captured = { ...found, to: [target.name] } as Resource;
  const id = resourceId(captured);
  const base = { resource: id, target: target.name };

  const existing = manifest.resources.find(
    (resource) => resource.kind === kind && configKey(resource) === configKey(captured),
  );
  if (existing) {
    if (isSelected(existing.to, manifest.targets, target.name)) {
      return {
        ...base,
        resource: resourceId(existing),
        change: 'none',
        secrets: [],
        manifestChange: null,
      };
    }
    const fingerprints = async (resource: Resource, resolver: SecretResolver) =>
      (await desiredUnits({ targets: [target], resources: [resource] }, resolver))
        .map((unit) => `${unit.key}=${unit.fingerprint}`)
        .sort()
        .join('\n');
    const same =
      (await fingerprints({ ...existing, to: [target.name] }, options.resolver)) ===
      (await fingerprints(withAbsoluteCommand(captured, options.home), options.resolver));
    if (!same) {
      throw new ManifestError(
        `${resourceId(existing)} is already in the manifest with a different definition; ` +
          `rename one of them or edit the entry by hand`,
      );
    }
    const to = nextSelectors(existing.to, manifest.targets, target.name, true);
    const { change } = await planToEdit(options.manifestPath, manifest, existing, to, options.home);
    return {
      ...base,
      resource: resourceId(existing),
      change: 'extend-to',
      secrets: [],
      manifestChange: change,
    };
  }

  const extraction =
    options.secrets === 'keep' ? null : extractSecrets([captured], options.secrets);
  const resource = extraction?.resources[0] ?? captured;
  const entry = renderEntry(resource, options.home);
  const before = await readFile(options.manifestPath, 'utf8');
  const after = `${before.replace(/\n*$/, '')}\n\n${entry}\n`;
  await reparse(options.manifestPath, { [options.manifestPath]: after }, options.home);
  return {
    ...base,
    change: 'append',
    entry,
    secrets: extraction?.secrets ?? [],
    manifestChange: { path: options.manifestPath, before, after },
  };
}
