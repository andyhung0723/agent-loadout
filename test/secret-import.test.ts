import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { detectTargets, importFromTargets, renderManifest } from '../src/importer.ts';
import type { Resource } from '../src/manifest.ts';
import { extractSecrets } from '../src/secret-import.ts';
import { findSecretsIn } from '../src/secret-scan.ts';
import { storeSecrets, type SecretStore } from '../src/secrets.ts';
import { actions, Sandbox } from './sandbox.ts';

const run = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, '../bin/loadout.js');

const CTX7 = 'ctx7sk-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const OPAQUE = 'q8Zr2LmX0pTn4Vb7';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

const values = (text: string, context = {}) => findSecretsIn(text, context).map((f) => f.value);

describe('findSecretsIn', () => {
  test('known token formats anywhere in a string', () => {
    assert.deepEqual(values(CTX7), [CTX7]);
    assert.deepEqual(values(`curl -H "x: ${GHP}" https://x`), [GHP]);
  });

  test('values of secret-named flags, keys, auth headers and query params', () => {
    assert.deepEqual(values(OPAQUE, { previous: '--api-key' }), [OPAQUE]);
    assert.deepEqual(values(`--token=${OPAQUE}`), [OPAQUE]);
    assert.deepEqual(values(OPAQUE, { key: 'DATA_TOKEN' }), [OPAQUE]);
    assert.deepEqual(values(`Bearer ${OPAQUE}`, { key: 'Authorization' }), [OPAQUE]);
    assert.deepEqual(values(`curl -H "Authorization: Bearer ${OPAQUE}"`), [OPAQUE]);
    assert.deepEqual(values(`https://mcp.example.com/sse?api_key=${OPAQUE}`), [OPAQUE]);
  });

  test('a secret is recognised by its value even under an innocent key (skillshare F5)', () => {
    assert.deepEqual(values(GHP, { key: 'DATA' }), [GHP]);
  });

  test('paths, switches, package names and references are not secrets', () => {
    assert.deepEqual(values('~/.config/gh/token', { key: 'GH_TOKEN_FILE' }), []);
    assert.deepEqual(values('true', { key: 'AUTH_ENABLED' }), []);
    assert.deepEqual(values('@upstash/context7-mcp'), []);
    assert.deepEqual(values('${keychain:x}', { key: 'TOKEN' }), []);
    assert.deepEqual(values('/Applications/Codex.app/Contents/Resources/node_modules'), []);
  });

  test('a short value under a secret name is only suspected', () => {
    assert.deepEqual(
      findSecretsIn('abc', { previous: '--api-key' }).map((finding) => finding.confidence),
      ['suspected'],
    );
  });

  test('a high-entropy string with no other signal is only suspected', () => {
    const findings = findSecretsIn('aZ9xQ2mW7rT4yU1iO8pL5kJ3hG6fD0sA');
    assert.deepEqual(
      findings.map((finding) => finding.confidence),
      ['suspected'],
    );
  });
});

const mcp = (name: string, server: Record<string, unknown>, to = ['claude']): Resource =>
  ({ kind: 'mcp', name, server, overrides: {}, to }) as Resource;

