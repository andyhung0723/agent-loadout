import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { findUnmanaged } from '../src/unmanaged.ts';
import { Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  for (const name of ['review', 'ddd'])
    await mkdir(box.path('src/skills', name), { recursive: true });
});

afterEach(() => box.dispose());

const resolver = { resolve: async () => undefined };

test('lists what exists in targets but the manifest does not cover', async () => {
  await symlink(box.path('src/skills/review'), box.path('.claude/skills/review'));
  await symlink(box.path('src/skills/ddd'), box.path('.claude/skills/ddd'));
  await mkdir(box.path('.codex/skills/gsap-core'));
  await box.write('.claude/agents/worker.md', '---\nname: worker\n---\n');
  const atuin = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: `${box.home}/bin/atuin hook` }],
  };
  await box.write(
    '.claude/settings.json',
    JSON.stringify({ hooks: { PreToolUse: [atuin] }, enabledPlugins: { 'x@y': true } }),
  );

  const manifest = box.manifest(`
[[skill]]
name = "review"
from = "mine"
to = ["claude"]

[[hook]]
name = "atuin"
events = ["PreToolUse"]
matcher = "Bash"
command = "~/bin/atuin hook"
to = ["claude"]
`);
  const items = await findUnmanaged(manifest, resolver, box.home);
  const summary = items
    .map((item) => `${item.target} ${item.kind}:${item.name ?? '-'} ${item.reason}`)
    .sort();

  assert.deepEqual(summary, [
    'claude agent:- hand-written; convert with `loadout agent extract`',
    'claude plugin:x@y not in manifest',
    'claude skill:ddd not in manifest',
    'codex skill:- a real directory, not a symlink (see `loadout adopt`)',
  ]);
});

test('a manifest that covers everything reports nothing', async () => {
  await symlink(box.path('src/skills/review'), box.path('.claude/skills/review'));
  const manifest = box.manifest(`[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`);
  assert.deepEqual(await findUnmanaged(manifest, resolver, box.home), []);
});
