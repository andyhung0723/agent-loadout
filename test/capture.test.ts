import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Sandbox, TARGETS } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');
const CTX7 = 'ctx7sk-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
  await box.write('loadout.toml', TARGETS);
});

afterEach(() => box.dispose());

const env = () => ({
  ...process.env,
  HOME: box.home,
  NO_COLOR: '1',
  LOADOUT_KEYCHAIN_FILE: box.path('keychain.json'),
});

const cli = (...args: string[]) =>
  run(
    process.execPath,
    [BIN, ...args, '--manifest', box.path('loadout.toml'), '--state', box.path('state.json')],
    { env: env() },
  );

const fails = async (args: string[], code: number, message: RegExp) => {
  await assert.rejects(cli(...args), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, code);
    assert.match(error.stderr, message);
    return true;
  });
};

const withStdin = (input: string, ...args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: env() });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input);
  });

const context7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp', '--api-key', CTX7] };

describe('capture', () => {
  test('records a tool-installed MCP server with its key moved to the keychain, then owns it', async () => {
    await box.write(
      '.codex/config.toml',
      `[mcp_servers.context7]\ncommand = "npx"\nargs = ${JSON.stringify(context7.args)}\n`,
    );
    const before = await box.read('.codex/config.toml');

    const { stdout } = await cli('capture', 'mcp:context7', 'codex');
    assert.doesNotMatch(stdout, /ctx7sk/);
    assert.match(stdout, /moved to the keychain: \$\{keychain:agent-loadout\/context7\}/);
    assert.match(
      await box.read('loadout.toml'),
      /\[\[mcp\]\]\nname = "context7"\ncommand = "npx"\nargs = \["-y", "@upstash\/context7-mcp", "--api-key", "\$\{keychain:agent-loadout\/context7\}"\]\nto = \["codex"\]\n$/,
    );
    assert.deepEqual(await box.readJson('keychain.json'), { 'agent-loadout/context7': CTX7 });
    assert.equal(await box.read('.codex/config.toml'), before);

    const plan = await cli('plan');
    assert.match(plan.stdout, /Nothing to do/);
  });

  test('an identical entry only gains the target; a different one is refused', async () => {
    const server = JSON.stringify({
      mcpServers: { zhtw: { type: 'stdio', command: `${box.home}/bin/zhtw`, args: [] } },
    });
    await box.write('.claude/.claude.json', server);
    await box.write('.claude-work/.claude.json', server);
    await cli('capture', 'mcp:zhtw', 'claude');
    const { stdout } = await cli('capture', 'mcp:zhtw', 'claude-work');
    assert.match(stdout, /identical entry exists; added the target/);
    assert.match(
      await box.read('loadout.toml'),
      /name = "zhtw"\n[\s\S]*to = \["claude", "claude-work"\]/,
    );

    await box.write(
      '.codex/config.toml',
      `[mcp_servers.zhtw]\ncommand = "${box.home}/bin/other"\n`,
    );
    await fails(
      ['capture', 'mcp:zhtw', 'codex'],
      65,
      /already in the manifest with a different definition/,
    );
  });

  test('dry run writes nothing; skills point to adopt; unknown names list what is there', async () => {
    await box.write(
      '.claude/settings.json',
      JSON.stringify({ enabledPlugins: { 'figma@official': true } }),
    );
    const { stdout } = await cli('capture', 'plugin:figma@official', 'claude', '--dry-run');
    assert.match(stdout, /would append/);
    assert.equal(await box.read('loadout.toml'), TARGETS);

    await fails(['capture', 'skill:review', 'claude'], 65, /loadout adopt/);
    await fails(['capture', 'plugin:nope', 'claude'], 65, /present: figma@official/);
  });

  test('refuses to overwrite a different keychain value under the same name', async () => {
    await box.write('keychain.json', JSON.stringify({ 'agent-loadout/context7': 'other' }));
    await box.write(
      '.codex/config.toml',
      `[mcp_servers.context7]\ncommand = "npx"\nargs = ${JSON.stringify(context7.args)}\n`,
    );
    await fails(['capture', 'mcp:context7', 'codex'], 2, /already holds a different value/);
    assert.equal(await box.read('loadout.toml'), TARGETS);
  });
});

describe('secret', () => {
  test('set stores stdin without echoing it; check reports presence only', async () => {
    const set = await withStdin('s3cr3t-value\n', 'secret', 'set', 'github');
    assert.equal(set.code, 0);
    assert.match(set.stdout, /stored: use \$\{keychain:agent-loadout\/github\}/);
    assert.doesNotMatch(set.stdout, /s3cr3t/);
    assert.deepEqual(await box.readJson('keychain.json'), {
      'agent-loadout/github': 's3cr3t-value',
    });

    const present = await cli('secret', 'check', 'github');
    assert.match(present.stdout, /present/);
    await assert.rejects(
      cli('secret', 'check', 'missing'),
      (error: { code: number }) => error.code === 2,
    );
  });
});
