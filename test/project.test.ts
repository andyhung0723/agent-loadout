import assert from 'node:assert/strict';
import { lstat, mkdir, readlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Journal } from '../src/journal.ts';
import { ManifestError } from '../src/manifest.ts';
import { restoreRun } from '../src/restore.ts';
import { selectTargets } from '../src/selector.ts';
import { toStatusMatrix } from '../src/status.ts';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  await box.write('src/skills/review/SKILL.md', '# review\n');
  await mkdir(box.path('web/.git'), { recursive: true });
});

afterEach(() => box.dispose());

const project = (name: string, tool: string, extra = '') =>
  `\n[targets.${name}]\ntool = "${tool}"\ndir = "~/web"\nscope = "project"\n${extra}`;

const SKILL = (to: string) => `\n[[skill]]\nname = "review"\nfrom = "mine"\nto = ${to}\n`;
const HOOK = (name: string, to: string) =>
  `\n[[hook]]\nname = "${name}"\nevents = ["PreToolUse"]\nmatcher = "Bash"\ncommand = "${name}"\nto = ${to}\n`;
const MCP = (to: string, env = '{ MODE = "x" }') =>
  `\n[[mcp]]\nname = "zhtw"\ncommand = "zhtw-mcp"\nenv = ${env}\nto = ${to}\n`;

const excludes = async () => (await box.read('web/.git/info/exclude')).split('\n').filter(Boolean);

describe('local Claude project', () => {
  const TARGET = project('web', 'claude', 'profile = "claude"\n');

  test('links into .claude/, writes settings.local.json and profile MCP, all kept out of git', async () => {
    await box.write('.claude/.claude.json', '{"numStartups": 1}');
    await box.reconcile(
      TARGET + SKILL('["web"]') + HOOK('lint', '["web"]') + HOOK('fmt', '["web"]') + MCP('["web"]'),
    );

    assert.equal(
      await readlink(box.path('web/.claude/skills/review')),
      box.path('src/skills/review'),
    );
    const settings = await box.readJson('web/.claude/settings.local.json');
    assert.equal(settings.hooks.PreToolUse.length, 2);
    const state = await box.readJson('.claude/.claude.json');
    assert.deepEqual(state.projects[box.path('web')].mcpServers.zhtw, {
      command: 'zhtw-mcp',
      env: { MODE: 'x' },
    });
    assert.equal(state.numStartups, 1);
    assert.deepEqual(await excludes(), ['/.claude/skills/review', '/.claude/settings.local.json']);
  });

  test('dropping a resource removes its link and its exclude line; shared lines stay while needed', async () => {
    const first = await box.reconcile(
      TARGET + SKILL('["web"]') + HOOK('lint', '["web"]') + HOOK('fmt', '["web"]'),
    );
    const second = await box.reconcile(TARGET + HOOK('fmt', '["web"]'), first.state);
    assert.deepEqual(
      actions(second.plan).filter((entry) => !entry.startsWith('ok')),
      ['remove hook:lint@web', 'remove skill:review@web', 'remove skill:review@web'],
    );
    await assert.rejects(lstat(box.path('web/.claude/skills/review')));
    assert.deepEqual(await excludes(), ['/.claude/settings.local.json']);
  });

  test('without a profile there is nowhere to put MCP servers: the cell is n/a', async () => {
    const manifest = box.manifest(project('web', 'claude') + MCP('["web"]'));
    const plan = await box.plan(project('web', 'claude') + MCP('["web"]'));
    assert.deepEqual(actions(plan), []);
    assert.equal(toStatusMatrix(manifest, plan).rows[0]!.cells.web, 'n/a');
  });

  test('a folder that is not a git checkout gets links but no exclude file', async () => {
    await box.write('plain/.keep', '');
    const target = `\n[targets.plain]\ntool = "claude"\ndir = "~/plain"\nscope = "project"\n`;
    await box.reconcile(target + SKILL('["plain"]'));
    await lstat(box.path('plain/.claude/skills/review'));
    await assert.rejects(lstat(box.path('plain/.git')));
  });

  test('a local link can be restored like any other change', async () => {
    const { state, journal } = await box.reconcile(TARGET + SKILL('["web"]'));
    const run: Journal = { version: 1, command: 'apply', at: '', entries: journal };
    const outcome = await restoreRun(run, state, box.context(), { dryRun: false });
    assert.deepEqual(
      outcome.results.map((result) => result.error),
      [undefined, undefined],
    );
    await assert.rejects(lstat(box.path('web/.claude/skills/review')));
    assert.deepEqual(await excludes(), []);
  });
});

describe('local Codex project', () => {
  test('skills link into .agents/skills; MCP has no personal layer in a repo', async () => {
    const body = project('web', 'codex') + SKILL('["web"]') + MCP('["web"]');
    const { plan } = await box.reconcile(body);
    assert.equal(
      await readlink(box.path('web/.agents/skills/review')),
      box.path('src/skills/review'),
    );
    assert.deepEqual(await excludes(), ['/.agents/skills/review']);
    assert.ok(actions(plan).every((entry) => !entry.includes('mcp')));
  });
});

