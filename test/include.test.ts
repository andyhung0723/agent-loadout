import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { applyAdopt, planAdopt } from '../src/adopt.ts';
import { loadManifest, ManifestError } from '../src/manifest.ts';
import { emptyState } from '../src/state.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  for (const name of ['review', 'ddd']) {
    await mkdir(box.path('src/skills', name), { recursive: true });
  }
});

afterEach(() => box.dispose());

const skill = (name: string, to: string) =>
  `# ${name} lives here\n[[skill]]\nname = "${name}"\nfrom = "mine"\nto = ${to}\n`;

const load = () => loadManifest(box.path('loadout.toml'), box.home);

describe('include', () => {
  test('resources, targets and sources merge across files; relative and ~ paths', async () => {
    await box.write('loadout.toml', `include = ["parts/work.toml", "~/shared.toml"]\n` + TARGETS);
    await box.write(
      'parts/work.toml',
      `[targets.codex-work]\ntool = "codex"\ndir = "~/.codex-work"\ntags = ["work"]\n\n` +
        skill('review', '["tag:work"]'),
    );
    await box.write('shared.toml', skill('ddd', '["claude", "codex-work"]'));

    const manifest = await load();
    assert.deepEqual(
      manifest.targets.map((target) => target.name),
      ['claude', 'claude-work', 'codex', 'codex-work'],
    );
    assert.deepEqual(
      manifest.resources.map((r) => `${r.name}:${r.to}`),
      ['review:tag:work', 'ddd:claude,codex-work'],
    );
    assert.equal(manifest.origins?.get('skill:review'), box.path('parts/work.toml'));
    assert.deepEqual(manifest.files, [
      box.path('loadout.toml'),
      box.path('parts/work.toml'),
      box.path('shared.toml'),
    ]);
  });

  test('nested includes resolve against their own folder; a file included twice loads once', async () => {
    await box.write('loadout.toml', `include = ["a/a.toml", "b.toml"]\n` + TARGETS);
    await box.write('a/a.toml', `include = ["../b.toml", "c.toml"]\n`);
    await box.write('a/c.toml', skill('review', '["claude"]'));
    await box.write('b.toml', skill('ddd', '["claude"]'));
    assert.equal((await load()).resources.length, 2);
  });

  const rejects = async (files: Record<string, string>, pattern: RegExp) => {
    for (const [file, text] of Object.entries(files)) await box.write(file, text);
    await assert.rejects(load(), (error: Error) => {
      assert.ok(error instanceof ManifestError, error.message);
      assert.match(error.message, pattern);
      return true;
    });
  };

  test('cycles, missing files, duplicates and root-only tables are clear errors', async () => {
    await rejects(
      {
        'loadout.toml': `include = ["x.toml"]\n` + TARGETS,
        'x.toml': `include = ["loadout.toml"]\n`,
      },
      /include cycle: .*loadout\.toml → .*x\.toml → .*loadout\.toml/,
    );
    await rejects(
      { 'loadout.toml': `include = ["nope.toml"]\n` + TARGETS },
      /include "nope.toml": not found/,
    );
    await rejects(
      {
        'loadout.toml': `include = ["x.toml"]\n` + TARGETS + skill('review', '["claude"]'),
        'x.toml': skill('review', '["codex"]'),
      },
      /x\.toml: duplicate resource: skill:review/,
    );
    await rejects(
      {
        'loadout.toml': `include = ["x.toml"]\n` + TARGETS,
        'x.toml': `[targets.claude]\ntool = "claude"\ndir = "~/x"\n`,
      },
      /x\.toml: duplicate target: claude/,
    );
    await rejects(
      { 'loadout.toml': `include = ["x.toml"]\n` + TARGETS, 'x.toml': `[backups]\nkeep = 1\n` },
      /x\.toml: \[backups\] is only allowed in the root manifest/,
    );
    await rejects(
      {
        'loadout.toml': `include = ["x.toml"]\n` + TARGETS,
        'x.toml': skill('review', '["nobody"]'),
      },
      /x\.toml: .*nobody/,
    );
  });
});

describe('editing commands follow the file that defines the resource', () => {
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
      { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
    );
  const ROOT = `include = ["skills.toml"]\n` + TARGETS;

  beforeEach(async () => {
    await box.write('loadout.toml', ROOT);
    await box.write('skills.toml', skill('review', '["claude"]'));
  });

  test('toggle edits only the included file; restore puts it back', async () => {
    await cli('toggle', 'review', 'codex', 'on');
    assert.equal(await box.read('skills.toml'), skill('review', '["claude", "codex"]'));
    assert.equal(await box.read('loadout.toml'), ROOT);
    assert.equal(await readlink(box.path('.codex/skills/review')), box.path('src/skills/review'));

    const { stdout } = await cli('restore', 'latest');
    assert.match(stdout, /Manifest restored/);
    assert.equal(await box.read('skills.toml'), skill('review', '["claude"]'));
    await assert.rejects(lstat(box.path('.codex/skills/review')));
  });

  test('release edits the included file', async () => {
    await cli('apply');
    await cli('release', 'review', 'claude');
    assert.equal(await box.read('skills.toml'), skill('review', '[]'));
    assert.equal(await box.read('loadout.toml'), ROOT);
  });

  test('adopt extends "to" where the entry is defined; new entries go to the root', async () => {
    await box.write('.claude-work/skills/review/SKILL.md', '');
    await box.write('src/skills/review/SKILL.md', '');
    await box.write('.codex/skills/gsap/SKILL.md', '');
    const options = {
      manifestPath: box.path('loadout.toml'),
      into: '~/src/skills',
      backupDir: box.path('backups'),
      home: box.home,
    };

    await applyAdopt(
      await planAdopt('~/.claude-work/skills/review', options),
      options,
      emptyState(),
    );
    assert.equal(await box.read('skills.toml'), skill('review', '["claude", "claude-work"]'));

    await applyAdopt(await planAdopt('~/.codex/skills/gsap', options), options, emptyState());
    assert.match(await box.read('loadout.toml'), /\[\[skill\]\]\nname = "gsap"/);
    assert.doesNotMatch(await box.read('skills.toml'), /gsap/);
  });
});
