import assert from 'node:assert/strict';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ManifestError } from '../src/manifest.ts';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;
const skill = (target: string, name: string) => box.path(`.${target}`, 'skills', name);
const review = (to: string) => `[[skill]]\nname = "review"\nfrom = "mine"\nto = ${to}\n`;

beforeEach(async () => {
  box = await Sandbox.create();
  for (const name of ['review', 'ddd', 'deck']) {
    await mkdir(box.path('src/skills', name), { recursive: true });
  }
  await box.write('src/RULES.md', '# rules\n');
  await box.write('src/commands/list-pr.md', '# list\n');
});

afterEach(() => box.dispose());

describe('selectors', () => {
  test('tag, tool, wildcard and exclusion pick the expected targets', async () => {
    const plan = await box.plan(`
${review('["*", "!codex"]')}
[[skill]]
name = "ddd"
from = "mine"
to = ["tag:personal"]

[[skill]]
name = "deck"
from = "mine"
to = ["tool:codex"]
`);
    assert.deepEqual(actions(plan), [
      'create skill:ddd@claude',
      'create skill:ddd@codex',
      'create skill:deck@codex',
      'create skill:review@claude',
      'create skill:review@claude-work',
    ]);
  });

  test('unknown target name is a manifest error', () => {
    assert.throws(() => box.manifest(review('["nope"]')), ManifestError);
  });
});

describe('link reconcile', () => {
  test('creates symlinks and records ownership; second run is a no-op', async () => {
    const first = await box.reconcile(review('["claude"]'));
    assert.equal(await readlink(skill('claude', 'review')), box.path('src/skills/review'));

    const second = await box.plan(review('["claude"]'), first.state);
    assert.deepEqual(actions(second), ['ok skill:review@claude']);
  });

  test('removing a target from "to" removes only the owned link', async () => {
    const first = await box.reconcile(review('["claude", "codex"]'));
    const second = await box.reconcile(review('["claude"]'), first.state);
    assert.deepEqual(actions(second.plan), ['ok skill:review@claude', 'remove skill:review@codex']);
    await assert.rejects(lstat(skill('codex', 'review')));
  });

  test('pointing an owned skill at a new source replaces the link', async () => {
    const first = await box.reconcile(review('["claude"]'));
    const moved = `[[skill]]\nname = "review"\npath = "~/src/skills/ddd"\nto = ["claude"]\n`;
    const second = await box.reconcile(moved, first.state);
    assert.deepEqual(actions(second.plan), ['replace skill:review@claude']);
    assert.equal(await readlink(skill('claude', 'review')), box.path('src/skills/ddd'));
  });

  test('pre-existing identical symlink is adopted, not rewritten', async () => {
    await symlink(box.path('src/skills/review'), skill('claude', 'review'));
    const { plan } = await box.reconcile(review('["claude"]'));
    assert.deepEqual(actions(plan), ['adopt skill:review@claude']);
  });

  test('real directory or foreign symlink is a conflict and left untouched', async () => {
    await mkdir(skill('claude', 'review'));
    await symlink('/somewhere/else', skill('codex', 'review'));
    const { plan, state } = await box.reconcile(review('["claude", "codex"]'));
    assert.deepEqual(actions(plan), [
      'conflict skill:review@claude',
      'conflict skill:review@codex',
    ]);
    assert.ok((await lstat(skill('claude', 'review'))).isDirectory());
    assert.equal(await readlink(skill('codex', 'review')), '/somewhere/else');
    assert.deepEqual(state.units, {});
  });

  test('owned link edited by hand is forgotten when dropped, never deleted', async () => {
    const first = await box.reconcile(review('["claude"]'));
    await rm(skill('claude', 'review'));
    await symlink('/hand/edited', skill('claude', 'review'));
    const second = await box.reconcile(
      `[[skill]]\nname = "ddd"\nfrom = "mine"\nto = ["codex"]\n`,
      first.state,
    );
    assert.ok(actions(second.plan).includes('forget skill:review@claude'));
    assert.equal(await readlink(skill('claude', 'review')), '/hand/edited');
  });

  test('missing source is reported and never linked', async () => {
    const { plan } = await box.reconcile(
      `[[skill]]\nname = "ghost"\nfrom = "mine"\nto = ["claude"]\n`,
    );
    assert.deepEqual(actions(plan), ['missing-source skill:ghost@claude']);
  });

  test('instructions map to CLAUDE.md / AGENTS.md per tool', async () => {
    await box.reconcile(
      `[[instructions]]\nname = "shared"\npath = "~/src/RULES.md"\nto = ["claude", "codex"]\n`,
    );
    assert.equal(await readlink(box.path('.claude/CLAUDE.md')), box.path('src/RULES.md'));
    assert.equal(await readlink(box.path('.codex/AGENTS.md')), box.path('src/RULES.md'));
  });

  test('commands link into claude only; codex is unsupported, not an error', async () => {
    const { plan } = await box.reconcile(
      `[[command]]\nname = "list-pr"\npath = "~/src/commands/list-pr.md"\nto = ["*"]\n`,
    );
    assert.deepEqual(actions(plan), [
      'create command:list-pr@claude',
      'create command:list-pr@claude-work',
    ]);
    assert.equal(
      await readlink(box.path('.claude/commands/list-pr.md')),
      box.path('src/commands/list-pr.md'),
    );
  });
});

describe('state migration', () => {
  test('v1 state is read as owned link units', async () => {
    const { loadState } = await import('../src/state.ts');
    const dest = skill('claude', 'review');
    await symlink(box.path('src/skills/review'), dest);
    await box.write(
      'state.json',
      JSON.stringify({
        version: 1,
        links: {
          [dest]: {
            resource: 'skill:review',
            target: 'claude',
            source: box.path('src/skills/review'),
          },
        },
      }),
    );
    const state = await loadState(path.join(box.home, 'state.json'));
    const plan = await box.plan(review('["claude"]'), state);
    assert.deepEqual(actions(plan), ['ok skill:review@claude']);
  });
});
