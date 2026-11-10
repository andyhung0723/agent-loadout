import path from 'node:path';
import type { LinkKind, Target, Tool } from './manifest.ts';

const INSTRUCTIONS_FILE: Record<Tool, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
};

export function skillsDir(target: Target): string {
  return path.join(target.dir, 'skills');
}

export function instructionsPath(target: Target): string {
  return path.join(target.dir, INSTRUCTIONS_FILE[target.tool]);
}

export function linkDestination(kind: LinkKind, name: string, target: Target): string {
  switch (kind) {
    case 'skill':
      return path.join(skillsDir(target), name);
    case 'instructions':
      return instructionsPath(target);
  }
}
