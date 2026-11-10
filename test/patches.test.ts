import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

const FOREIGN_HOOK = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/herdr.sh session', timeout: 10 }],
};

const ATUIN = `
[[hook]]
name = "atuin"
events = ["PreToolUse", "PostToolUse"]
matcher = "Bash"
command = "~/.atuin/bin/atuin hook claude-code"
to = ["*"]

[hook.codex]
matcher = "^Bash$"
command = "~/.atuin/bin/atuin hook codex"
`;

describe('hooks', () => {
  test('appends per-tool groups and leaves foreign hooks alone', async () => {
    await box.write(
      '.claude/settings.json',
      JSON.stringify({ effortLevel: 'high', hooks: { PreToolUse: [FOREIGN_HOOK] } }),
    );
    await box.reconcile(ATUIN);

    const settings = await box.readJson('.claude/settings.json');
    assert.equal(settings.effortLevel, 'high');
    assert.deepEqual(settings.hooks.PreToolUse[0], FOREIGN_HOOK);
    assert.deepEqual(settings.hooks.PreToolUse[1], {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `${box.home}/.atuin/bin/atuin hook claude-code` }],
    });

    const codex = await box.readJson('.codex/hooks.json');
    assert.equal(codex.hooks.PostToolUse[0].matcher, '^Bash$');
    assert.equal(
      codex.hooks.PostToolUse[0].hooks[0].command,
      `${box.home}/.atuin/bin/atuin hook codex`,
    );
  });

  test('changing an owned hook replaces it in place (keeps Codex trust indices stable)', async () => {
    await box.write('.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [] } }));
    const first = await box.reconcile(ATUIN.replace('["*"]', '["codex"]'));
    const hooks = await box.readJson('.codex/hooks.json');
    hooks.hooks.PreToolUse.push(FOREIGN_HOOK);
    await box.write('.codex/hooks.json', JSON.stringify(hooks));

    const changed = ATUIN.replace('["*"]', '["codex"]').replace('"^Bash$"', '"^(Bash|Edit)$"');
    const second = await box.reconcile(changed, first.state);
    assert.ok(actions(second.plan).every((line) => line.startsWith('replace')));

    const after = await box.readJson('.codex/hooks.json');
    assert.equal(after.hooks.PreToolUse[0].matcher, '^(Bash|Edit)$');
    assert.deepEqual(after.hooks.PreToolUse[1], FOREIGN_HOOK);
  });

  test('removing the hook resource deletes only the owned groups', async () => {
    await box.write(
      '.claude/settings.json',
      JSON.stringify({ hooks: { PreToolUse: [FOREIGN_HOOK] } }),
    );
    const first = await box.reconcile(ATUIN.replace('["*"]', '["claude"]'));
    await box.reconcile('', first.state);
    const settings = await box.readJson('.claude/settings.json');
    assert.deepEqual(settings.hooks, { PreToolUse: [FOREIGN_HOOK] });
  });

  test('warns when codex hooks feature flag is off', async () => {
    const plan = await box.plan(ATUIN.replace('["*"]', '["codex"]'));
    assert.ok(plan.warnings.some((warning) => warning.includes('[features] hooks = true')));
  });
});

describe('mcp', () => {
  const MCP = `
[[mcp]]
name = "zhtw"
command = "~/.local/bin/zhtw-mcp"
env = { ZHTW_NO_NETWORK = "1" }
to = ["claude", "codex"]
`;

  test('claude gets a typed entry in .claude.json; codex gets a TOML table', async () => {
    await box.write(
      '.claude/.claude.json',
      JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'http', url: 'x' } } }),
    );
    await box.write('.codex/config.toml', '# my config\nmodel = "gpt"\n\n[tui]\ntheme = "dark"\n');
    await box.reconcile(MCP);

    const state = await box.readJson('.claude/.claude.json');
    assert.equal(state.numStartups, 3);
    assert.deepEqual(state.mcpServers.zhtw, {
      command: `${box.home}/.local/bin/zhtw-mcp`,
      env: { ZHTW_NO_NETWORK: '1' },
    });
    assert.ok(state.mcpServers.other);

    assert.equal(
      await box.read('.codex/config.toml'),
      `# my config\nmodel = "gpt"\n\n[tui]\ntheme = "dark"\n\n[mcp_servers.zhtw]\ncommand = "${box.home}/.local/bin/zhtw-mcp"\nenv = { ZHTW_NO_NETWORK = "1" }\n`,
    );
  });

  test('unowned server with a different definition is a conflict', async () => {
    await box.write('.codex/config.toml', '[mcp_servers.zhtw]\ncommand = "other"\n');
    const { plan } = await box.reconcile(MCP.replace('["claude", "codex"]', '["codex"]'));
    assert.deepEqual(actions(plan), ['conflict mcp:zhtw@codex']);
    assert.equal(await box.read('.codex/config.toml'), '[mcp_servers.zhtw]\ncommand = "other"\n');
  });

  test('aborts the write when the file changes between plan and apply', async () => {
    const { buildPlan } = await import('../src/planner.ts');
    const { applyPlan } = await import('../src/apply.ts');
    const { Backup, Documents } = await import('../src/documents.ts');
    const { emptyState } = await import('../src/state.ts');

    await box.write('.claude/.claude.json', '{}');
    const context = box.context();
    const manifest = box.manifest(MCP.replace('["claude", "codex"]', '["claude"]'));
    const plan = await buildPlan(manifest, emptyState(), context);
    await box.write('.claude/.claude.json', '{"numStartups": 4}');
    const { results, state } = await applyPlan(plan, emptyState(), context);

    assert.match(results[0]!.error ?? '', /changed on disk/);
    assert.deepEqual(state.units, {});
    assert.equal(await box.read('.claude/.claude.json'), '{"numStartups": 4}');
  });
});

