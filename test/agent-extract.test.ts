import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { extractAgent } from '../src/agent-extract.ts';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

const CLAUDE = `---
name: worker
description: 處理範圍明確的執行型任務。
model: claude-sonnet-5-5
effort: medium
---

只處理主 Agent 明確委派的任務。
不得再委派任務。
`;

const CODEX = `name = "worker"
description = "處理範圍明確的執行型任務。"
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"

developer_instructions = """
只處理主 Agent 明確委派的任務。
不得再委派任務。
"""
`;

test('extracts a neutral source that reproduces every existing copy byte-for-byte', async () => {
  await box.write('.claude/agents/worker.md', CLAUDE);
  await box.write('.claude-work/agents/worker.md', CLAUDE);
  await box.write('.codex/agents/worker.toml', CODEX);

  const result = await extractAgent(box.manifest(''), 'worker');
  assert.deepEqual(result.identical, ['claude', 'claude-work', 'codex']);
  assert.deepEqual(result.differs, []);
  assert.deepEqual(result.warnings, []);

  await box.write('src/agents/worker.md', result.source);
  const body = `[[agent]]\nname = "worker"\npath = "~/src/agents/worker.md"\nto = ["claude", "claude-work", "codex"]\n`;
  const { plan } = await box.reconcile(body);
  assert.deepEqual(actions(plan), [
    'adopt agent:worker@claude',
    'adopt agent:worker@claude-work',
    'adopt agent:worker@codex',
  ]);
});

test('diverging copies are reported, and differing instructions keep the Claude body', async () => {
  await box.write('.claude/agents/worker.md', CLAUDE);
  await box.write(
    '.claude-work/agents/worker.md',
    CLAUDE.replace('effort: medium', 'effort: high'),
  );
  await box.write('.codex/agents/worker.toml', CODEX.replace('不得再委派任務。', '可以委派。'));

  const result = await extractAgent(box.manifest(''), 'worker');
  assert.deepEqual(result.identical, ['claude']);
  assert.deepEqual(result.differs, ['claude-work', 'codex']);
  assert.match(result.warnings[0]!, /instructions differ/);
  assert.match(result.source, /不得再委派任務。/);
});

test('unknown agent is a clear error', async () => {
  await assert.rejects(extractAgent(box.manifest(''), 'ghost'), /no agent "ghost"/);
});
