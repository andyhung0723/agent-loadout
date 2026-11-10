import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { applyPlan } from '../src/apply.ts';
import { detectTargets, importFromTargets, renderManifest } from '../src/importer.ts';
import { parseManifest, ManifestError } from '../src/manifest.ts';
import { buildPlan, type PlanEntry } from '../src/planner.ts';
import { emptyState, type State } from '../src/state.ts';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'loadout-'));
  for (const dir of ['.claude', '.claude-work', '.codex']) {
    await mkdir(path.join(home, dir, 'skills'), { recursive: true });
  }
  for (const skill of ['review', 'ddd', 'deck']) {
    await mkdir(path.join(home, 'src/skills', skill), { recursive: true });
  }
  await writeFile(path.join(home, 'src/RULES.md'), '# rules\n');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const TARGETS = `
[targets.claude]
tool = "claude"
dir = "~/.claude"
tags = ["personal"]

[targets.claude-work]
tool = "claude"
dir = "~/.claude-work"
tags = ["work"]

[targets.codex]
tool = "codex"
dir = "~/.codex"
tags = ["personal"]

[sources]
mine = "~/src/skills"
`;

const manifest = (body: string) => parseManifest(TARGETS + body, home);
const skillDest = (target: string, name: string) => path.join(home, `.${target}`, 'skills', name);
const actions = (plan: PlanEntry[]) =>
  plan.map((entry) => `${entry.action} ${entry.resource}@${entry.target}`).sort();

async function reconcile(body: string, state: State = emptyState()) {
  const plan = await buildPlan(manifest(body), state);
  return { plan, ...(await applyPlan(plan, state)) };
}

describe('selectors', () => {
  test('tag, tool, wildcard and exclusion pick the expected targets', async () => {
    const plan = await buildPlan(
      manifest(`
[[skill]]
name = "review"
from = "mine"
to = ["*", "!codex"]

[[skill]]
name = "ddd"
from = "mine"
to = ["tag:personal"]

[[skill]]
name = "deck"
from = "mine"
to = ["tool:codex"]
`),
      emptyState(),
    );
    assert.deepEqual(actions(plan), [
      'create skill:ddd@claude',
      'create skill:ddd@codex',
      'create skill:deck@codex',
      'create skill:review@claude',
      'create skill:review@claude-work',
    ]);
  });

  test('unknown target name is a manifest error', () => {
    assert.throws(
      () => manifest(`[[skill]]\nname = "review"\nfrom = "mine"\nto = ["nope"]\n`),
      ManifestError,
    );
  });
});

describe('reconcile', () => {
  test('creates symlinks and records ownership', async () => {
    const { state } = await reconcile(
      `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`,
    );
    assert.equal(
      await readlink(skillDest('claude', 'review')),
      path.join(home, 'src/skills/review'),
    );
    assert.ok(skillDest('claude', 'review') in state.links);
  });

  test('second run is a no-op', async () => {
    const body = `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`;
    const first = await reconcile(body);
    const plan = await buildPlan(manifest(body), first.state);
    assert.deepEqual(actions(plan), ['ok skill:review@claude']);
  });

  test('removing a target from "to" removes only the owned link', async () => {
    const first = await reconcile(
      `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude", "codex"]\n`,
    );
    const second = await reconcile(
      `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`,
      first.state,
    );
    assert.deepEqual(actions(second.plan), ['ok skill:review@claude', 'remove skill:review@codex']);
    await assert.rejects(lstat(skillDest('codex', 'review')));
    assert.ok(!(skillDest('codex', 'review') in second.state.links));
  });

  test('pre-existing identical symlink is adopted, not rewritten', async () => {
    await symlink(path.join(home, 'src/skills/review'), skillDest('claude', 'review'));
    const { plan } = await reconcile(
      `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`,
    );
    assert.deepEqual(actions(plan), ['adopt skill:review@claude']);
  });

  test('real directory or foreign symlink is a conflict and left untouched', async () => {
    await mkdir(skillDest('claude', 'review'));
    await symlink('/somewhere/else', skillDest('codex', 'review'));
    const { plan, state } = await reconcile(
      `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude", "codex"]\n`,
    );
    assert.deepEqual(actions(plan), [
      'conflict skill:review@claude',
      'conflict skill:review@codex',
    ]);
    assert.ok((await lstat(skillDest('claude', 'review'))).isDirectory());
    assert.equal(await readlink(skillDest('codex', 'review')), '/somewhere/else');
    assert.deepEqual(state.links, {});
  });

  test('owned link that was changed by hand is forgotten, not deleted', async () => {
    const first = await reconcile(`[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`);
    await rm(skillDest('claude', 'review'));
    await symlink('/hand/edited', skillDest('claude', 'review'));
    const second = await reconcile(
      `[[skill]]\nname = "ddd"\nfrom = "mine"\nto = ["codex"]\n`,
      first.state,
    );
    assert.ok(actions(second.plan).includes('forget skill:review@claude'));
    assert.equal(await readlink(skillDest('claude', 'review')), '/hand/edited');
  });

  test('missing source is reported and never linked', async () => {
    const { plan } = await reconcile(`[[skill]]\nname = "ghost"\nfrom = "mine"\nto = ["claude"]\n`);
    assert.deepEqual(actions(plan), ['missing-source skill:ghost@claude']);
    await assert.rejects(lstat(skillDest('claude', 'ghost')));
  });

  test('instructions map to CLAUDE.md / AGENTS.md per tool', async () => {
    await reconcile(`[[instructions]]\npath = "~/src/RULES.md"\nto = ["claude", "codex"]\n`);
    const rules = path.join(home, 'src/RULES.md');
    assert.equal(await readlink(path.join(home, '.claude/CLAUDE.md')), rules);
    assert.equal(await readlink(path.join(home, '.codex/AGENTS.md')), rules);
  });
});

describe('import', () => {
  test('round-trips existing symlinks into a manifest whose plan is all adopt', async () => {
    await symlink(path.join(home, 'src/skills/review'), skillDest('claude', 'review'));
    await symlink(path.join(home, 'src/skills/review'), skillDest('claude-work', 'review'));
    await symlink(path.join(home, 'src/skills/review'), skillDest('codex', 'review'));
    await symlink(path.join(home, 'src/skills/ddd'), skillDest('claude', 'ddd'));
    await mkdir(skillDest('claude', 'synced'));

    const targets = await detectTargets(home);
    assert.deepEqual(
      targets.map((t) => [t.name, t.tool, t.tags]),
      [
        ['claude', 'claude', []],
        ['claude-work', 'claude', ['work']],
        ['codex', 'codex', []],
      ],
    );

    const result = await importFromTargets(targets);
    const toml = renderManifest(result, home);
    assert.match(toml, /name = "review"\nfrom = "src"\nto = \["\*"\]/);
    assert.match(toml, /#\s+claude: ~\/\.claude\/skills\/synced/);

    const plan = await buildPlan(parseManifest(toml, home), emptyState());
    assert.ok(
      plan.every((entry) => entry.action === 'adopt'),
      JSON.stringify(plan, null, 2),
    );
  });
});