describe('plugins & marketplaces', () => {
  test('claude toggles enabledPlugins, codex writes [plugins."id"], marketplace is claude-only', async () => {
    await box.write('.codex/config.toml', '[plugins."figma@openai-curated"]\nenabled = true\n');
    const { plan } = await box.reconcile(`
[[plugin]]
name = "vercel@claude-plugins-official"
enabled = false
to = ["claude"]

[[plugin]]
name = "browser@openai-bundled"
to = ["codex"]

[[marketplace]]
name = "hub"
source = { source = "github", repo = "org/hub" }
to = ["*"]
`);
    assert.deepEqual(actions(plan), [
      'create marketplace:hub@claude',
      'create marketplace:hub@claude-work',
      'create plugin:browser@openai-bundled@codex',
      'create plugin:vercel@claude-plugins-official@claude',
    ]);
    const settings = await box.readJson('.claude/settings.json');
    assert.equal(settings.enabledPlugins['vercel@claude-plugins-official'], false);
    assert.deepEqual(settings.extraKnownMarketplaces.hub, {
      source: { source: 'github', repo: 'org/hub' },
    });
    assert.match(
      await box.read('.codex/config.toml'),
      /\[plugins\."browser@openai-bundled"\]\nenabled = true\n$/,
    );
  });
});

describe('agents', () => {
  const SOURCE = `---
name: worker
description: 處理範圍明確的執行型任務。
tools: Read, Bash
claude:
  model: claude-sonnet-5-5
  effort: medium
codex:
  model: gpt-6.1-sol
  model_reasoning_effort: xhigh
---

只處理主 Agent 明確委派的任務。
不得再委派任務。
`;

  test('renders claude markdown and codex TOML from one neutral source', async () => {
    await box.write('src/agents/worker.md', SOURCE);
    await box.reconcile(
      `[[agent]]\nname = "worker"\npath = "~/src/agents/worker.md"\nto = ["claude", "codex"]\n`,
    );

    assert.equal(
      await box.read('.claude/agents/worker.md'),
      '---\nname: worker\ndescription: 處理範圍明確的執行型任務。\ntools: Read, Bash\nmodel: claude-sonnet-5-5\neffort: medium\n---\n\n只處理主 Agent 明確委派的任務。\n不得再委派任務。\n',
    );
    assert.equal(
      await box.read('.codex/agents/worker.toml'),
      'name = "worker"\ndescription = "處理範圍明確的執行型任務。"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n\ndeveloper_instructions = """\n只處理主 Agent 明確委派的任務。\n不得再委派任務。\n"""\n',
    );
  });

  test('hand-edited generated file becomes a conflict; source edit replaces untouched file', async () => {
    await box.write('src/agents/worker.md', SOURCE);
    const body = `[[agent]]\nname = "worker"\npath = "~/src/agents/worker.md"\nto = ["claude", "codex"]\n`;
    const first = await box.reconcile(body);

    await box.write('.claude/agents/worker.md', 'hand edit\n');
    await box.write('src/agents/worker.md', SOURCE.replace('不得再委派任務。', '不得擴大範圍。'));
    const second = await box.reconcile(body, first.state);

    assert.deepEqual(actions(second.plan), [
      'conflict agent:worker@claude',
      'replace agent:worker@codex',
    ]);
    assert.equal(await box.read('.claude/agents/worker.md'), 'hand edit\n');
    assert.match(await box.read('.codex/agents/worker.toml'), /不得擴大範圍。/);
  });

  test('overwritten files are backed up', async () => {
    await box.write('src/agents/worker.md', SOURCE);
    const body = `[[agent]]\nname = "worker"\npath = "~/src/agents/worker.md"\nto = ["codex"]\n`;
    const first = await box.reconcile(body);
    await box.write('src/agents/worker.md', SOURCE.replace('不得再委派任務。', '改了。'));
    await box.reconcile(body, first.state);
    const backups = await readdir(box.path('.backups', box.home, '.codex', 'agents'));
    assert.deepEqual(backups, ['worker.toml']);
  });
});
