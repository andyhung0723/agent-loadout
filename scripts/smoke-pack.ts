// Packs the package the way `npm publish` would and runs it from an npm install, where Node
// refuses to strip types: proves dist/ is complete and the bin picks it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(os.tmpdir(), 'loadout-pack-'));
const run = (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) =>
  execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  run('pnpm', ['pack', '--pack-destination', work], { cwd: repo });
  const [tarball] = (await readdir(work)).filter((name) => name.endsWith('.tgz'));
  assert.ok(tarball, 'pnpm pack produced no tarball');

  const contents = run('tar', ['-tzf', path.join(work, tarball)], { cwd: work }).split('\n');
  assert.ok(contents.includes('package/dist/cli.js'), 'dist/cli.js is packed');
  assert.ok(contents.includes('package/bin/loadout.js'), 'bin is packed');
  assert.ok(contents.includes('package/LICENSE'), 'LICENSE is packed');
  for (const forbidden of ['package/src/', 'package/test/', 'package/scripts/']) {
    assert.ok(!contents.some((file) => file.startsWith(forbidden)), `${forbidden} is not packed`);
  }

  const app = path.join(work, 'app');
  await mkdir(app);
  await writeFile(path.join(app, 'package.json'), '{"name":"smoke","private":true}\n');
  run('npm', ['install', '--no-audit', '--no-fund', path.join(work, tarball)], { cwd: app });
  const loadout = path.join(app, 'node_modules/.bin/loadout');

  const home = path.join(work, 'home');
  await mkdir(path.join(home, '.claude/skills'), { recursive: true });
  await mkdir(path.join(home, 'src/review'), { recursive: true });
  await symlink(path.join(home, 'src/review'), path.join(home, '.claude/skills/review'));
  const { LOADOUT_MANIFEST: _manifest, LOADOUT_STATE: _state, ...inherited } = process.env;
  const env = { ...inherited, HOME: home };

  assert.match(run(loadout, ['help'], { cwd: app, env }), /Usage: loadout <command>/);
  run(loadout, ['import', '--write', '--secrets', 'keep'], { cwd: app, env });
  assert.match(run(loadout, ['plan'], { cwd: app, env }), /adopt.*skill:review/s);
  run(loadout, ['apply'], { cwd: app, env });
  assert.match(run(loadout, ['status'], { cwd: app, env }), /skill:review\s+✓/);

  console.log(`smoke:pack ok — ${tarball} (${contents.filter(Boolean).length} files)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
