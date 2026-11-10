import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface OwnedLink {
  resource: string;
  target: string;
  source: string;
}

export interface State {
  version: 1;
  links: Record<string, OwnedLink>;
}

export function emptyState(): State {
  return { version: 1, links: {} };
}

export async function loadState(file: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as State;
    if (parsed.version !== 1) throw new Error(`unsupported state version in ${file}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveState(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n');
  await rename(temp, file);
}
