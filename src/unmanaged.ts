import { scanTarget } from './importer.ts';
import { configKey, isProject, type Kind, type Manifest, type Resource } from './manifest.ts';
import { collapseHome, expandHome } from './paths.ts';
import type { SecretResolver } from './secrets.ts';
import { scanSharedCodexSkills } from './shared.ts';
import { describeLocation, desiredUnits, type Unit } from './units.ts';

export interface UnmanagedItem {
  target: string;
  kind: Kind;
  name?: string;
  location: string;
  reason: string;
}

const NO_SECRETS: SecretResolver = { resolve: async () => undefined };

/**
 * Everything present in the targets that the manifest does not account for:
 * importable entries missing from the manifest, plus things loadout can't own as they are.
 */
export async function findUnmanaged(
  manifest: Manifest,
  secrets: SecretResolver,
  home: string,
): Promise<UnmanagedItem[]> {
  const desired = await desiredUnits(manifest, secrets);
  const managed = new Set(desired.map(signature));
  // Files the manifest writes (rendered agents, links) are covered whatever they look like.
  const managedFiles = new Set(
    desired.filter((unit) => unit.pointer.length === 0).map((u) => u.file),
  );
  const items: UnmanagedItem[] = [];

  // Project targets aren't scanned yet: a repository's .claude/ is mostly the team's, not ours.
  for (const target of manifest.targets.filter((candidate) => !isProject(candidate))) {
    const scan = await scanTarget(target, home);
    const present: Resource[] = scan.definitions.map((definition) =>
      withAbsoluteCommand({ ...definition, to: [target.name] } as Resource, home),
    );
    const units = await desiredUnits({ targets: [target], resources: present }, NO_SECRETS);

    for (const unit of units) {
      if (managed.has(signature(unit))) continue;
      const [kind, ...name] = unit.resource.split(':');
      items.push({
        target: target.name,
        kind: kind as Kind,
        name: name.join(':'),
        location: collapseHome(describeLocation(unit), home),
        reason: 'not in manifest',
      });
    }
    for (const entry of scan.unmanaged) {
      if (managedFiles.has(expandHome(entry.location, home))) continue;
      items.push({
        target: entry.target,
        kind: entry.kind,
        location: entry.location,
        reason: entry.hint ?? 'not manageable as is',
      });
    }
  }
  const covered = new Set(
    manifest.resources.filter((r) => r.kind === 'skill').map((r) => configKey(r)),
  );
  for (const [name, location] of await scanSharedCodexSkills(manifest)) {
    if (covered.has(name)) continue;
    items.push({
      target: SHARED_CODEX_TARGET,
      kind: 'skill',
      name,
      location: collapseHome(location, home),
      reason: 'loaded by every Codex profile from the shared folder',
    });
  }
  return items;
}

export const SHARED_CODEX_TARGET = 'codex (shared)';

/** import writes `~/…` for portability; the manifest expands it, so compare like with like. */
function withAbsoluteCommand(resource: Resource, home: string): Resource {
  const expand = (command: string | undefined) =>
    command?.startsWith('~/') ? `${home}${command.slice(1)}` : command;
  switch (resource.kind) {
    case 'hook':
      return { ...resource, spec: { ...resource.spec, command: expand(resource.spec.command)! } };
    case 'mcp':
      return {
        ...resource,
        server: { ...resource.server, command: expand(resource.server.command) },
      };
    default:
      return resource;
  }
}

function signature(unit: Unit): string {
  const where = `${unit.driver}:${unit.file}#${unit.pointer.join('/')}`;
  return unit.driver === 'json-item' ? `${where}@${unit.fingerprint}` : where;
}
