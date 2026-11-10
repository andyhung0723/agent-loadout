import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { LockError, withLock } from '../src/lock.ts';
import { Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

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
