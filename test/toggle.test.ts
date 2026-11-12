import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ManifestError } from '../src/manifest.ts';
import { nextSelectors, toggleInManifest } from '../src/toggle.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  for (const name of ['review', 'ddd'])
    await mkdir(box.path('src/skills', name), { recursive: true });
});

afterEach(() => box.dispose());

describe('nextSelectors', () => {
  const targets = () => box.manifest('').targets;

  test('off on a wildcard adds an exclusion; on again removes it', () => {
    const off = nextSelectors(['*'], targets(), 'claude-work', false);
    assert.deepEqual(off, ['*', '!claude-work']);
    assert.deepEqual(nextSelectors(off, targets(), 'claude-work', true), ['*']);
  });

  test('explicit names are added and removed directly', () => {
    assert.deepEqual(nextSelectors(['claude'], targets(), 'codex', true), ['claude', 'codex']);
    assert.deepEqual(nextSelectors(['claude', 'codex'], targets(), 'claude', false), ['codex']);
    assert.deepEqual(nextSelectors(['codex'], targets(), 'codex', false), []);
  });

  test('tag selectors get a targeted exclusion instead of being rewritten', () => {
    assert.deepEqual(nextSelectors(['tag:personal'], targets(), 'codex', false), [
      'tag:personal',
      '!codex',
    ]);
  });

  test('no-op when already in the requested state (same array instance)', () => {
    const selectors = ['claude'];
    assert.equal(nextSelectors(selectors, targets(), 'claude', true), selectors);
  });

  test('enabling a target excluded by a pattern exclusion is refused', () => {
    assert.throws(
      () => nextSelectors(['*', '!tag:work'], targets(), 'claude-work', true),
      ManifestError,
    );
  });
});

describe('toggleInManifest', () => {
  const MANIFEST =
    TARGETS +
    `
# my favourite skills
[[skill]]
name = "review"
from = "mine"   # shared toolkit
to = ["*"]

[[skill]]
name = "ddd"
from = "mine"
to = [
  "claude",
]
`;

  test('rewrites only the "to" line of the matching entry, keeping comments and layout', async () => {
    await box.write('loadout.toml', MANIFEST);
    await toggleInManifest(
      box.path('loadout.toml'),
      { resource: 'review', target: 'codex', enabled: false },
      box.home,
    );
    await toggleInManifest(
      box.path('loadout.toml'),
      { resource: 'skill:ddd', target: 'codex', enabled: true },
      box.home,
    );
    assert.equal(
      await box.read('loadout.toml'),
      MANIFEST.replace('to = ["*"]', 'to = ["*", "!codex"]').replace(
        'to = [\n  "claude",\n]',
        'to = ["claude", "codex"]',
      ),
    );
  });

  test('unsupported kind × tool is refused', async () => {
    await box.write(
      'loadout.toml',
      TARGETS + `[[command]]\nname = "x"\npath = "~/x.md"\nto = []\n`,
    );
    await assert.rejects(
      toggleInManifest(
        box.path('loadout.toml'),
        { resource: 'x', target: 'codex', enabled: true },
        box.home,
      ),
      /command:x has no place on codex \(codex profile\)/,
    );
  });
});

describe('loadout toggle (CLI)', () => {
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
      { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
    );

  test('applies only the toggled resource and reports a restart hint', async () => {
    await box.write(
      'loadout.toml',
      TARGETS +
        `[[skill]]\nname = "review"\nfrom = "mine"\nto = []\n\n[[skill]]\nname = "ddd"\nfrom = "mine"\nto = ["claude"]\n`,
    );

    const { stdout } = await cli('toggle', 'review', 'claude-work', 'on');
    assert.match(stdout, /skill:review → claude-work: on/);
    assert.match(stdout, /Restart sessions on claude-work/);
    assert.equal(
      await readlink(box.path('.claude-work/skills/review')),
      box.path('src/skills/review'),
    );
    await assert.rejects(
      lstat(box.path('.claude/skills/ddd')),
      'unrelated pending change untouched',
    );

    await cli('toggle', 'review', 'claude-work', 'off');
    await assert.rejects(lstat(box.path('.claude-work/skills/review')));
  });

  test('refuses to remove something it does not own', async () => {
    await symlink(box.path('src/skills/review'), box.path('.codex/skills/review'));
    await box.write(
      'loadout.toml',
      TARGETS + `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["codex"]\n`,
    );
    await cli('toggle', 'review', 'codex', 'off');
    assert.ok((await lstat(box.path('.codex/skills/review'))).isSymbolicLink());
  });

  test('--json output is machine-readable', async () => {
    await box.write(
      'loadout.toml',
      TARGETS + `[[skill]]\nname = "review"\nfrom = "mine"\nto = []\n`,
    );
    const { stdout } = await cli('toggle', 'skill:review', 'codex', 'on', '--json');
    const output = JSON.parse(stdout);
    assert.equal(output.toggle.after[0], 'codex');
    assert.equal(output.results[0].entry.action, 'create');
    assert.equal(output.restart, 'codex');
  });
});
