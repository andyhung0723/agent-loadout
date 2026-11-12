import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ManifestError, parseManifest } from '../src/manifest.ts';
import { planPrune, prune, runStartedAt } from '../src/retention.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');
const NOW = new Date('2026-11-12T00:00:00.000Z');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

function runId(daysAgo: number, suffix = ''): string {
  const at = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return at.toISOString().replaceAll(':', '-') + suffix;
}

async function makeRuns(ids: string[]) {
  for (const id of ids) await mkdir(box.path('backups', id), { recursive: true });
}

const remaining = async () => (await readdir(box.path('backups'))).sort();

describe('retention', () => {
  test('run ids parse back to their start time, including same-millisecond suffixes', () => {
    assert.equal(
      runStartedAt('2026-11-12T02-48-56.410Z')?.toISOString(),
      '2026-11-12T02:48:56.410Z',
    );
    assert.equal(
      runStartedAt('2026-11-12T02-48-56.410Z-2')?.toISOString(),
      '2026-11-12T02:48:56.410Z',
    );
    assert.equal(runStartedAt('notes'), null);
    assert.equal(runStartedAt('2026-11-12'), null);
  });

  test('a run goes only when it is outside the newest N and older than the age limit', async () => {
    await makeRuns([runId(1), runId(40), runId(50), runId(60, '-2')]);
    await mkdir(box.path('backups/notes'));

    const plan = await planPrune(box.path('backups'), { keep: 2, maxAgeDays: 30 }, NOW);
    assert.deepEqual(
      plan.map((entry) => [entry.id, entry.ageDays]),
      [
        [runId(50), 50],
        [runId(60, '-2'), 60],
      ],
    );
    await prune(box.path('backups'), plan);
    assert.deepEqual(await remaining(), [runId(40), runId(1), 'notes'].sort());

    assert.deepEqual(await planPrune(box.path('backups'), { keep: 0, maxAgeDays: 30 }, NOW), [
      { id: runId(40), ageDays: 40 },
    ]);
  });

  test('a missing backups folder is nothing to prune', async () => {
    assert.deepEqual(await planPrune(box.path('nope'), { keep: 0, maxAgeDays: 0 }), []);
  });

  test('[backups] is validated; defaults apply when absent', () => {
    assert.deepEqual(parseManifest(TARGETS, box.home).backups, { keep: 20, maxAgeDays: 30 });
    assert.deepEqual(
      parseManifest(TARGETS + '[backups]\nkeep = 5\nmax_age_days = 7\n', box.home).backups,
      { keep: 5, maxAgeDays: 7 },
    );
    assert.throws(() => parseManifest(TARGETS + '[backups]\nkeep = -1\n', box.home), ManifestError);
    assert.throws(
      () => parseManifest(TARGETS + '[backups]\nkeep = 1.5\n', box.home),
      ManifestError,
    );
  });
});

describe('prune CLI', () => {
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
      { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
    );

  test('writers prune automatically but always keep the run they just made', async () => {
    await mkdir(box.path('src/skills/review'), { recursive: true });
    await box.write(
      'loadout.toml',
      TARGETS +
        '[backups]\nkeep = 0\nmax_age_days = 0\n\n[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n',
    );
    await makeRuns([runId(400), runId(500)]);

    const { stdout } = await cli('apply', '--json');
    const id = JSON.parse(stdout).run;
    assert.deepEqual(await remaining(), [id]);

    const { stdout: restored } = await cli('restore', id);
    assert.match(restored, /undo create/);
  });

  test('prune --dry-run lists without deleting; flags override the manifest', async () => {
    await box.write('loadout.toml', TARGETS);
    await makeRuns([runId(400), runId(500)]);

    const dry = await cli('prune', '--keep', '1', '--older-than', '30d', '--dry-run');
    assert.match(
      dry.stdout,
      /Would delete 1 run\(s\), keeping the newest 1 run\(s\) and anything from the last 30 day\(s\)/,
    );
    assert.equal((await remaining()).length, 2);

    await cli('prune', '--keep', '0', '--older-than', '0');
    assert.deepEqual(await remaining(), []);

    await assert.rejects(cli('prune', '--keep', 'many'), /whole number/);
  });
});
