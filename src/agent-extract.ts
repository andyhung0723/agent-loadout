import path from 'node:path';
import { stringify } from 'yaml';
import { renderAgent } from './agent-render.ts';
import { readOrNull } from './documents.ts';
import { isProject, ManifestError, TOOLS, type Manifest, type Target } from './manifest.ts';
import { adapterOf, layoutOf } from './tools/index.ts';
import type { Plain } from './values.ts';

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
  if (found.length === 0) throw new ManifestError(`no agent "${name}" in any target`);

  // One copy per tool (the first found), in TOOLS order: its body wins when they disagree.
  const parsed = TOOLS.flatMap((tool) => {
    const entry = found.find((candidate) => candidate.target.tool === tool);
    return entry ? [{ tool, ...adapterOf(tool).agent.parse(entry.text) }] : [];
  });

  const warnings: string[] = [];
  const withBody = parsed.filter((copy) => copy.body !== undefined);
  const body = withBody[0]?.body ?? '';
  for (const other of withBody.slice(1)) {
    if (other.body !== body) {
      const [kept, differing] = [withBody[0]!.tool, other.tool].map(
        (tool) => adapterOf(tool).displayName,
      );
      warnings.push(`${kept} and ${differing} instructions differ; the ${kept} body was kept`);
    }
  }

  const frontmatter: Plain = {
    name,
    description: parsed.map((copy) => copy.fields.description).find((value) => value !== undefined),
    ...Object.fromEntries(parsed.map((copy) => [copy.tool, withoutKeys(copy.fields, SHARED_KEYS)])),
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
    const { agents } = layoutOf(target);
    if (!agents) continue;
    const extension = adapterOf(target.tool).agent.extension;
    const text = await readOrNull(path.join(agents, `${name}.${extension}`));
    if (text !== null) found.push({ target, text });
  }
  return found;
}

function withoutKeys(source: Plain, keys: Set<string>): Plain {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.has(key)));
}
