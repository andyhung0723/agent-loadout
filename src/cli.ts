import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyAdopt, planAdopt } from './adopt.ts';
import { extractAgent } from './agent-extract.ts';
import { applyPlan } from './apply.ts';
import { Backup, Documents } from './documents.ts';
import { createDefaultResolver } from './secrets.ts';
import { detectTargets, importFromTargets, renderManifest } from './importer.ts';
import { loadManifest, ManifestError, parseManifest, type Manifest } from './manifest.ts';
import { tomlValue } from './toml-text.ts';
import { LockError, withLock } from './lock.ts';
import { toggleInManifest } from './toggle.ts';
import { findUnmanaged } from './unmanaged.ts';
import { exists } from './observe.ts';
import { collapseHome, DEFAULT_MANIFEST_PATH, DEFAULT_STATE_PATH, expandHome } from './paths.ts';
import { BLOCKED_ACTIONS, buildPlan } from './planner.ts';
import { renderApply, renderPlan, renderStatus, renderUnmanaged } from './render.ts';
import { loadState, saveState } from './state.ts';
import { toStatusMatrix } from './status.ts';

const EXIT = { ok: 0, blocked: 2, usage: 64, manifest: 65, locked: 75 } as const;

const USAGE = `Usage: loadout <command> [options]

Commands:
  status     resource × target matrix (--unmanaged: also list what the manifest doesn't cover)
  plan       show what apply would change
  apply      reconcile all targets to the manifest
  import     generate a manifest from the current setup
  adopt <path> --into <dir>
             move a real skill/command out of a target into a source folder,
             link it back and record it in the manifest (--dry-run to preview)
  agent extract <name> --out <file> [--add]
             write a neutral agent source from the existing claude .md / codex .toml;
             reports which targets it reproduces byte-for-byte (--add records it)
  toggle <resource> <target> on|off
             switch a resource for one target: edits "to" in the manifest,
             then applies just that resource (skip with --no-apply)

Options:
  --manifest <path>  default: $LOADOUT_MANIFEST or ${DEFAULT_MANIFEST_PATH}
  --state <path>     default: $LOADOUT_STATE or ${DEFAULT_STATE_PATH}
  --json             machine-readable output
  --write            import: write to the manifest path instead of stdout
  --force            import --write: overwrite an existing manifest
  --no-apply         toggle: only edit the manifest
`;

interface Context {
  manifestPath: string;
  statePath: string;
  json: boolean;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        manifest: { type: 'string' },
        state: { type: 'string' },
        json: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'no-apply': { type: 'boolean', default: false },
        unmanaged: { type: 'boolean', default: false },
        into: { type: 'string' },
        out: { type: 'string' },
        add: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  const context: Context = {
    manifestPath: expandHome(
      values.manifest ?? process.env.LOADOUT_MANIFEST ?? DEFAULT_MANIFEST_PATH,
    ),
    statePath: expandHome(values.state ?? process.env.LOADOUT_STATE ?? DEFAULT_STATE_PATH),
    json: values.json,
  };
  const [command] = positionals;

  try {
    switch (command) {
      case 'status':
        return await runStatus(context, { unmanaged: values.unmanaged });
      case 'plan':
        return await runPlan(context);
      case 'apply':
        return await locked(context, 'apply', () => runApply(context));
      case 'import':
        return values.write
          ? await locked(context, 'import', () =>
              runImport(context, { write: true, force: values.force }),
            )
          : await runImport(context, { write: false, force: false });
      case 'adopt':
        return await runAdopt(context, positionals.slice(1), {
          into: values.into,
          dryRun: values['dry-run'],
        });
      case 'agent':
        return await runAgent(context, positionals.slice(1), {
          out: values.out,
          add: values.add,
          force: values.force,
        });
      case 'toggle':
        return await locked(context, 'toggle', () =>
          runToggle(context, positionals.slice(1), { apply: !values['no-apply'] }),
        );
      case undefined:
      case 'help':
        process.stdout.write(USAGE);
        return EXIT.ok;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT.usage;
    }
  } catch (error) {
    if (error instanceof ManifestError) {
      process.stderr.write(`manifest: ${error.message}\n`);
      return EXIT.manifest;
    }
    if (error instanceof LockError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.locked;
    }
    throw error;
  }
}

