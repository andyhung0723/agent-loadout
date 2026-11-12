import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyAdopt, planAdopt } from './adopt.ts';
import { extractAgent } from './agent-extract.ts';
import { applyPlan } from './apply.ts';
import { Backup, Documents } from './documents.ts';
import { createDefaultResolver, keychainStore, storeSecrets, type StoreResult } from './secrets.ts';
import { extractSecrets, type ExtractedSecret } from './secret-import.ts';
import {
  JournalError,
  listRuns,
  loadJournal,
  writeJournal,
  type Journal,
  type ManifestChange,
} from './journal.ts';
import { applyRelease, planRelease } from './release.ts';
import { restoreRun } from './restore.ts';
import { detectTargets, importFromTargets, renderManifest } from './importer.ts';
import { DEFAULT_RETENTION, loadManifest, ManifestError, type Manifest } from './manifest.ts';
import { planPrune, prune } from './retention.ts';
import { reparse } from './manifest-edit.ts';
import { filterOnly, OnlyError } from './only.ts';
import { tomlValue } from './toml-text.ts';
import { LockError, withLock } from './lock.ts';
import { scanSharedCodexSkills } from './shared.ts';
import { toggleInManifest } from './toggle.ts';
import { findUnmanaged } from './unmanaged.ts';
import { exists } from './observe.ts';
import { collapseHome, DEFAULT_MANIFEST_PATH, DEFAULT_STATE_PATH, expandHome } from './paths.ts';
import { BLOCKED_ACTIONS, buildPlan, type Plan } from './planner.ts';
import {
  renderApply,
  renderHistory,
  renderPlan,
  renderRestore,
  renderStatus,
  renderUnmanaged,
} from './render.ts';
import { loadState, saveState } from './state.ts';
import { toStatusMatrix } from './status.ts';

const EXIT = { ok: 0, blocked: 2, usage: 64, manifest: 65, locked: 75 } as const;

