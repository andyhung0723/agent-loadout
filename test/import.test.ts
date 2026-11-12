import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { Backup, Documents } from '../src/documents.ts';
import { detectTargets, importFromTargets, renderManifest } from '../src/importer.ts';
import { parseManifest } from '../src/manifest.ts';
import { buildPlan } from '../src/planner.ts';
import { emptyState } from '../src/state.ts';
import { Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

test('imports links, hooks, mcp and plugins; the resulting plan is adopt-only', async () => {
  await mkdir(box.path('src/skills/review'), { recursive: true });
  await box.write('src/commands/list-pr.md', '# list\n');
  for (const target of ['.claude', '.claude-work', '.codex']) {
    await symlink(box.path('src/skills/review'), box.path(target, 'skills/review'));
  }
  await mkdir(box.path('.claude/commands'));
  await symlink(box.path('src/commands/list-pr.md'), box.path('.claude/commands/list-pr.md'));
  await mkdir(box.path('.claude/skills/synced'));

  const atuin = (tool: string, matcher: string) => ({
    matcher,
    hooks: [{ type: 'command', command: `${box.home}/.atuin/bin/atuin hook ${tool}` }],
  });
  await box.write(
    '.claude/settings.json',
    JSON.stringify({
      hooks: {
        PreToolUse: [atuin('claude-code', 'Bash')],
        PostToolUse: [atuin('claude-code', 'Bash')],
      },
      enabledPlugins: { 'figma@claude-plugins-official': true },
      extraKnownMarketplaces: { hub: { source: { source: 'github', repo: 'org/hub' } } },
    }),
  );
  await box.write(
    '.claude-work/.claude.json',
    JSON.stringify({
      mcpServers: { zhtw: { type: 'stdio', command: `${box.home}/bin/zhtw`, args: [] } },
    }),
  );
  await box.write(
    '.codex/hooks.json',
    JSON.stringify({ hooks: { PreToolUse: [atuin('codex', '^Bash$')] } }),
  );
  await box.write(
    '.codex/config.toml',
    `[mcp_servers.zhtw]\ncommand = "${box.home}/bin/zhtw"\nargs = []\n\n[plugins."figma@openai-curated"]\nenabled = true\n`,
  );

  const targets = await detectTargets(box.home);
  assert.deepEqual(
    targets.map((target) => [target.name, target.tags]),
    [
      ['claude', []],
      ['claude-work', ['work']],
      ['codex', []],
    ],
  );

  const result = await importFromTargets(targets, box.home);
  const toml = renderManifest(result, box.home);

  assert.match(toml, /\[\[skill\]\]\nname = "review"\nfrom = "src-skills"\nto = \["\*"\]/);
  assert.match(toml, /\[\[command\]\]\nname = "list-pr"\nfrom = "src-commands"\nto = \["claude"\]/);
  assert.match(
    toml,
    /name = "atuin-claude"\nevents = \["PostToolUse", "PreToolUse"\]\nmatcher = "Bash"/,
  );
  assert.match(toml, /name = "atuin-codex"/);
  assert.match(
    toml,
    /name = "zhtw"\ncommand = "~\/bin\/zhtw"\nargs = \[\]\nto = \["claude-work", "codex"\]/,
  );
  assert.match(toml, /#\s+claude: ~\/\.claude\/skills\/synced/);

  const context = box.context();
  const plan = await buildPlan(parseManifest(toml, box.home), emptyState(), context);
  const notAdopt = plan.entries.filter((entry) => entry.action !== 'adopt');
  assert.deepEqual(notAdopt, []);
});

test('same config key with different definitions keeps the key and renames only the label', async () => {
  await box.write(
    '.claude/settings.json',
    JSON.stringify({ extraKnownMarketplaces: { hub: { source: { source: 'git', url: 'u' } } } }),
  );
  await box.write(
    '.claude-work/settings.json',
    JSON.stringify({
      extraKnownMarketplaces: { hub: { source: { source: 'github', repo: 'r' } } },
    }),
  );
  await box.write(
    '.codex/config.toml',
    '[mcp_servers.ctx]\ncommand = "npx"\nargs = ["ctx", "--api-key", "abc"]\n',
  );

  const result = await importFromTargets(await detectTargets(box.home), box.home);
  const toml = renderManifest(result, box.home);
  assert.match(toml, /name = "hub-claude"\nkey = "hub"/);
  assert.match(toml, /name = "hub-claude-work"\nkey = "hub"/);
  assert.match(toml, /# ⚠ may contain a secret.*\n\[\[mcp\]\]\nname = "ctx"/);

  const context = box.context();
  const plan = await buildPlan(parseManifest(toml, box.home), emptyState(), context);
  assert.ok(plan.entries.every((entry) => entry.action === 'adopt'));
});

test('.claude.json: inside the profile when present, else ~/.claude.json for the default profile', async () => {
  await box.write('.claude.json', JSON.stringify({ mcpServers: { home: { command: 'h' } } }));
  await box.write(
    '.claude-work/.claude.json',
    JSON.stringify({ mcpServers: { work: { command: 'w' } } }),
  );

  const targets = await detectTargets(box.home);
  const byName = Object.fromEntries(targets.map((t) => [t.name, t.claudeJson]));
  assert.equal(byName.claude, box.path('.claude.json'));
  assert.equal(byName['claude-work'], box.path('.claude-work/.claude.json'));

  const toml = renderManifest(await importFromTargets(targets, box.home), box.home);
  assert.match(
    toml,
    /\[targets.claude\]\ntool = "claude"\ndir = "~\/.claude"\ntags = \[\]\nclaude_json = "~\/.claude.json"\n/,
  );
  assert.match(toml, /name = "home"[^[]*to = \["claude"\]/);
  assert.match(toml, /name = "work"[^[]*to = \["claude-work"\]/);

  const context = box.context();
  const plan = await buildPlan(parseManifest(toml, box.home), emptyState(), context);
  assert.deepEqual(
    plan.entries.filter((entry) => entry.action !== 'adopt'),
    [],
  );
  assert.ok(plan.entries.some((entry) => entry.location.startsWith(box.path('.claude.json'))));
});

test('an explicit claude_json in the manifest wins over detection', async () => {
  await box.write('.claude.json', '{}');
  const manifest = parseManifest(
    `[targets.claude]\ntool = "claude"\ndir = "~/.claude"\nclaude_json = "~/custom.json"\n`,
    box.home,
  );
  assert.equal(manifest.targets[0]!.claudeJson, box.path('custom.json'));
});
