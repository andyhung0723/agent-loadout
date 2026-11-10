import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_MS = 100;

export class LockError extends Error {
  override name = 'LockError';
}

interface Holder {
  pid: number;
  command: string;
  since: string;
}

export async function withLock<T>(
  stateDir: string,
  command: string,
  run: () => Promise<T>,
  timeoutMs = lockTimeout(),
): Promise<T> {
  const file = path.join(stateDir, 'loadout.lock');
  await acquire(file, command, timeoutMs);
  try {
    return await run();
  } finally {
    await rm(file, { force: true });
  }
}

async function acquire(file: string, command: string, timeoutMs: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  const holder: Holder = { pid: process.pid, command, since: new Date().toISOString() };
  const draft = `${file}.${process.pid}.draft`;
  await writeFile(draft, JSON.stringify(holder), { mode: 0o600 });

  try {
    for (;;) {
      if (await linkExclusive(draft, file)) return;
      await waitOrTakeOver(file, deadline);
    }
  } finally {
    await rm(draft, { force: true });
  }
}

async function linkExclusive(draft: string, file: string): Promise<boolean> {
  try {
    await link(draft, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function waitOrTakeOver(file: string, deadline: number): Promise<void> {
  const raw = await readRaw(file);
  const holder = parseHolder(raw);
  if (holder === null || !isAlive(holder.pid)) {
    if ((await readRaw(file)) === raw) await rm(file, { force: true });
    return;
  }
  if (Date.now() >= deadline) {
    throw new LockError(
      `another loadout is running (pid ${holder.pid}, "${holder.command}" since ${holder.since})`,
    );
  }
  await sleep(RETRY_MS);
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function parseHolder(raw: string | null): Holder | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Holder;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockTimeout(): number {
  const fromEnv = Number(process.env.LOADOUT_LOCK_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}
