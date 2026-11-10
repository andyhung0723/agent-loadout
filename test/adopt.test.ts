import assert from 'node:assert/strict';
import { lstat, mkdir, readlink, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { applyAdopt, planAdopt } from '../src/adopt.ts';
import { ManifestError, parseManifest } from '../src/manifest.ts';
import { emptyState } from '../src/state.ts';
import { actions, Sandbox, TARGETS } from './sandbox.ts';

let box: Sandbox;
let options: { manifestPath: string; into: string; backupDir: string; home: string };

beforeEach(async () => {
  box = await Sandbox.create();
  await box.write('loadout.toml', TARGETS);
  await box.write('.codex/skills/gsap-core/SKILL.md', '# gsap core\n');
  await box.write('.codex/skills/gsap-core/refs/api.md', 'api\n');
  options = {
    manifestPath: box.path('loadout.toml'),
    into: '~/config/skills',
    backupDir: box.path('backups'),
    home: box.home,
  };
});

afterEach(() => box.dispose());

describe('adopt', () => {
  test('moves a real skill into the source folder, links it back, records manifest + state', async () => {
    const plan = await planAdopt('~/.codex/skills/gsap-core', options);
    assert.equal(plan.mode, 'move');
    assert.equal(plan.manifestChange, 'append');

    const state = await applyAdopt(plan, options, emptyState());

    assert.equal(
      await readlink(box.path('.codex/skills/gsap-core')),
      box.path('config/skills/gsap-core'),
    );
    assert.equal(await box.read('config/skills/gsap-core/refs/api.md'), 'api\n');
    assert.match(
      await box.read('loadout.toml'),
      /\[\[skill\]\]\nname = "gsap-core"\npath = "~\/config\/skills\/gsap-core"\nto = \["codex"\]\n$/,
    );

    const body = (await box.read('loadout.toml')).slice(TARGETS.length);
    const reconciled = await box.reconcile(body, state);
    assert.deepEqual(actions(reconciled.plan), ['ok skill:gsap-core@codex']);
  });

  test('an identical copy in another target is parked in backups and linked to the same source', async () => {
    await box.write('.claude/skills/gsap-core/SKILL.md', '# gsap core\n');
    await box.write('.claude/skills/gsap-core/refs/api.md', 'api\n');

    let state = await applyAdopt(
      await planAdopt('~/.codex/skills/gsap-core', options),
      options,
      emptyState(),
    );
    const second = await planAdopt('~/.claude/skills/gsap-core', options);
    assert.equal(second.mode, 'link-to-identical');
    assert.equal(second.manifestChange, 'extend-to');
    state = await applyAdopt(second, options, state);

    assert.equal(
      await readlink(box.path('.claude/skills/gsap-core')),
      box.path('config/skills/gsap-core'),
    );
    assert.deepEqual(await readdir(box.path('backups/claude/gsap-core')), ['SKILL.md', 'refs']);
    assert.match(await box.read('loadout.toml'), /to = \["codex", "claude"\]/);
    assert.equal(Object.keys(state.units).length, 2);
  });

  test('a different copy with the same name is refused before anything moves', async () => {
    await box.write('config/skills/gsap-core/SKILL.md', '# something else\n');
    await assert.rejects(planAdopt('~/.codex/skills/gsap-core', options), /different content/);
    assert.ok((await lstat(box.path('.codex/skills/gsap-core'))).isDirectory());
  });

  test('symlinks and paths outside target skill/command folders are refused', async () => {
    await mkdir(box.path('elsewhere/x'), { recursive: true });
    await assert.rejects(planAdopt('~/elsewhere/x', options), ManifestError);
    await applyAdopt(await planAdopt('~/.codex/skills/gsap-core', options), options, emptyState());
    await assert.rejects(planAdopt('~/.codex/skills/gsap-core', options), /not a real directory/);
  });

  test('claude commands are adopted as [[command]] entries', async () => {
    await box.write('.claude/commands/list-pr.md', '# list\n');
    const plan = await planAdopt('~/.claude/commands/list-pr.md', {
      ...options,
      into: '~/config/commands',
    });
    assert.equal(plan.kind, 'command');
    assert.equal(plan.name, 'list-pr');
    await applyAdopt(plan, { ...options, into: '~/config/commands' }, emptyState());
    const manifest = parseManifest(await box.read('loadout.toml'), box.home);
    assert.equal(manifest.resources[0]!.kind, 'command');
  });
});
