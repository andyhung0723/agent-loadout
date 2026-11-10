import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { detectTargets, importFromTargets, renderManifest } from '../src/importer.ts';
import { ManifestError } from '../src/manifest.ts';
import { toStatusMatrix } from '../src/status.ts';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

const NODE_REPL = (to: string, mode = 'observe') => `
[[mcp]]
name = "node_repl"
command = "/Applications/ChatGPT.app/node_repl"
mode = "${mode}"
to = ${to}
`;

const CONFIG = '[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/node_repl"\n';

test('observe never writes, even when the entry is missing or drifted', async () => {
  await box.write('.codex/config.toml', CONFIG.replace('node_repl"', 'node_repl-v2"'));
  const { plan, state } = await box.reconcile(NODE_REPL('["codex", "claude"]'));

  assert.deepEqual(actions(plan), ['observe mcp:node_repl@claude', 'observe mcp:node_repl@codex']);
  assert.deepEqual(plan.entries.map((entry) => entry.observation).sort(), ['absent', 'differs']);
  assert.deepEqual(state.units, {});
  assert.match(await box.read('.codex/config.toml'), /node_repl-v2/);
  await assert.rejects(box.read('.claude/.claude.json'));
});

test('status shows observed / absent cells', async () => {
  await box.write('.codex/config.toml', CONFIG);
  const plan = await box.plan(NODE_REPL('["codex", "claude"]'));
  const matrix = toStatusMatrix(box.manifest(NODE_REPL('["codex", "claude"]')), plan);
  assert.deepEqual(matrix.rows[0]!.cells, {
    claude: 'absent',
    'claude-work': 'off',
    codex: 'observed',
  });
});

test('switching an owned resource to observe releases ownership without deleting', async () => {
  const first = await box.reconcile(NODE_REPL('["codex"]', 'manage'));
  assert.ok(Object.keys(first.state.units).length === 1);

  const second = await box.reconcile(NODE_REPL('["codex"]'), first.state);
  assert.deepEqual(actions(second.plan), ['observe mcp:node_repl@codex']);
  assert.deepEqual(second.state.units, {});
  assert.match(await box.read('.codex/config.toml'), /\[mcp_servers.node_repl\]/);
});

test('invalid mode is a manifest error', () => {
  assert.throws(() => box.manifest(NODE_REPL('["codex"]', 'watch')), ManifestError);
});

test('import marks app-bundled MCP servers and plugins as observe-only', async () => {
  await box.write(
    '.codex/config.toml',
    `${CONFIG}\n[mcp_servers.mine]\ncommand = "npx"\n\n[plugins."browser@openai-bundled"]\nenabled = true\n\n[plugins."figma@openai-curated"]\nenabled = true\n`,
  );
  const toml = renderManifest(
    await importFromTargets(await detectTargets(box.home), box.home),
    box.home,
  );
  assert.match(toml, /name = "node_repl"\nmode = "observe"/);
  assert.match(toml, /name = "browser@openai-bundled"\nmode = "observe"/);
  assert.doesNotMatch(toml, /name = "mine"\nmode/);
  assert.doesNotMatch(toml, /name = "figma@openai-curated"\nmode/);
});

test('status JSON carries target details and row kind/name/mode for UIs', async () => {
  await box.write('.codex/config.toml', CONFIG);
  const manifest = box.manifest(NODE_REPL('["codex"]'));
  const matrix = toStatusMatrix(manifest, await box.plan(NODE_REPL('["codex"]')));
  assert.deepEqual(matrix.targetDetails[2], {
    name: 'codex',
    tool: 'codex',
    tags: ['personal'],
    dir: box.path('.codex'),
  });
  assert.equal(matrix.rows[0]!.kind, 'mcp');
  assert.equal(matrix.rows[0]!.name, 'node_repl');
  assert.equal(matrix.rows[0]!.observe, true);
});