describe('shared projects', () => {
  const CLAUDE = project('web', 'claude', 'visibility = "shared"\n');

  test('skills are real copies; a source change replaces the copy; nothing goes to git exclude', async () => {
    const first = await box.reconcile(CLAUDE + SKILL('["web"]') + MCP('["web"]'));
    assert.ok((await lstat(box.path('web/.claude/skills/review'))).isDirectory());
    assert.equal(await box.read('web/.claude/skills/review/SKILL.md'), '# review\n');
    assert.deepEqual((await box.readJson('web/.mcp.json')).mcpServers.zhtw.command, 'zhtw-mcp');
    await assert.rejects(lstat(box.path('web/.git/info/exclude')));

    await box.write('src/skills/review/SKILL.md', '# review v2\n');
    const second = await box.reconcile(CLAUDE + SKILL('["web"]') + MCP('["web"]'), first.state);
    assert.ok(actions(second.plan).includes('replace skill:review@web'));
    assert.equal(await box.read('web/.claude/skills/review/SKILL.md'), '# review v2\n');

    const run: Journal = { version: 1, command: 'apply', at: '', entries: second.journal };
    const outcome = await restoreRun(run, second.state, box.context(), { dryRun: false });
    assert.match(outcome.results[0]!.error ?? '', /restore it with git/);
  });

  test('a copy edited in the repository is a conflict, never overwritten', async () => {
    const first = await box.reconcile(CLAUDE + SKILL('["web"]'));
    await box.write('web/.claude/skills/review/SKILL.md', '# edited by a teammate\n');
    await box.write('src/skills/review/SKILL.md', '# review v2\n');
    const second = await box.reconcile(CLAUDE + SKILL('["web"]'), first.state);
    assert.deepEqual(actions(second.plan), ['conflict skill:review@web']);
    assert.equal(await box.read('web/.claude/skills/review/SKILL.md'), '# edited by a teammate\n');
  });

  test('secrets never reach committed files; an escaped reference passes through for the tool', async () => {
    box.secrets['env:TOKEN'] = 's3cret';
    const blocked = await box.reconcile(CLAUDE + MCP('["web"]', '{ TOKEN = "${env:TOKEN}" }'));
    assert.deepEqual(actions(blocked.plan), ['unresolved mcp:zhtw@web']);
    assert.match(blocked.plan.entries[0]!.detail ?? '', /committed file/);

    await box.reconcile(CLAUDE + MCP('["web"]', '{ TOKEN = "$${TOKEN}" }'));
    assert.equal((await box.readJson('web/.mcp.json')).mcpServers.zhtw.env.TOKEN, '$${TOKEN}');
  });

  test('Codex: AGENTS.md copied, MCP and hooks in the repo .codex folder', async () => {
    await box.write('src/AGENTS.md', '# team rules\n');
    const body =
      project('web', 'codex', 'visibility = "shared"\n') +
      `\n[[instructions]]\nname = "team"\npath = "~/src/AGENTS.md"\nto = ["web"]\n` +
      MCP('["web"]') +
      HOOK('lint', '["web"]');
    await box.reconcile(body);
    assert.equal(await box.read('web/AGENTS.md'), '# team rules\n');
    assert.match(await box.read('web/.codex/config.toml'), /\[mcp_servers\.zhtw\]/);
    assert.equal((await box.readJson('web/.codex/hooks.json')).hooks.PreToolUse.length, 1);
  });
});

describe('selectors and validation', () => {
  test('"*" and "tool:" mean profiles only; a name or tag picks a project', () => {
    const manifest = box.manifest(project('web', 'claude', 'tags = ["repo"]\n'));
    const names = (selectors: string[]) =>
      selectTargets(selectors, manifest.targets).map((target) => target.name);
    assert.deepEqual(names(['*']), ['claude', 'claude-work', 'codex']);
    assert.deepEqual(names(['tool:claude']), ['claude', 'claude-work']);
    assert.deepEqual(names(['tag:repo']), ['web']);
    assert.deepEqual(names(['*', 'web']), ['claude', 'claude-work', 'codex', 'web']);
  });

  test('profile must name a user Claude target; project-only keys need scope', () => {
    assert.throws(
      () => box.manifest(project('web', 'claude', 'profile = "codex"\n')),
      /user-scope Claude target/,
    );
    assert.throws(
      () => box.manifest(project('web', 'claude', 'visibility = "shared"\nprofile = "claude"\n')),
      /only applies to local Claude project targets/,
    );
    assert.throws(
      () => box.manifest(`\n[targets.x]\ntool = "claude"\ndir = "~/x"\nvisibility = "shared"\n`),
      ManifestError,
    );
  });
});
