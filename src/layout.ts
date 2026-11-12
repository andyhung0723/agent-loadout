import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the link-like kinds go for one target, plus how its files may be written. Each tool
 * adapter (src/tools/*) builds one for profile folders and for local/shared repositories. A
 * missing path means the target can't hold that kind: undocumented locations are left out
 * rather than guessed.
 */
export interface Layout {
  instructions?: string;
  skills?: string;
  commands?: string;
  agents?: string;
  /** Skills, commands and instructions are copied rather than linked (committed files). */
  copy: boolean;
  /** Git's exclude file, for files loadout puts in a repository that must stay untracked. */
  gitExclude?: string;
  /** Files are committed to a repository: values may not embed resolved secrets. */
  committed: boolean;
}

/** Only a plain checkout (`.git` is a folder); worktrees and non-git folders get no exclude. */
export function gitExcludeFile(root: string): string | undefined {
  try {
    return statSync(path.join(root, '.git')).isDirectory()
      ? path.join(root, '.git', 'info', 'exclude')
      : undefined;
  } catch {
    return undefined;
  }
}
