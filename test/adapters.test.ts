import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { parseAgentSource } from '../src/agent-render.ts';
import { TOOLS } from '../src/manifest.ts';
import { ADAPTERS, adapterOf } from '../src/tools/index.ts';

const SRC = path.resolve(import.meta.dirname, '../src');

describe('tool adapters', () => {
  test('every tool has an adapter registered under its own name', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), [...TOOLS].sort());
    for (const tool of TOOLS) assert.equal(adapterOf(tool).name, tool);
  });

  test('nothing outside src/tools branches on a tool name', async () => {
    // manifest.ts declares TOOLS and the claude_json key of the manifest schema.
    const allowed = new Set(['manifest.ts']);
    const offenders: string[] = [];
    for (const file of await readdir(SRC)) {
      if (!file.endsWith('.ts') || allowed.has(file)) continue;
      const text = await readFile(path.join(SRC, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/['"](claude|codex)['"]/.test(line))
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], 'move tool-specific logic into src/tools/<tool>.ts');
  });

  test('agent render and parse round-trip for every tool', () => {
    const source = parseAgentSource(
      '---\nname: x\ndescription: Does x.\nclaude:\n  model: m1\ncodex:\n  model: m2\n---\n\nDo x.\n',
      'x',
    );
    for (const tool of TOOLS) {
      const adapter = adapterOf(tool);
      const { fields, body } = adapter.agent.parse(adapter.agent.render(source));
      assert.equal(body, 'Do x.', tool);
      assert.equal(fields.description, 'Does x.', tool);
      assert.equal(fields.model, tool === 'claude' ? 'm1' : 'm2');
    }
  });
});
