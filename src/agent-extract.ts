import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml, stringify } from 'yaml';
import { renderAgent } from './agent-render.ts';
import { readOrNull } from './documents.ts';
import { isProject, ManifestError, type Manifest, type Target } from './manifest.ts';
import { configFiles } from './units.ts';
import { isPlainObject, type Plain } from './values.ts';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const SHARED_KEYS = new Set(['name', 'description']);

export interface ExtractResult {
  source: string;
  /** Targets whose current file is byte-identical to what the source renders. */
  identical: string[];
  /** Targets that have the agent but would be rewritten. */
  differs: string[];
  warnings: string[];
}

interface Found {
  target: Target;
  text: string;
}

export async function extractAgent(manifest: Manifest, name: string): Promise<ExtractResult> {
  const found = await findAgentFiles(manifest, name);
  const claude = found.find((entry) => entry.target.tool === 'claude');
  const codex = found.find((entry) => entry.target.tool === 'codex');
  if (!claude && !codex) throw new ManifestError(`no agent "${name}" in any target`);

  const warnings: string[] = [];
  const claudeParts = claude ? splitClaude(claude.text) : null;
  const codexFields = codex ? codexTable(codex.text) : null;

  const codexBody =
    typeof codexFields?.developer_instructions === 'string'
      ? codexFields.developer_instructions.trim()
      : undefined;
  const body = claudeParts?.body ?? codexBody ?? '';
  if (claudeParts && codexBody !== undefined && codexBody !== claudeParts.body) {
    warnings.push('Claude and Codex instructions differ; the Claude body was kept');
  }

  const frontmatter: Plain = {
    name,
    description: claudeParts?.frontmatter.description ?? codexFields?.description,
    ...(claudeParts ? { claude: withoutKeys(claudeParts.frontmatter, SHARED_KEYS) } : {}),
    ...(codexFields
      ? { codex: withoutKeys(codexFields, new Set([...SHARED_KEYS, 'developer_instructions'])) }
      : {}),
  };
  const source = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`;

  const identical: string[] = [];
  const differs: string[] = [];
  for (const entry of found) {
    const rendered = renderAgent(source, name, entry.target.tool);
    (rendered === entry.text ? identical : differs).push(entry.target.name);
  }
  return { source, identical, differs, warnings };
}

async function findAgentFiles(manifest: Manifest, name: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const target of manifest.targets.filter((candidate) => !isProject(candidate))) {
    const extension = target.tool === 'claude' ? 'md' : 'toml';
    const text = await readOrNull(path.join(configFiles.agents(target), `${name}.${extension}`));
    if (text !== null) found.push({ target, text });
  }
  return found;
}

function splitClaude(text: string): { frontmatter: Plain; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new ManifestError('Claude agent file has no YAML frontmatter');
  const frontmatter: unknown = parseYaml(match[1]!);
  if (!isPlainObject(frontmatter))
    throw new ManifestError('Claude agent frontmatter must be a mapping');
  return { frontmatter, body: match[2]!.trim() };
}

function codexTable(text: string): Plain {
  return parseToml(text);
}

function withoutKeys(source: Plain, keys: Set<string>): Plain {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.has(key)));
}
