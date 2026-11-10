import { parse, stringify } from 'yaml';
import type { Tool } from './manifest.ts';
import { tomlKey, tomlMultiline, tomlValue } from './toml-text.ts';
import { isPlainObject, type Plain } from './values.ts';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const SHARED_KEYS = ['name', 'description'] as const;

interface AgentSource {
  shared: Plain;
  claudeOnly: Plain;
  perTool: Partial<Record<Tool, Plain>>;
  body: string;
}

export function renderAgent(sourceText: string, name: string, tool: Tool): string {
  const agent = parseAgentSource(sourceText, name);
  switch (tool) {
    case 'claude':
      return renderClaudeAgent(agent);
    case 'codex':
      return renderCodexAgent(agent);
  }
}

function parseAgentSource(text: string, name: string): AgentSource {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('agent source needs YAML frontmatter (--- … ---)');

  const frontmatter: unknown = parse(match[1]!);
  if (!isPlainObject(frontmatter)) throw new Error('agent frontmatter must be a mapping');

  const { claude, codex, ...rest } = frontmatter;
  const shared: Plain = { name, ...pick(rest, SHARED_KEYS) };
  if (typeof shared.description !== 'string') throw new Error('agent needs a "description"');

  return {
    shared,
    claudeOnly: omit(rest, SHARED_KEYS),
    perTool: { claude: asPlain(claude, 'claude'), codex: asPlain(codex, 'codex') },
    body: match[2]!.trim(),
  };
}

function renderClaudeAgent(agent: AgentSource): string {
  const frontmatter = { ...agent.shared, ...agent.claudeOnly, ...agent.perTool.claude };
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${agent.body}\n`;
}

function renderCodexAgent(agent: AgentSource): string {
  const fields = { ...agent.shared, ...agent.perTool.codex };
  const lines = Object.entries(fields).map(
    ([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`,
  );
  return `${lines.join('\n')}\n\ndeveloper_instructions = ${tomlMultiline(agent.body)}\n`;
}

function asPlain(value: unknown, where: string): Plain {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`agent frontmatter "${where}" must be a mapping`);
  return value;
}

function pick(source: Plain, keys: readonly string[]): Plain {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
}

function omit(source: Plain, keys: readonly string[]): Plain {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}
