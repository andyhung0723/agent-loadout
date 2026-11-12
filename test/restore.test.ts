import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Journal } from '../src/journal.ts';
import { restoreRun } from '../src/restore.ts';
import type { State } from '../src/state.ts';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  await mkdir(box.path('src/skills/review'), { recursive: true });
});

afterEach(() => box.dispose());

const MCP = `
[[mcp]]
name = "zhtw"
command = "zhtw-mcp"
to = ["claude", "codex"]
`;

const HOOK = (command: string) => `
[[hook]]
name = "lint"
events = ["PreToolUse"]
matcher = "Bash"
command = "${command}"
to = ["claude"]
`;

const FOREIGN = { matcher: '*', hooks: [{ type: 'command', command: 'foreign' }] };

function asJournal(entries: Journal['entries']): Journal {
  return { version: 1, command: 'apply', at: '', entries };
}

async function reconcileJournal(body: string, state?: State) {
  const outcome = await box.reconcile(body, state);
  return { ...outcome, journal: asJournal(outcome.journal) };
}

describe('restore', () => {
  test('undoing a create removes only what the run added, other keys and text survive', async () => {
    const config = '# mine\nmodel = "gpt"\n';
    await box.write('.claude/.claude.json', '{"numStartups": 3}');
    await box.write('.codex/config.toml', config);
    const { state, journal } = await reconcileJournal(MCP);
    await box.write(
      '.claude/.claude.json',
      '{"numStartups": 9, "mcpServers": {"zhtw": {"command": "zhtw-mcp"}}}',
    );

    const outcome = await restoreRun(journal, state, box.context(), { dryRun: false });

    assert.deepEqual(
      outcome.results.map((result) => result.error),
      [undefined, undefined],
    );
    assert.deepEqual(await box.readJson('.claude/.claude.json'), {
      numStartups: 9,
      mcpServers: {},
    });
    assert.equal(await box.read('.codex/config.toml'), config);
    assert.deepEqual(outcome.state.units, {});
  });

  test('a replaced hook goes back in place; a removed one is reinserted at its index', async () => {
    const settings = (hooks: unknown[]) => JSON.stringify({ hooks: { PreToolUse: hooks } });
    await box.write('.claude/settings.json', settings([FOREIGN]));
    const first = await box.reconcile(HOOK('lint v1'));
    const original = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint v1' }] };
    const withTail = [FOREIGN, original, FOREIGN];
    await box.write('.claude/settings.json', settings(withTail));

    const replaced = await reconcileJournal(HOOK('lint v2'), first.state);
    assert.equal(
      (await box.readJson('.claude/settings.json')).hooks.PreToolUse[1].hooks[0].command,
      'lint v2',
    );
    await restoreRun(replaced.journal, replaced.state, box.context(), { dryRun: false });
    assert.deepEqual((await box.readJson('.claude/settings.json')).hooks.PreToolUse, withTail);

    const removed = await reconcileJournal('', first.state);
    assert.deepEqual((await box.readJson('.claude/settings.json')).hooks.PreToolUse, [
      FOREIGN,
      FOREIGN,
    ]);
    const outcome = await restoreRun(removed.journal, removed.state, box.context(), {
      dryRun: false,
    });
    assert.deepEqual((await box.readJson('.claude/settings.json')).hooks.PreToolUse, withTail);
    assert.deepEqual(Object.keys(outcome.state.units), Object.keys(first.state.units));
  });

  test('links are removed and recreated', async () => {
    const skill = `[[skill]]\nname = "review"\nfrom = "mine"\nto = ["claude"]\n`;
    const created = await reconcileJournal(skill);
    const removed = await reconcileJournal('', created.state);
    await assert.rejects(lstat(box.path('.claude/skills/review')));

    await restoreRun(removed.journal, removed.state, box.context(), { dryRun: false });
    assert.equal(await readlink(box.path('.claude/skills/review')), box.path('src/skills/review'));
    await restoreRun(created.journal, created.state, box.context(), { dryRun: false });
    await assert.rejects(lstat(box.path('.claude/skills/review')));
  });

  test('an entry changed since the run is left alone; the rest is restored', async () => {
    await box.write('.claude/.claude.json', '{}');
    const { state, journal } = await reconcileJournal(MCP);
    const edited = '{"mcpServers": {"zhtw": {"command": "hand-edited"}}}';
    await box.write('.claude/.claude.json', edited);

    const outcome = await restoreRun(journal, state, box.context(), { dryRun: false });

    const claude = outcome.results.find((result) => result.target === 'claude')!;
    assert.match(claude.error ?? '', /changed since that run/);
    assert.equal(await box.read('.claude/.claude.json'), edited);
    assert.ok(outcome.state.units[claude.key], 'ownership of the skipped entry is kept');
    assert.equal(await box.read('.codex/config.toml'), '');
  });

  test('--dry-run and --only', async () => {
    await box.write('.claude/.claude.json', '{}');
    const { state, journal } = await reconcileJournal(MCP);
    const before = await box.read('.claude/.claude.json');

    const dry = await restoreRun(journal, state, box.context(), { dryRun: true });
    assert.equal(dry.results.length, 2);
    assert.equal(await box.read('.claude/.claude.json'), before);

    const only = await restoreRun(journal, state, box.context(), {
      only: ['mcp:zhtw@codex'],
      dryRun: false,
    });
    assert.deepEqual(
      only.results.map((result) => result.target),
      ['codex'],
    );
    assert.equal(await box.read('.claude/.claude.json'), before);
  });
});

describe('restore CLI', () => {
  const cli = (...args: string[]) =>
    run(
      process.execPath,
      [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
      { env: { ...process.env, HOME: box.home, NO_COLOR: '1' } },
    );

  test('undoing a toggle reverts the link, ownership and the manifest line; restore is undoable', async () => {
    const manifest = TARGETS + `[[skill]]\nname = "review"\nfrom = "mine"\nto = []\n`;
    await box.write('loadout.toml', manifest);

    const toggled = await cli('toggle', 'review', 'claude-work', 'on');
    assert.match(toggled.stdout, /Undo with: loadout restore \S+/);

    const { stdout: history } = await cli('history');
    assert.match(history, /1 change\(s\)  toggle skill:review claude-work on/);

    const { stdout } = await cli('restore', 'latest');
    assert.match(stdout, /↺ skill:review@claude-work {2}undo create/);
    assert.match(stdout, /Manifest restored/);
    await assert.rejects(lstat(box.path('.claude-work/skills/review')));
    assert.equal(await box.read('loadout.toml'), manifest);
    assert.deepEqual((await box.readJson('state.json')).units, {});

    await cli('restore', 'latest');
    assert.equal(
      await readlink(box.path('.claude-work/skills/review')),
      box.path('src/skills/review'),
    );
    assert.match(await box.read('loadout.toml'), /to = \["claude-work"\]/);
  });

  test('journal never reaches --json output and is private on disk', async () => {
    box.secrets = {};
    await box.write(
      'loadout.toml',
      TARGETS + `[[mcp]]\nname = "x"\ncommand = "x"\nenv = { TOKEN = "s3cret" }\nto = ["claude"]\n`,
    );
    const { stdout } = await cli('apply', '--json');
    assert.doesNotMatch(stdout, /s3cret/);
    const id = JSON.parse(stdout).run;
    const stats = await lstat(box.path('backups', id, 'journal.json'));
    assert.equal(stats.mode & 0o777, 0o600);

    const restored = await cli('restore', id, '--json');
    assert.doesNotMatch(restored.stdout, /s3cret/);
  });
});
