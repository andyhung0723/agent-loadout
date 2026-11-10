import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { scanSharedCodexSkills } from '../src/shared.ts';
import { toStatusMatrix } from '../src/status.ts';
import { toggleInManifest } from '../src/toggle.ts';
import { findUnmanaged } from '../src/unmanaged.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  await mkdir(box.path('.agents/skills/deck'), { recursive: true });
  await mkdir(box.path('src/skills/review'), { recursive: true });
});

afterEach(() => box.dispose());

const DECK = `[[skill]]\nname = "deck"\npath = "~/.agents/skills/deck"\nto = ["claude"]\n`;

test('a skill in ~/.agents/skills shows as inherited on every codex target, off elsewhere', async () => {
  const manifest = box.manifest(DECK);
  const matrix = toStatusMatrix(
    manifest,
    await box.plan(DECK),
    await scanSharedCodexSkills(manifest),
  );
  assert.deepEqual(matrix.rows[0]!.cells, {
    claude: 'pending',
    'claude-work': 'off',
    codex: 'inherited',
  });
});

test('enabling it per profile as well warns about the duplicate load', async () => {
  const body = DECK.replace('["claude"]', '["claude", "codex"]');
  const manifest = box.manifest(body);
  const matrix = toStatusMatrix(
    manifest,
    await box.plan(body),
    await scanSharedCodexSkills(manifest),
  );
  assert.equal(matrix.rows[0]!.cells.codex, 'pending');
  assert.ok(
    matrix.warnings.some((warning) =>
      /skill:deck on codex is also in .*\.agents\/skills\/deck/.test(warning),
    ),
  );
});

test('toggle refuses to switch an inherited skill off, and treats on as already on', async () => {
  await box.write('loadout.toml', TARGETS + DECK);
  await assert.rejects(
    toggleInManifest(
      box.path('loadout.toml'),
      { resource: 'deck', target: 'codex', enabled: false },
      box.home,
    ),
    /loaded by every Codex profile from .*can't be switched off for codex alone/,
  );
  const { result } = await toggleInManifest(
    box.path('loadout.toml'),
    { resource: 'deck', target: 'codex', enabled: true },
    box.home,
  );
  assert.equal(result.changed, false);
  assert.match(result.inheritedFrom ?? '', /\.agents\/skills\/deck$/);
  assert.equal(await box.read('loadout.toml'), TARGETS + DECK);
});

test('shared skills not covered by the manifest are listed as unmanaged', async () => {
  await symlink(box.path('src/skills/review'), box.path('.agents/skills/review'));
  const manifest = box.manifest(DECK);
  const items = await findUnmanaged(manifest, { resolve: async () => undefined }, box.home);
  const shared = items.filter((item) => item.target === 'codex (shared)');
  assert.deepEqual(
    shared.map((item) => item.name),
    ['review'],
  );
});

test('[shared] codex_skills overrides the default folder', () => {
  const manifest = box.manifest(`[shared]\ncodex_skills = ["~/elsewhere"]\n`);
  assert.deepEqual(manifest.shared?.codexSkills, [box.path('elsewhere')]);
});
