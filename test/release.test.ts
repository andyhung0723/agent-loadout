import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { planRelease } from '../src/release.ts';
import { emptyState } from '../src/state.ts';
import { actions, Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  await mkdir(box.path('src/skills/review'), { recursive: true });
});

afterEach(() => box.dispose());

const cli = (...args: string[]) =>
  run(
    process.execPath,
    [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
    { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
  );

const SKILL = (to: string) =>
  `# skills I use\n[[skill]]\nname = "review"\nfrom = "mine"  # keep\nto = ${to}\n`;

const HOOK = `
[[hook]]
name = "lint"
events = ["PreToolUse"]
matcher = "Bash"
command = "lint"
to = ["claude"]
`;

async function setUp(body: string) {
  await box.write('loadout.toml', TARGETS + body);
  await cli('apply');
}

const body = async () => (await box.read('loadout.toml')).slice(TARGETS.length);
const owned = async () =>
  Object.values((await box.readJson('state.json')).units).map(
    (unit: any) => `${unit.resource}@${unit.target}`,
  );

describe('release', () => {
  test('one target: leaves "to", forgets ownership, keeps the link; nothing else changes', async () => {
    await setUp(SKILL('["claude", "claude-work"]'));

    const { stdout } = await cli('release', 'review', 'claude-work');
    assert.match(stdout, /released skill:review on claude-work/);
    assert.match(stdout, /claude-work: .*\.claude-work\/skills\/review/);

    assert.equal(await body(), SKILL('["claude"]'), 'only the "to" line changed');
    assert.deepEqual(await owned(), ['skill:review@claude']);
    assert.equal(
      await readlink(box.path('.claude-work/skills/review')),
      box.path('src/skills/review'),
    );

    const { stdout: plan } = await cli('plan');
    assert.doesNotMatch(plan, /remove/);
  });

  test('no target: off everywhere, values stay in the config files', async () => {
    await box.write('.claude/settings.json', '{"effortLevel": "high"}');
    await setUp(HOOK);
    const settings = await box.read('.claude/settings.json');

    await cli('release', 'hook:lint');

    assert.match(await body(), /to = \[\]/);
    assert.deepEqual(await owned(), []);
    assert.equal(await box.read('.claude/settings.json'), settings);
    assert.deepEqual(actions(await box.plan(await body())), []);
  });

  test('restore takes ownership back and restores the manifest', async () => {
    await setUp(SKILL('["*"]'));
    await cli('release', 'review', 'codex');
    assert.equal(await body(), SKILL('["*", "!codex"]'));

    const { stdout } = await cli('restore', 'latest');
    assert.match(stdout, /Manifest restored/);
    assert.equal(await body(), SKILL('["*"]'));
    assert.equal((await owned()).length, 3);
    const { stdout: plan } = await cli('plan');
    assert.doesNotMatch(plan, /create|adopt|remove/);
  });

  test('--dry-run writes nothing', async () => {
    await setUp(SKILL('["claude"]'));
    const state = await box.read('state.json');
    const { stdout } = await cli('release', 'review', '--dry-run');
    assert.match(stdout, /would release skill:review on claude/);
    assert.equal(await body(), SKILL('["claude"]'));
    assert.equal(await box.read('state.json'), state);
  });

  test('a target the resource is not enabled on is refused', async () => {
    await box.write('loadout.toml', TARGETS + SKILL('["claude"]'));
    await assert.rejects(
      planRelease(
        box.path('loadout.toml'),
        emptyState(),
        { resource: 'review', targets: ['codex'] },
        box.home,
      ),
      /not enabled on codex/,
    );
  });

  test('a skill Codex inherits from ~/.agents/skills is refused with the reason', async () => {
    await mkdir(box.path('.agents/skills/review'), { recursive: true });
    await box.write('loadout.toml', TARGETS + SKILL('["claude"]'));
    await assert.rejects(
      planRelease(
        box.path('loadout.toml'),
        emptyState(),
        { resource: 'review', targets: ['codex'] },
        box.home,
      ),
      /from the shared folder/,
    );
  });
});
