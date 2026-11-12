import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { AgentSource } from '../agent-render.ts';
import { importHooks, mcpDefinition, mcpServer, readJson, type Note } from '../import-common.ts';
import type { Definition } from '../importer.ts';
import { gitExcludeFile, type Layout } from '../layout.ts';
import {
  configKey,
  detectClaudeJson,
  isProject,
  ManifestError,
  type McpResource,
  type Resource,
  type Target,
} from '../manifest.ts';
import { isPlainObject, withoutUndefined, type Plain } from '../values.ts';
import { hookGroup } from './hooks.ts';
import type { Placement, ToolAdapter, ValueKind } from './types.ts';

interface ClaudeLayout extends Layout {
  /** hooks, enabledPlugins, extraKnownMarketplaces */
  settings?: string;
  /** MCP servers: file + pointer to the object holding them. */
  mcp?: { file: string; pointer: string[] };
}

function claudeLayout(target: Target): ClaudeLayout {
  const at = (...parts: string[]) => path.join(target.dir, ...parts);
  if (!isProject(target)) {
    return {
      instructions: at('CLAUDE.md'),
      skills: at('skills'),
      commands: at('commands'),
      agents: at('agents'),
      settings: at('settings.json'),
      mcp: { file: target.claudeJson ?? at('.claude.json'), pointer: ['mcpServers'] },
      copy: false,
      committed: false,
    };
  }
  const project = {
    skills: at('.claude', 'skills'),
    commands: at('.claude', 'commands'),
    agents: at('.claude', 'agents'),
  };
  if (target.visibility === 'shared') {
    return {
      ...project,
      instructions: at('CLAUDE.md'),
      settings: at('.claude', 'settings.json'),
      mcp: { file: at('.mcp.json'), pointer: ['mcpServers'] },
      copy: true,
      committed: true,
    };
  }
  // Local: CLAUDE.local.md, settings.local.json, and MCP servers in the profile's .claude.json
  // under projects[<root>] (Claude Code's "local" MCP scope). Without a profile there is no
  // .claude.json to use, so MCP is unsupported there.
  const gitExclude = gitExcludeFile(target.dir);
  return {
    ...project,
    instructions: at('CLAUDE.local.md'),
    settings: at('.claude', 'settings.local.json'),
    ...(target.claudeJson
      ? { mcp: { file: target.claudeJson, pointer: ['projects', target.dir, 'mcpServers'] } }
      : {}),
    copy: false,
    ...(gitExclude ? { gitExclude } : {}),
    committed: false,
  };
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export const claude: ToolAdapter = {
  name: 'claude',
  displayName: 'Claude',
  detectProfile: (dir, home) => ({ claudeJson: detectClaudeJson(dir, home) }),
  layout: claudeLayout,

  holds(kind: ValueKind, target: Target) {
    const layout = claudeLayout(target);
    return kind === 'mcp' ? layout.mcp !== undefined : layout.settings !== undefined;
  },

  place(kind: ValueKind, resource: Resource, target: Target): Placement[] {
    const layout = claudeLayout(target);
    const settings = layout.settings!;
    const key = configKey(resource);
    switch (resource.kind) {
      case 'hook': {
        const group = hookGroup(resource, 'claude');
        return resource.events.map((event) => ({
          locator: { driver: 'json-item', file: settings, pointer: ['hooks', event] },
          value: group,
        }));
      }
      case 'mcp': {
        const { file, pointer } = layout.mcp!;
        return [
          {
            locator: { driver: 'json-key', file, pointer: [...pointer, key] },
            value: mcpValue(resource),
          },
        ];
      }
      case 'plugin':
        return [
          {
            locator: { driver: 'json-key', file: settings, pointer: ['enabledPlugins', key] },
            value: resource.enabled,
          },
        ];
      case 'marketplace':
        return [
          {
            locator: {
              driver: 'json-key',
              file: settings,
              pointer: ['extraKnownMarketplaces', key],
            },
            value: resource.config,
          },
        ];
      default:
        throw new Error(`internal: ${kind} is not a value kind`);
    }
  },

  agent: {
    extension: 'md',
    render(agent: AgentSource) {
      const frontmatter = { ...agent.shared, ...agent.claudeOnly, ...agent.perTool.claude };
      return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${agent.body}\n`;
    },
    parse(text: string) {
      const match = FRONTMATTER.exec(text);
      if (!match) throw new ManifestError('Claude agent file has no YAML frontmatter');
      const fields: unknown = parse(match[1]!);
      if (!isPlainObject(fields))
        throw new ManifestError('Claude agent frontmatter must be a mapping');
      return { fields, body: match[2]!.trim() };
    },
  },

  async importSettings(target: Target, home: string, note: Note): Promise<Definition[]> {
    const layout = claudeLayout(target);
    const settings = await readJson(layout.settings!);
    const state = await readJson(layout.mcp!.file);
    return [
      ...importHooks(settings.hooks, layout.settings!, home, note),
      ...importMcp(state.mcpServers, home),
      ...importPlugins(settings.enabledPlugins),
      ...importMarketplaces(settings.extraKnownMarketplaces),
    ];
  },
};

function mcpValue(resource: McpResource): Plain {
  const { command, args, env, url, headers } = resource.server;
  const base = url ? { type: 'http', url, headers } : { command, args, env };
  return withoutUndefined({ ...base, ...resource.overrides.claude });
}

function importMcp(value: unknown, home: string): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!isPlainObject(raw)) return [];
    const { type, command, args, env, url, headers, ...rest } = raw;
    const server = mcpServer({ command, args, env, url, headers }, home);
    const inferredType = server.url ? 'http' : undefined;
    const overrides = withoutUndefined({ ...(type !== inferredType ? { type } : {}), ...rest });
    return [mcpDefinition(name, server, { claude: overrides })];
  });
}

function importPlugins(value: unknown): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, enabled]): Definition[] =>
    typeof enabled === 'boolean' ? [{ kind: 'plugin', name, enabled }] : [],
  );
}

function importMarketplaces(value: unknown): Definition[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([name, config]): Definition[] =>
    isPlainObject(config) ? [{ kind: 'marketplace', name, config }] : [],
  );
}