function locked(context: Context, command: string, run: () => Promise<number>): Promise<number> {
  return withLock(path.dirname(context.statePath), command, run);
}

async function loadPlanInputs(context: Context, preloaded?: Manifest) {
  const manifest = preloaded ?? (await loadManifest(context.manifestPath));
  const state = await loadState(context.statePath);
  const backupDir = path.join(
    path.dirname(context.statePath),
    'backups',
    new Date().toISOString().replaceAll(':', '-'),
  );
  const drivers = {
    documents: new Documents(),
    backup: new Backup(backupDir),
    secrets: createDefaultResolver(),
  };
  const plan = await buildPlan(manifest, state, drivers);
  return { manifest, state, plan, drivers, backupDir };
}

async function runStatus(context: Context, options: { unmanaged: boolean }): Promise<number> {
  const { manifest, plan, drivers } = await loadPlanInputs(context);
  const matrix = toStatusMatrix(manifest, plan);
  if (!options.unmanaged) {
    print(context, matrix, renderStatus(matrix));
    return EXIT.ok;
  }
  const unmanaged = await findUnmanaged(manifest, drivers.secrets, os.homedir());
  print(
    context,
    { ...matrix, unmanaged },
    [renderStatus(matrix), '', renderUnmanaged(unmanaged)].join('\n'),
  );
  return EXIT.ok;
}

async function runPlan(context: Context): Promise<number> {
  const { plan } = await loadPlanInputs(context);
  print(context, { entries: plan.entries, warnings: plan.warnings }, renderPlan(plan));
  return plan.entries.some((entry) => BLOCKED_ACTIONS.has(entry.action)) ? EXIT.blocked : EXIT.ok;
}

async function runApply(context: Context): Promise<number> {
  const { state, plan, drivers, backupDir } = await loadPlanInputs(context);
  const outcome = await applyPlan(plan, state, drivers);
  await saveState(context.statePath, outcome.state);
  print(
    context,
    { results: outcome.results, warnings: plan.warnings, backupDir },
    renderApply(outcome.results, plan.warnings) + `\nBackups (if any): ${backupDir}`,
  );

  const hasProblems = outcome.results.some(
    (result) => result.error || BLOCKED_ACTIONS.has(result.entry.action),
  );
  return hasProblems ? EXIT.blocked : EXIT.ok;
}

async function runImport(
  context: Context,
  options: { write: boolean; force: boolean },
): Promise<number> {
  const home = os.homedir();
  const result = await importFromTargets(await detectTargets(home), home);
  const toml = renderManifest(result, home);

  if (!options.write) {
    print(context, result, toml.trimEnd());
    return EXIT.ok;
  }
  if (!options.force && (await exists(context.manifestPath))) {
    process.stderr.write(`Refusing to overwrite ${context.manifestPath} (use --force).\n`);
    return EXIT.usage;
  }
  await mkdir(path.dirname(context.manifestPath), { recursive: true });
  await writeFile(context.manifestPath, toml);
  process.stdout.write(
    `Wrote ${context.manifestPath} — ${result.resources.length} resources across ${result.targets.length} targets.\n` +
      'Next: "loadout plan" should show only "adopt" entries; "loadout apply" records ownership without touching files.\n',
  );
  return EXIT.ok;
}

function print(context: Context, data: unknown, text: string): void {
  process.stdout.write((context.json ? JSON.stringify(data, null, 2) : text) + '\n');
}

async function runToggle(
  context: Context,
  args: string[],
  options: { apply: boolean },
): Promise<number> {
  const [resource, target, state] = args;
  if (!resource || !target || (state !== 'on' && state !== 'off')) {
    process.stderr.write(`Usage: loadout toggle <resource> <target> on|off\n`);
    return EXIT.usage;
  }

  const { manifest, result } = await toggleInManifest(context.manifestPath, {
    resource,
    target,
    enabled: state === 'on',
  });
  const summary = result.changed
    ? `${result.resource} → ${result.target}: ${state}  (to: ${JSON.stringify(result.before)} → ${JSON.stringify(result.after)})`
    : `${result.resource} → ${result.target}: already ${state}`;

  if (!options.apply || !result.changed) {
    print(context, { toggle: result }, summary);
    return EXIT.ok;
  }

  const inputs = await loadPlanInputs(context, manifest);
  const scoped = {
    ...inputs.plan,
    entries: inputs.plan.entries.filter((entry) => entry.resource === result.resource),
  };
  const outcome = await applyPlan(scoped, inputs.state, inputs.drivers);
  await saveState(context.statePath, outcome.state);

  const restart = `Restart sessions on ${result.target} for the change to load.`;
  print(
    context,
    { toggle: result, results: outcome.results, warnings: scoped.warnings, restart: result.target },
    [summary, renderApply(outcome.results, scoped.warnings), restart].join('\n'),
  );
  const hasProblems = outcome.results.some(
    (entry) => entry.error || BLOCKED_ACTIONS.has(entry.entry.action),
  );
  return hasProblems ? EXIT.blocked : EXIT.ok;
}

