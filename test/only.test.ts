import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { filterOnly, OnlyError } from '../src/only.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

const ITEMS = [
  { resource: 'skill:review', target: 'claude' },
  { resource: 'skill:review', target: 'codex' },
  { resource: 'mcp:review', target: 'claude' },
  { resource: 'hook:lint', target: 'claude' },
];

const pick = (...selectors: string[]) =>
  filterOnly(ITEMS, selectors).map((item) => `${item.resource}@${item.target}`);

describe('--only selectors', () => {
  test('kind:name, bare name, kind:*, * — each optionally @target; several are OR-ed', () => {
    assert.deepEqual(pick('skill:review'), ['skill:review@claude', 'skill:review@codex']);
    assert.deepEqual(pick('review@claude'), ['skill:review@claude', 'mcp:review@claude']);
    assert.deepEqual(pick('hook:*'), ['hook:lint@claude']);
    assert.deepEqual(pick('*@codex'), ['skill:review@codex']);
    assert.deepEqual(pick('hook:lint', 'skill:review@codex'), [
      'skill:review@codex',
      'hook:lint@claude',
    ]);
    assert.equal(filterOnly(ITEMS, undefined), ITEMS);
  });

  test('a selector matching nothing, or malformed, is an error rather than a silent no-op', () => {
    assert.throws(() => pick('skill:nope'), /--only matches nothing: skill:nope/);
    assert.throws(() => pick('skill:review', 'review@codex-work'), /review@codex-work/);
    assert.throws(() => pick('a@b@c'), OnlyError);
  });
});

describe('plan / apply --only', () => {
  let box: Sandbox;
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
      { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
    );

  beforeEach(async () => {
    box = await Sandbox.create();
    for (const name of ['review', 'ddd']) {
      await mkdir(box.path('src/skills', name), { recursive: true });
    }
    await box.write(
      'loadout.toml',
      TARGETS +
        `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude", "codex"]\n\n` +
        `[[skill]]\nname = "ddd"\nfrom = "mine"\nto = ["claude"]\n`,
    );
  });

  afterEach(() => box.dispose());

  test('applies just the selected units; the rest stays pending', async () => {
    const plan = await cli('plan', '--only', 'review@codex');
    assert.match(plan.stdout, /skill:review/);
    assert.doesNotMatch(plan.stdout, /ddd/);

    await cli('apply', '--only', 'review@codex');
    await lstat(box.path('.codex/skills/review'));
    await assert.rejects(lstat(box.path('.claude/skills/review')));
    await assert.rejects(lstat(box.path('.claude/skills/ddd')));

    const { stdout: history } = await cli('history');
    assert.match(history, /apply --only review@codex/);
    const { stdout: rest } = await cli('plan', '--json');
    assert.deepEqual(
      JSON.parse(rest).entries.map(
        (entry: any) => `${entry.action} ${entry.resource}@${entry.target}`,
      ),
      ['create skill:review@claude', 'ok skill:review@codex', 'create skill:ddd@claude'],
    );
  });

  test('an unknown selector exits 64 and writes nothing', async () => {
    await assert.rejects(cli('apply', '--only', 'skill:nope'), (error: any) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /--only matches nothing: skill:nope/);
      return true;
    });
    await assert.rejects(lstat(box.path('state.json')));
  });
});
