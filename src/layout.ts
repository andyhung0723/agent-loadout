import { statSync } from 'node:fs';
import path from 'node:path';
import { isProject, type Kind, type Target } from './manifest.ts';

/**
 * Where each kind of resource goes for one target. User targets are a profile folder
 * (`~/.claude-work`, `$CODEX_HOME`); project targets are a repository, split into what stays on
 * this machine (`local`) and what the repository commits (`shared`).
 *
 * A missing entry means the target can't hold that kind: Codex has no personal layer inside a
 * repository, and paths that aren't documented are left out rather than guessed.
 */
export interface Layout {
  instructions?: string;
  skills?: string;
  commands?: string;
  agents?: string;
  /** Claude settings file for hooks, enabledPlugins, extraKnownMarketplaces. */
  claudeSettings?: string;
  /** Claude MCP servers: file + pointer to the object holding them. */
  claudeMcp?: { file: string; pointer: string[] };
  codexConfig?: string;
  codexHooks?: string;
  /** Skills, commands and instructions are copied rather than linked (committed files). */
  copy: boolean;
  /** Git's exclude file, for local links that must not show up as untracked files. */
  gitExclude?: string;
  /** Resource values may not embed resolved secrets (the files are committed). */
  committed: boolean;
}

export function layoutOf(target: Target): Layout {
  if (!isProject(target)) return userLayout(target);
  return target.visibility === 'shared' ? sharedProjectLayout(target) : localProjectLayout(target);
}

function userLayout(target: Target): Layout {
  const at = (name: string) => path.join(target.dir, name);
  if (target.tool === 'claude') {
    return {
      instructions: at('CLAUDE.md'),
      skills: at('skills'),
      commands: at('commands'),
      agents: at('agents'),
      claudeSettings: at('settings.json'),
      claudeMcp: { file: target.claudeJson ?? at('.claude.json'), pointer: ['mcpServers'] },
      copy: false,
      committed: false,
    };
  }
  return {
    instructions: at('AGENTS.md'),
    skills: at('skills'),
    agents: at('agents'),
    codexConfig: at('config.toml'),
    codexHooks: at('hooks.json'),
    copy: false,
    committed: false,
  };
}

function localProjectLayout(target: Target): Layout {
  const at = (...parts: string[]) => path.join(target.dir, ...parts);
  const gitExclude = gitExcludeFile(target.dir);
  if (target.tool === 'claude') {
    return {
      instructions: at('CLAUDE.local.md'),
      skills: at('.claude', 'skills'),
      commands: at('.claude', 'commands'),
      agents: at('.claude', 'agents'),
      claudeSettings: at('.claude', 'settings.local.json'),
      ...(target.claudeJson
        ? {
            claudeMcp: {
              file: target.claudeJson,
              pointer: ['projects', target.dir, 'mcpServers'],
            },
          }
        : {}),
      copy: false,
      ...(gitExclude ? { gitExclude } : {}),
      committed: false,
    };
  }
  return {
    skills: at('.agents', 'skills'),
    copy: false,
    ...(gitExclude ? { gitExclude } : {}),
    committed: false,
  };
}

function sharedProjectLayout(target: Target): Layout {
  const at = (...parts: string[]) => path.join(target.dir, ...parts);
  if (target.tool === 'claude') {
    return {
      instructions: at('CLAUDE.md'),
      skills: at('.claude', 'skills'),
      commands: at('.claude', 'commands'),
      agents: at('.claude', 'agents'),
      claudeSettings: at('.claude', 'settings.json'),
      claudeMcp: { file: at('.mcp.json'), pointer: ['mcpServers'] },
      copy: true,
      committed: true,
    };
  }
  return {
    instructions: at('AGENTS.md'),
    skills: at('.agents', 'skills'),
    codexConfig: at('.codex', 'config.toml'),
    codexHooks: at('.codex', 'hooks.json'),
    copy: true,
    committed: true,
  };
}

/** Only a plain checkout (`.git` is a folder); worktrees and non-git folders get no exclude. */
function gitExcludeFile(root: string): string | undefined {
  try {
    return statSync(path.join(root, '.git')).isDirectory()
      ? path.join(root, '.git', 'info', 'exclude')
      : undefined;
  } catch {
    return undefined;
  }
}

/** The layout entry a kind needs on this tool. */
export function supports(kind: Kind, target: Target): boolean {
  const layout = layoutOf(target);
  switch (kind) {
    case 'instructions':
      return layout.instructions !== undefined;
    case 'skill':
      return layout.skills !== undefined;
    case 'command':
      return layout.commands !== undefined;
    case 'agent':
      return layout.agents !== undefined;
    case 'hook':
      return target.tool === 'claude'
        ? layout.claudeSettings !== undefined
        : layout.codexHooks !== undefined;
    case 'mcp':
      return target.tool === 'claude'
        ? layout.claudeMcp !== undefined
        : layout.codexConfig !== undefined;
    case 'plugin':
      return target.tool === 'claude'
        ? layout.claudeSettings !== undefined
        : layout.codexConfig !== undefined;
    case 'marketplace':
      return target.tool === 'claude' && layout.claudeSettings !== undefined;
  }
}