async function runAdopt(
  context: Context,
  paths: string[],
  options: { into?: string; dryRun: boolean },
): Promise<number> {
  if (paths.length === 0 || !options.into) {
    process.stderr.write('Usage: loadout adopt <path>... --into <dir> [--dry-run]\n');
    return EXIT.usage;
  }
  const adoptOptions = {
    manifestPath: context.manifestPath,
    into: options.into,
    backupDir: path.join(path.dirname(context.statePath), 'backups', timestamp(), 'adopted'),
    home: os.homedir(),
  };

  const run = async () => {
    const results = [];
    let state = await loadState(context.statePath);
    for (const input of paths) {
      const plan = await planAdopt(input, adoptOptions);
      if (!options.dryRun) {
        state = await applyAdopt(plan, adoptOptions, state);
        await saveState(context.statePath, state);
      }
      results.push(plan);
    }
    return results;
  };

  const results = options.dryRun
    ? await run()
    : await withLock(path.dirname(context.statePath), 'adopt', run);
  const verb = options.dryRun ? 'would adopt' : 'adopted';
  const lines = results.map(
    (plan) =>
      `${verb} ${plan.kind}:${plan.name} (${plan.target})  ${moveVerb(plan.mode, options.dryRun)} ${plan.source}`,
  );
  print(context, { dryRun: options.dryRun, adopted: results }, lines.join('\n'));
  return EXIT.ok;
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

function moveVerb(mode: 'move' | 'link-to-identical', dryRun: boolean): string {
  if (mode === 'move') return dryRun ? 'would move to' : 'moved to';
  return dryRun ? 'would link to identical' : 'linked to identical';
}

async function runAgent(
  context: Context,
  args: string[],
  options: { out?: string; add: boolean; force: boolean },
): Promise<number> {
  const [action, name] = args;
  if (action !== 'extract' || !name || !options.out) {
    process.stderr.write('Usage: loadout agent extract <name> --out <file> [--add] [--force]\n');
    return EXIT.usage;
  }
  const out = expandHome(options.out);
  if (!options.force && (await exists(out))) {
    process.stderr.write(`Refusing to overwrite ${out} (use --force).\n`);
    return EXIT.usage;
  }

  const manifest = await loadManifest(context.manifestPath);
  const result = await extractAgent(manifest, name);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, result.source);

  if (options.add) {
    await withLock(path.dirname(context.statePath), 'agent extract', async () => {
      const text = await readFile(context.manifestPath, 'utf8');
      const entry = [
        '[[agent]]',
        `name = ${tomlValue(name)}`,
        `path = ${tomlValue(collapseHome(out))}`,
        `to = ${tomlValue(result.identical)}`,
      ].join('\n');
      const next = `${text.replace(/\n*$/, '')}\n\n${entry}\n`;
      parseManifest(next);
      await writeFile(context.manifestPath, next);
    });
  }

  const lines = [
    `Wrote ${out}`,
    `  reproduces exactly: ${result.identical.join(', ') || '(none)'}`,
    ...(result.differs.length ? [`  would rewrite:      ${result.differs.join(', ')}`] : []),
    ...result.warnings.map((warning) => `  ⚠ ${warning}`),
    options.add
      ? `  added [[agent]] "${name}" with to = ${JSON.stringify(result.identical)}; "loadout apply" adopts them`
      : '  next: add an [[agent]] entry (or re-run with --add)',
  ];
  print(context, { out, ...result, added: options.add }, lines.join('\n'));
  return EXIT.ok;
}
