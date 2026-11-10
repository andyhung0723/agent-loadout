import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parse } from 'smol-toml';
import { removeTomlTable, upsertTomlTable } from '../src/toml-text.ts';

const CONFIG = `# top comment
model = "gpt"

[mcp_servers.alpha]
command = "a"

[mcp_servers.alpha.env]
KEY = "1"

[profiles.x]
instructions = """
[mcp_servers.alpha]
not a header
"""

[mcp_servers."with.dot"]
url = "u"
`;

describe('toml table surgery', () => {
  test('replace keeps everything else byte-identical, including sub-tables removal', () => {
    const result = upsertTomlTable(CONFIG, ['mcp_servers', 'alpha'], { command: 'b' });
    assert.equal(
      result,
      CONFIG.replace('command = "a"\n\n[mcp_servers.alpha.env]\nKEY = "1"\n', 'command = "b"\n'),
    );
  });

  test('ignores header-looking lines inside multi-line strings', () => {
    const result = removeTomlTable(CONFIG, ['mcp_servers', 'alpha']);
    assert.match(result, /instructions = """\n\[mcp_servers.alpha\]\nnot a header\n"""/);
    assert.equal(parse(result).mcp_servers && (parse(result).mcp_servers as any).alpha, undefined);
  });

  test('quoted keys with dots are matched exactly', () => {
    const result = removeTomlTable(CONFIG, ['mcp_servers', 'with.dot']);
    assert.ok(!result.includes('with.dot'));
    assert.ok(result.includes('[mcp_servers.alpha]'));
  });

  test('upsert appends a new table at the end with one blank line', () => {
    const result = upsertTomlTable('a = 1\n', ['plugins', 'x@y'], { enabled: true });
    assert.equal(result, 'a = 1\n\n[plugins."x@y"]\nenabled = true\n');
  });
});
