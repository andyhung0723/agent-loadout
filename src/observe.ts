import { access, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

export type Observed = { type: 'missing' } | { type: 'link'; to: string } | { type: 'other' };

export async function observe(dest: string): Promise<Observed> {
  try {
    const stats = await lstat(dest);
    if (!stats.isSymbolicLink()) return { type: 'other' };
    return { type: 'link', to: path.resolve(path.dirname(dest), await readlink(dest)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { type: 'missing' };
    throw error;
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
