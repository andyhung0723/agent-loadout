import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyPlan } from './apply.ts';
import { Backup, Documents } from './documents.ts';
import { createDefaultResolver } from './secrets.ts';
import { detectTargets, importFromTargets, renderManifest } from './importer.ts';
import { loadManifest, ManifestError } from './manifest.ts';
import { exists } from './observe.ts';
import { DEFAULT_MANIFEST_PATH, DEFAULT_STATE_PATH, expandHome } from './paths.ts';
import { BLOCKED_ACTIONS, buildPlan } from './planner.ts';
import { renderApply, renderPlan, renderStatus } from './render.ts';
import { loadState, saveState } from './state.ts';
import { toStatusMatrix } from './status.ts';

const EXIT = { ok: 0, blocked: 2, usage: 64, manifest: 65 } as const;

const USAGE = `Usage: loadout <command> [options]

Commands:
  status     resource × target matrix
  plan       show what apply would change
  apply      reconcile all targets to the manifest
  import     generate a manifest from the symlinks already in place

Options:
  --manifest <path>  default: $LOADOUT_MANIFEST or ${DEFAULT_MANIFEST_PATH}
  --state <path>     default: $LOADOUT_STATE or ${DEFAULT_STATE_PATH}
  --json             machine-readable output
  --write            import: write to the manifest path instead of stdout
  --force            import --write: overwrite an existing manifest
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
        return await runStatus(context);
      case 'plan':
        return await runPlan(context);
      case 'apply':
        return await runApply(context);
      case 'import':
        return await runImport(context, { write: values.write, force: values.force });
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
    throw error;
  }
}

async function loadPlanInputs(context: Context) {
  const manifest = await loadManifest(context.manifestPath);
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

async function runStatus(context: Context): Promise<number> {
  const { manifest, plan } = await loadPlanInputs(context);
  const matrix = toStatusMatrix(manifest, plan);
  print(context, matrix, renderStatus(matrix));
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
