import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createDefaultResolver, findRefs, interpolate } from '../src/secrets.ts';
import { loadState, saveState } from '../src/state.ts';
import { sha256, stableStringify } from '../src/values.ts';
import { actions, Sandbox } from './sandbox.ts';

let box: Sandbox;

beforeEach(async () => {
  box = await Sandbox.create();
});

afterEach(() => box.dispose());

const CONTEXT7 = `
[[mcp]]
name = "context7"
command = "npx"
args = ["-y", "@upstash/context7-mcp", "--api-key", "\${env:CONTEXT7_API_KEY}"]
to = ["claude", "codex"]
`;

describe('interpolation', () => {
  test('finds refs, ignores $$-escaped ones and substitutes nested strings', async () => {
    const value = {
      args: ['--key', '${env:A}'],
      headers: { Authorization: 'Bearer ${keychain:svc}' },
      literal: '$${env:KEEP}',
    };
    assert.deepEqual(
      findRefs(value).map((ref) => `${ref.scheme}:${ref.name}`),
      ['env:A', 'keychain:svc'],
    );

    const resolver = { resolve: async (ref: { name: string }) => `<${ref.name}>` };
    const { value: resolved, missing } = await interpolate(value, resolver);
    assert.deepEqual(missing, []);
    assert.deepEqual(resolved, {
      args: ['--key', '<A>'],
      headers: { Authorization: 'Bearer <svc>' },
      literal: '${env:KEEP}',
    });
  });

  test('default resolver reads env without touching the process environment', async () => {
    const resolver = createDefaultResolver({ TOKEN: 'abc' });
    assert.equal(await resolver.resolve({ scheme: 'env', name: 'TOKEN' }), 'abc');
    assert.equal(await resolver.resolve({ scheme: 'env', name: 'NOPE' }), undefined);
  });
});

describe('secret references in reconcile', () => {
  test('resolved secret is written to target configs but never to state', async () => {
    box.secrets['env:CONTEXT7_API_KEY'] = 'ctx7sk-real-secret';
    const { state } = await box.reconcile(CONTEXT7);

    const claude = await box.readJson('.claude/.claude.json');
    assert.deepEqual(claude.mcpServers.context7.args.at(-1), 'ctx7sk-real-secret');
    assert.match(await box.read('.codex/config.toml'), /"--api-key", "ctx7sk-real-secret"\]/);

    await saveState(box.path('state.json'), state);
    const raw = await readFile(box.path('state.json'), 'utf8');
    assert.ok(!raw.includes('ctx7sk-real-secret'));
    assert.ok(!raw.includes('"args"'));
  });

  test('missing secret blocks the unit and writes nothing', async () => {
    const { plan, state } = await box.reconcile(CONTEXT7);
    assert.deepEqual(actions(plan), [
      'unresolved mcp:context7@claude',
      'unresolved mcp:context7@codex',
    ]);
    assert.match(plan.entries[0]!.detail ?? '', /unresolved secret env:CONTEXT7_API_KEY/);
    assert.deepEqual(state.units, {});
    await assert.rejects(box.read('.claude/.claude.json'));
  });

  test('rotating the secret replaces the owned value', async () => {
    box.secrets['env:CONTEXT7_API_KEY'] = 'old';
    const first = await box.reconcile(CONTEXT7);
    box.secrets['env:CONTEXT7_API_KEY'] = 'new';
    const second = await box.reconcile(CONTEXT7, first.state);
    assert.deepEqual(actions(second.plan), [
      'replace mcp:context7@claude',
      'replace mcp:context7@codex',
    ]);
    const claude = await box.readJson('.claude/.claude.json');
    assert.equal(claude.mcpServers.context7.args.at(-1), 'new');
  });

  test('a literal secret already in place is adopted once the manifest uses a reference', async () => {
    await box.write(
      '.codex/config.toml',
      '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp", "--api-key", "live"]\n',
    );
    box.secrets['env:CONTEXT7_API_KEY'] = 'live';
    const { plan } = await box.reconcile(CONTEXT7.replace('["claude", "codex"]', '["codex"]'));
    assert.deepEqual(actions(plan), ['adopt mcp:context7@codex']);
  });
});

describe('state v2 → v3', () => {
  test('plaintext value fingerprints are hashed; links and files are untouched', async () => {
    const value = { command: 'npx', args: ['--api-key', 'secret'] };
    await box.write(
      'state.json',
      JSON.stringify({
        version: 2,
        units: {
          a: {
            driver: 'toml-table',
            file: 'f',
            pointer: ['mcp_servers', 'x'],
            resource: 'mcp:x',
            target: 'codex',
            fingerprint: stableStringify(value),
          },
          b: {
            driver: 'link',
            file: 'l',
            pointer: [],
            resource: 'skill:y',
            target: 'claude',
            fingerprint: '/src/y',
          },
        },
      }),
    );
    const state = await loadState(box.path('state.json'));
    assert.equal(state.version, 3);
    assert.equal(state.units.a!.fingerprint, sha256(stableStringify(value)));
    assert.equal(state.units.b!.fingerprint, '/src/y');
  });
});
