import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { LockError, withLock } from '../src/lock.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

test('concurrent toggles from separate processes never lose ownership records', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const name of names) await mkdir(box.path('src/skills', name), { recursive: true });
  await box.write(
    'loadout.toml',
    TARGETS + names.map((n) => `[[skill]]\nname = "${n}"\nfrom = "mine"\nto = []\n`).join('\n'),
  );

  await Promise.all(
    names.map((name) =>
      run(
        process.execPath,
        [
          BIN,
          'toggle',
          name,
          'claude',
          'on',
          '--manifest',
          box.path('loadout.toml'),
          '--state',
          box.path('state/state.json'),
        ],
        { env: { ...process.env, HOME: box.home } },
      ),
    ),
  );

  const state = JSON.parse(await readFile(box.path('state/state.json'), 'utf8'));
  assert.equal(Object.keys(state.units).length, names.length);
  const manifest = await box.read('loadout.toml');
  assert.equal(manifest.match(/to = \["claude"\]/g)?.length, names.length);
});

test('a lock held by a live process times out with a clear message', async () => {
  const dir = box.path('state');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'loadout.lock'),
    JSON.stringify({ pid: process.pid, command: 'apply', since: 'now' }),
  );
  await assert.rejects(
    withLock(dir, 'toggle', async () => 'ran', 150),
    (error: unknown) => error instanceof LockError && /pid \d+, "apply"/.test(error.message),
  );
});

test('a stale lock from a dead process is taken over', async () => {
  const dir = box.path('state');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'loadout.lock'),
    JSON.stringify({ pid: 2 ** 22 + 12345, command: 'apply', since: 'then' }),
  );
  assert.equal(await withLock(dir, 'toggle', async () => 'ran', 150), 'ran');
});

test('the lock is released even when the command throws', async () => {
  const dir = box.path('state');
  await assert.rejects(
    withLock(dir, 'apply', async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await withLock(dir, 'apply', async () => 'again', 150), 'again');
});
