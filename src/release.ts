import type { JournalEntry, ManifestChange } from './journal.ts';
import { loadManifest, ManifestError, resourceId } from './manifest.ts';
import { planToEdit, writeChange } from './manifest-edit.ts';
import { selectTargets } from './selector.ts';
import { scanSharedCodexSkills } from './shared.ts';
import type { OwnedUnit, State } from './state.ts';
import { sharedEntry } from './status.ts';
import { findResource, findTarget, isSelected, nextSelectors } from './toggle.ts';
import { describeLocation } from './units.ts';

export interface ReleasePlan {
  resource: string;
  targets: string[];
  before: string[];
  after: string[];
  /** Ownership records dropped; the files they describe stay where they are. */
  released: { key: string; unit: OwnedUnit; location: string }[];
  manifest: ManifestChange;
}

/**
 * Stop managing a resource on some targets without touching what's on disk: they leave its "to"
 * and loadout forgets it owned them. Unlike `toggle … off`, nothing is deleted.
 */
export async function planRelease(
  manifestPath: string,
  state: State,
  request: { resource: string; targets: string[] },
  home?: string,
): Promise<ReleasePlan> {
  const manifest = await loadManifest(manifestPath, home);
  const resource = findResource(manifest, request.resource);
  const id = resourceId(resource);
  const selected = selectTargets(resource.to, manifest.targets).map((target) => target.name);
  const shared = await scanSharedCodexSkills(manifest);

  const targets = request.targets.length > 0 ? request.targets : selected;
  for (const name of targets) {
    const target = findTarget(manifest, name);
    if (selected.includes(name)) continue;
    const inherited = sharedEntry(resource, target, shared);
    throw new ManifestError(
      inherited
        ? `${id} reaches ${name} from the shared folder ${inherited}, not from this manifest`
        : `${id} is not enabled on ${name}`,
    );
  }
  if (targets.length === 0) throw new ManifestError(`${id} is not enabled on any target`);

  const after =
    request.targets.length === 0
      ? []
      : targets.reduce(
          (selectors, name) => nextSelectors(selectors, manifest.targets, name, false),
          resource.to,
        );
  const edit = await planToEdit(manifestPath, manifest, resource, after, home);
  const reparsed = findResource(edit.manifest, id);
  if (targets.some((name) => isSelected(reparsed.to, manifest.targets, name))) {
    throw new Error(`internal: rewritten manifest still selects a released target of ${id}`);
  }

  const released = Object.entries(state.units)
    .filter(([, unit]) => unit.resource === id && targets.includes(unit.target))
    .map(([key, unit]) => ({ key, unit, location: describeLocation(unit) }));

  return {
    resource: id,
    targets,
    before: resource.to,
    after,
    released,
    manifest: edit.change,
  };
}

export async function applyRelease(
  plan: ReleasePlan,
  state: State,
): Promise<{ state: State; journal: JournalEntry[] }> {
  await writeChange(plan.manifest);

  const units = { ...state.units };
  const journal: JournalEntry[] = plan.released.map(({ key, unit }) => {
    delete units[key];
    const { driver, file, pointer } = unit;
    return {
      key,
      action: 'release',
      resource: unit.resource,
      target: unit.target,
      locator: { driver, file, pointer },
      ownedBefore: unit,
      ownedAfter: null,
    };
  });
  return { state: { ...state, units }, journal };
}