describe('extractSecrets', () => {
  test('one value shared by two resources becomes one reference', () => {
    const { resources, secrets } = extractSecrets(
      [
        mcp('context7', { command: 'npx', args: ['--api-key', CTX7] }),
        mcp('context7-work', { command: 'npx', args: ['--api-key', CTX7] }),
      ],
      'keychain',
    );
    assert.deepEqual(
      secrets.map(({ name, resources: uses }) => [name, uses]),
      [['agent-loadout/context7', ['context7', 'context7-work']]],
    );
    for (const resource of resources) {
      assert.deepEqual((resource as any).server.args, [
        '--api-key',
        '${keychain:agent-loadout/context7}',
      ]);
    }
  });

  test('several secrets in one resource are qualified by where they were found; env names', () => {
    const { resources, secrets } = extractSecrets(
      [
        mcp('github', {
          url: 'https://x',
          headers: { Authorization: `Bearer ${GHP}` },
          env: { SIGNING_SECRET: OPAQUE },
        }),
      ],
      'env',
    );
    assert.deepEqual(secrets.map((secret) => secret.name).sort(), [
      'LOADOUT_GITHUB_AUTHORIZATION',
      'LOADOUT_GITHUB_SIGNING_SECRET',
    ]);
    const server = (resources[0] as any).server;
    assert.equal(server.headers.Authorization, 'Bearer ${env:LOADOUT_GITHUB_AUTHORIZATION}');
    assert.equal(server.env.SIGNING_SECRET, '${env:LOADOUT_GITHUB_SIGNING_SECRET}');
  });

  test('suspected values are kept and flagged in the rendered manifest', async () => {
    await box.write(
      '.claude/.claude.json',
      JSON.stringify({
        mcpServers: { odd: { command: 'x', args: ['aZ9xQ2mW7rT4yU1iO8pL5kJ3hG6fD0sA'] } },
      }),
    );
    const imported = await importFromTargets(await detectTargets(box.home), box.home);
    const { resources, secrets } = extractSecrets(imported.resources, 'keychain');
    assert.equal(secrets.length, 0);
    assert.match(renderManifest({ ...imported, resources }, box.home), /# ⚠ may contain a secret/);
  });

  test('imported manifest with references adopts the existing plaintext config', async () => {
    await box.write(
      '.claude/.claude.json',
      JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['--api-key', CTX7] } } }),
    );
    await box.write(
      '.codex/config.toml',
      `[mcp_servers.context7]\ncommand = "npx"\nargs = ["--api-key", "${CTX7}"]\n`,
    );
    const imported = await importFromTargets(await detectTargets(box.home), box.home);
    const { resources, secrets } = extractSecrets(imported.resources, 'keychain');
    const toml = renderManifest({ ...imported, resources }, box.home);
    assert.ok(!toml.includes(CTX7));

    for (const secret of secrets) box.secrets[`keychain:${secret.name}`] = secret.value;
    const body = toml.slice(toml.indexOf('# ── '));
    const plan = await box.plan(body);
    assert.deepEqual(actions(plan), ['adopt mcp:context7@claude', 'adopt mcp:context7@codex']);
  });
});

describe('storeSecrets', () => {
  test('reports stored / unchanged / updated and only writes when needed', async () => {
    const data = new Map([['b', 'old']]);
    let writes = 0;
    const store: SecretStore = {
      read: async (name) => data.get(name),
      write: async (name, value) => {
        writes++;
        data.set(name, value);
      },
    };
    await storeSecrets([{ name: 'c', value: 'same' }], store);
    const results = await storeSecrets(
      [
        { name: 'a', value: 'new' },
        { name: 'b', value: 'rotated' },
        { name: 'c', value: 'same' },
      ],
      store,
    );
    assert.deepEqual(Object.fromEntries(results), { a: 'stored', b: 'updated', c: 'unchanged' });
    assert.equal(writes, 3);
  });
});

test('import CLI never prints the secret, as text or JSON', async () => {
  await box.write(
    '.claude/.claude.json',
    JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['--api-key', CTX7] } } }),
  );
  const cli = (...args: string[]) =>
    run(process.execPath, [BIN, 'import', ...args], { env: { ...process.env, HOME: box.home } });

  const text = await cli('--secrets', 'env');
  assert.doesNotMatch(text.stdout + text.stderr, /ctx7sk/);
  assert.match(text.stdout, /\$\{env:LOADOUT_CONTEXT7\}/);
  assert.match(text.stderr, /LOADOUT_CONTEXT7\}\s+← context7/);

  const json = await cli('--secrets', 'env', '--json');
  assert.doesNotMatch(json.stdout, /ctx7sk/);
  assert.deepEqual(JSON.parse(json.stdout).secrets, [
    { reference: '${env:LOADOUT_CONTEXT7}', resources: ['context7'] },
  ]);
});
