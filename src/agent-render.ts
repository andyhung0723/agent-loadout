import { parse } from 'yaml';
import { TOOLS, type Tool } from './manifest.ts';
import { adapterOf } from './tools/index.ts';
import { isPlainObject, type Plain } from './values.ts';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const SHARED_KEYS = ['name', 'description'] as const;

/** A neutral agent source, parsed; each tool adapter renders it in its own format. */
export interface AgentSource {
  shared: Plain;
  claudeOnly: Plain;
  perTool: Partial<Record<Tool, Plain>>;
  body: string;
}

export function renderAgent(sourceText: string, name: string, tool: Tool): string {
  return adapterOf(tool).agent.render(parseAgentSource(sourceText, name));
}

export function parseAgentSource(text: string, name: string): AgentSource {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('agent source needs YAML frontmatter (--- … ---)');

  const frontmatter: unknown = parse(match[1]!);
  if (!isPlainObject(frontmatter)) throw new Error('agent frontmatter must be a mapping');

  const rest = omit(frontmatter, TOOLS);
  const shared: Plain = { name, ...pick(rest, SHARED_KEYS) };
  if (typeof shared.description !== 'string') throw new Error('agent needs a "description"');

  return {
    shared,
    claudeOnly: omit(rest, SHARED_KEYS),
    perTool: Object.fromEntries(TOOLS.map((tool) => [tool, asPlain(frontmatter[tool], tool)])),
    body: match[2]!.trim(),
  };
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