const USAGE = `Usage: loadout <command> [options]

Commands:
  status     resource × target matrix (--unmanaged: also list what the manifest doesn't cover)
  plan       show what apply would change
  apply      reconcile all targets to the manifest
             (both: --only <resource>[@<target>], repeatable; resource is kind:name,
             a name, kind:* or *; everything else stays pending)
  import     generate a manifest from the current setup; secrets found in MCP servers,
             hooks and marketplaces become references (--secrets keychain|env|keep,
             default keychain on macOS; --write stores them)
  adopt <path> --into <dir>
             move a real skill/command out of a target into a source folder,
             link it back and record it in the manifest (--dry-run to preview)
  agent extract <name> --out <file> [--add]
             write a neutral agent source from the existing claude .md / codex .toml;
             reports which targets it reproduces byte-for-byte (--add records it)
  toggle <resource> <target> on|off
             switch a resource for one target: edits "to" in the manifest,
             then applies just that resource (skip with --no-apply)
  release <resource> [<target>...] [--dry-run]
             stop managing it on those targets (default: all) and keep the files:
             drops them from "to" and forgets ownership; nothing is deleted
  prune [--keep N] [--older-than DAYS] [--dry-run]
             delete old runs (journal + backups) outside the retention policy;
             writers do this automatically with [backups] from the manifest
             (default: keep the newest 20 and anything from the last 30 days)
  history    list journaled runs (apply, toggle, restore), newest first
  restore <run>|latest [--only <resource>[@<target>]]... [--dry-run]
             undo a run entry by entry; entries changed since are left alone.
             A toggle run's manifest edit is undone too (not with --only)

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
        secrets: { type: 'string' },
        only: { type: 'string', multiple: true },
        keep: { type: 'string' },
        'older-than': { type: 'string' },
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
        return await runPlan(context, values.only);
      case 'apply':
        return await locked(context, 'apply', () => runApply(context, values.only));
      case 'import': {
        const secrets = secretMode(values.secrets);
        if (!secrets) {
          process.stderr.write('--secrets must be keychain, env or keep\n');
          return EXIT.usage;
        }
        return values.write
          ? await locked(context, 'import', () =>
              runImport(context, { write: true, force: values.force, secrets }),
            )
          : await runImport(context, { write: false, force: false, secrets });
      }
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
      case 'release':
        return values['dry-run']
          ? await runRelease(context, positionals.slice(1), { dryRun: true })
          : await locked(context, 'release', () =>
              runRelease(context, positionals.slice(1), { dryRun: false }),
            );
      case 'prune': {
        const options = {
          keep: values.keep,
          olderThan: values['older-than'],
          dryRun: values['dry-run'],
        };
        return options.dryRun
          ? await runPrune(context, options)
          : await locked(context, 'prune', () => runPrune(context, options));
      }
      case 'history':
        return await runHistory(context);
      case 'restore':
        return values['dry-run']
          ? await runRestore(context, positionals[1], { only: values.only, dryRun: true })
          : await locked(context, 'restore', () =>
              runRestore(context, positionals[1], { only: values.only, dryRun: false }),
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
    if (error instanceof JournalError || error instanceof OnlyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof LockError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.locked;
    }
    throw error;
  }
}

/** Every writer runs under the lock and then prunes old runs, still holding it. */
function locked<T>(context: Context, command: string, run: () => Promise<T>): Promise<T> {
  return withLock(path.dirname(context.statePath), command, async () => {
    const result = await run();
    await autoPrune(context);
    return result;
  });
}

/**
 * Applies `[backups]` from the manifest (defaults when it can't be read) but always keeps the
 * newest run, so the change just made stays undoable. Never fails the command it follows.
 */
async function autoPrune(context: Context): Promise<void> {
  try {
    const policy = await loadManifest(context.manifestPath)
      .then((manifest) => manifest.backups ?? DEFAULT_RETENTION)
      .catch(() => DEFAULT_RETENTION);
    const root = backupsRoot(context);
    const runs = await planPrune(root, { ...policy, keep: Math.max(1, policy.keep) });
    await prune(root, runs);
  } catch (error) {
    process.stderr.write(`warning: pruning old backups failed: ${(error as Error).message}\n`);
  }
}

async function runPrune(
  context: Context,
  options: { keep?: string; olderThan?: string; dryRun: boolean },
): Promise<number> {
  const configured = await loadManifest(context.manifestPath)
    .then((manifest) => manifest.backups ?? DEFAULT_RETENTION)
    .catch(() => DEFAULT_RETENTION);
  const keep = options.keep === undefined ? configured.keep : wholeNumber(options.keep);
  const maxAgeDays =
    options.olderThan === undefined
      ? configured.maxAgeDays
      : wholeNumber(options.olderThan.replace(/d$/, ''));
  if (keep === null || maxAgeDays === null) {
    process.stderr.write('--keep and --older-than take a whole number (days: 30 or 30d)\n');
    return EXIT.usage;
  }

  const root = backupsRoot(context);
  const runs = await planPrune(root, { keep, maxAgeDays });
  if (!options.dryRun) await prune(root, runs);
  const policy = `keeping the newest ${keep} run(s) and anything from the last ${maxAgeDays} day(s)`;
  const verb = options.dryRun ? 'Would delete' : 'Deleted';
  print(
    context,
    { dryRun: options.dryRun, keep, maxAgeDays, pruned: runs },
    runs.length === 0
      ? `Nothing to prune (${policy}).`
      : [
          `${verb} ${runs.length} run(s), ${policy}:`,
          ...runs.map((run) => `  ${run.id}  (${run.ageDays} d)`),
        ].join('\n'),
  );
  return EXIT.ok;
}

function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

function secretMode(value: string | undefined): SecretMode | null {
  if (value === undefined) return process.platform === 'darwin' ? 'keychain' : 'env';
  return value === 'keychain' || value === 'env' || value === 'keep' ? value : null;
}

function backupsRoot(context: Context): string {
  return path.join(path.dirname(context.statePath), 'backups');
}

function newRun(context: Context) {
  const base = path.join(backupsRoot(context), timestamp());
  let backupDir = base;
  for (let n = 2; existsSync(backupDir); n++) backupDir = `${base}-${n}`;
  const drivers = {
    documents: new Documents(),
    backup: new Backup(backupDir),
    secrets: createDefaultResolver(),
  };
  return { backupDir, run: path.basename(backupDir), drivers };
}

async function loadPlanInputs(context: Context, preloaded?: Manifest) {
  const manifest = preloaded ?? (await loadManifest(context.manifestPath));
  const state = await loadState(context.statePath);
  const { backupDir, run, drivers } = newRun(context);
  const plan = await buildPlan(manifest, state, drivers);
  return { manifest, state, plan, drivers, backupDir, run };
}

async function journalRun(
  backupDir: string,
  command: string,
  entries: Journal['entries'],
  manifest?: ManifestChange,
): Promise<boolean> {
  if (entries.length === 0 && !manifest) return false;
  await writeJournal(backupDir, {
    version: 1,
    command,
    at: new Date().toISOString(),
    entries,
    ...(manifest ? { manifest } : {}),
  });
  return true;
}

async function runStatus(context: Context, options: { unmanaged: boolean }): Promise<number> {
  const { manifest, plan, drivers } = await loadPlanInputs(context);
  const matrix = toStatusMatrix(manifest, plan, await scanSharedCodexSkills(manifest));
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

/** Narrow a plan to `--only`; other pending changes stay pending for a later run. */
function scopePlan(plan: Plan, only: string[] | undefined): Plan {
  return { ...plan, entries: filterOnly(plan.entries, only) };
}

async function runPlan(context: Context, only?: string[]): Promise<number> {
  const plan = scopePlan((await loadPlanInputs(context)).plan, only);
  print(context, { entries: plan.entries, warnings: plan.warnings }, renderPlan(plan));
  return plan.entries.some((entry) => BLOCKED_ACTIONS.has(entry.action)) ? EXIT.blocked : EXIT.ok;
}

async function runApply(context: Context, only?: string[]): Promise<number> {
  const inputs = await loadPlanInputs(context);
  const { state, drivers, backupDir, run } = inputs;
  const plan = scopePlan(inputs.plan, only);
  const outcome = await applyPlan(plan, state, drivers);
  await saveState(context.statePath, outcome.state);
  const command = only?.length ? `apply --only ${only.join(' --only ')}` : 'apply';
  const journaled = await journalRun(backupDir, command, outcome.journal);
  print(
    context,
    { results: outcome.results, warnings: plan.warnings, backupDir, run: journaled ? run : null },
    renderApply(outcome.results, plan.warnings) + undoHint(journaled ? run : null),
  );

  const hasProblems = outcome.results.some(
    (result) => result.error || BLOCKED_ACTIONS.has(result.entry.action),
  );
  return hasProblems ? EXIT.blocked : EXIT.ok;
}

type SecretMode = 'keychain' | 'env' | 'keep';

async function runImport(
  context: Context,
  options: { write: boolean; force: boolean; secrets: SecretMode },
): Promise<number> {
  const home = os.homedir();
  const imported = await importFromTargets(await detectTargets(home), home);
  const extraction =
    options.secrets === 'keep' ? null : extractSecrets(imported.resources, options.secrets);
  const result = extraction ? { ...imported, resources: extraction.resources } : imported;
  const secrets = extraction?.secrets ?? [];
  const toml = renderManifest(result, home);
  const publicSecrets = secrets.map(({ scheme, name, resources }) => ({
    reference: `\${${scheme}:${name}}`,
    resources,
  }));

  if (!options.write) {
    print(context, { ...result, secrets: publicSecrets }, toml.trimEnd());
    if (!context.json && secrets.length > 0) {
      process.stderr.write(`\n${describeSecrets(secrets, options.secrets, false)}\n`);
    }
    return EXIT.ok;
  }
  if (!options.force && (await exists(context.manifestPath))) {
    process.stderr.write(`Refusing to overwrite ${context.manifestPath} (use --force).\n`);
    return EXIT.usage;
  }

  const stored =
    options.secrets === 'keychain' ? await storeSecrets(secrets, keychainStore()) : null;
  await mkdir(path.dirname(context.manifestPath), { recursive: true });
  await writeFile(context.manifestPath, toml);
  process.stdout.write(
    [
      `Wrote ${context.manifestPath} — ${result.resources.length} resources across ${result.targets.length} targets.`,
      ...(secrets.length > 0 ? [describeSecrets(secrets, options.secrets, true, stored)] : []),
      'Next: "loadout plan" should show only "adopt" entries; "loadout apply" records ownership without touching files.',
    ].join('\n') + '\n',
  );
  return EXIT.ok;
}

function describeSecrets(
  secrets: ExtractedSecret[],
  mode: SecretMode,
  written: boolean,
  stored?: Map<string, StoreResult> | null,
): string {
  const lines = secrets.map((secret) => {
    const status = stored?.get(secret.name);
    return `  \${${secret.scheme}:${secret.name}}  ← ${secret.resources.join(', ')}${status ? `  (${status})` : ''}`;
  });
  if (mode === 'keychain') {
    const head = written
      ? `Moved ${secrets.length} secret(s) to the keychain:`
      : `${secrets.length} secret(s) replaced by keychain references; --write stores them in the keychain:`;
    return [head, ...lines].join('\n');
  }
  return [
    `${secrets.length} secret(s) replaced by env references. Export them wherever "loadout apply" runs`,
    '(the current values are still in the target configs):',
    ...lines,
  ].join('\n');
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

  const { manifest, result, change } = await toggleInManifest(context.manifestPath, {
    resource,
    target,
    enabled: state === 'on',
  });
  const summary = result.inheritedFrom
    ? `${result.resource} → ${result.target}: already on (inherited from ${result.inheritedFrom})`
    : result.changed
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
  const journaled = await journalRun(
    inputs.backupDir,
    `toggle ${result.resource} ${result.target} ${state}`,
    outcome.journal,
    change,
  );
  const run = journaled ? inputs.run : null;

  const restart = `Restart sessions on ${result.target} for the change to load.`;
  print(
    context,
    {
      toggle: result,
      results: outcome.results,
      warnings: scoped.warnings,
      restart: result.target,
      run,
    },
    [summary, renderApply(outcome.results, scoped.warnings), restart].join('\n') + undoHint(run),
  );
  const hasProblems = outcome.results.some(
    (entry) => entry.error || BLOCKED_ACTIONS.has(entry.entry.action),
  );
  return hasProblems ? EXIT.blocked : EXIT.ok;
}

function undoHint(run: string | null): string {
  return run ? `\nUndo with: loadout restore ${run}` : '';
}

async function runRelease(
  context: Context,
  args: string[],
  options: { dryRun: boolean },
): Promise<number> {
  const [resource, ...targets] = args;
  if (!resource) {
    process.stderr.write('Usage: loadout release <resource> [<target>...] [--dry-run]\n');
    return EXIT.usage;
  }
  const state = await loadState(context.statePath);
  const plan = await planRelease(context.manifestPath, state, { resource, targets });

  let run: string | null = null;
  if (!options.dryRun) {
    const outcome = await applyRelease(plan, state);
    await saveState(context.statePath, outcome.state);
    const next = newRun(context);
    const command = `release ${plan.resource} ${plan.targets.join(' ')}`;
    if (await journalRun(next.backupDir, command, outcome.journal, plan.manifest)) run = next.run;
  }

  const verb = options.dryRun ? 'would release' : 'released';
  const lines = [
    `${verb} ${plan.resource} on ${plan.targets.join(', ')}  (to: ${JSON.stringify(plan.before)} → ${JSON.stringify(plan.after)})`,
    ...(plan.released.length > 0
      ? [
          `  ownership ${options.dryRun ? 'to drop' : 'dropped'}; left in place:`,
          ...plan.released.map(({ unit, location }) => `    ${unit.target}: ${location}`),
        ]
      : ['  nothing was owned there; only the manifest changes']),
  ];
  const { manifest: _manifest, released, ...summary } = plan;
  print(
    context,
    {
      dryRun: options.dryRun,
      ...summary,
      released: released.map(({ key, unit, location }) => ({ key, target: unit.target, location })),
      run,
    },
    lines.join('\n') + undoHint(run),
  );
  return EXIT.ok;
}

async function runHistory(context: Context): Promise<number> {
  const runs = await listRuns(backupsRoot(context));
  print(context, { runs }, renderHistory(runs));
  return EXIT.ok;
}

async function runRestore(
  context: Context,
  id: string | undefined,
  options: { only?: string[]; dryRun: boolean },
): Promise<number> {
  if (!id) {
    process.stderr.write(
      'Usage: loadout restore <run>|latest [--only <resource>[@<target>]] [--dry-run]\n',
    );
    return EXIT.usage;
  }
  const root = backupsRoot(context);
  const journal = await loadJournal(root, id);
  const runId = id === 'latest' ? (await listRuns(root))[0]!.id : id;
  const state = await loadState(context.statePath);
  const { backupDir, run, drivers } = newRun(context);
  const outcome = await restoreRun(journal, state, drivers, options);

  let journaled = false;
  if (!options.dryRun) {
    await saveState(context.statePath, outcome.state);
    const manifest =
      outcome.manifest === 'restored' && journal.manifest
        ? { ...journal.manifest, before: journal.manifest.after, after: journal.manifest.before }
        : undefined;
    journaled = await journalRun(backupDir, `restore ${runId}`, outcome.journal, manifest);
  }
  print(
    context,
    {
      restored: runId,
      dryRun: options.dryRun,
      results: outcome.results,
      manifest: outcome.manifest,
      run: journaled ? run : null,
    },
    renderRestore(runId, outcome, options.dryRun) + undoHint(journaled ? run : null),
  );
  return outcome.results.some((result) => result.error) ? EXIT.blocked : EXIT.ok;
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

  const results = options.dryRun ? await run() : await locked(context, 'adopt', run);
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
      await reparse(context.manifestPath, { [context.manifestPath]: next });
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
