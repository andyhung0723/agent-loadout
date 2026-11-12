import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Content hash of a file or folder tree (names, file bytes, symlink targets). With `follow`,
 * symlinks hash as what they point to, matching a copy made with dereferencing.
 */
export async function treeHash(root: string, { follow = false } = {}): Promise<string> {
  const hash = createHash('sha256');
  const info = follow ? stat : lstat;
  if ((await info(root)).isFile()) return hash.update(await readFile(root)).digest('hex');

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      const relative = `${prefix}/${name}`;
      const full = path.join(dir, name);
      const entry = await info(full);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await walk(full, relative);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\n`).update(await readFile(full));
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${relative}->${await readlink(full)}\n`);
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}
