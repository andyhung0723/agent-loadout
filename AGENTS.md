# AGENTS.md

Guide for coding agents working on **agent-loadout**: a declarative reconciler that decides what
each Claude Code / Codex profile (`~/.claude`, `~/.codex`, …) loads. `README.md` is the user
guide; this file is about changing the code without breaking its guarantees.

## Commands

```bash
pnpm test         # node --test, every test file in test/
pnpm typecheck    # tsc (no emit)
pnpm format       # prettier --write .
node bin/loadout.js <command> --manifest <file> --state <file>   # run against a sandbox
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and `prettier --check` on macOS and Linux.

## Runtime

- Node >= 24 runs the TypeScript directly (type stripping). Only **erasable syntax**: no enums,
  no parameter properties, no namespaces. Imports use the `.ts` extension. There is no build.
- Dependencies are deliberate and few: `smol-toml`, `yaml`. Adding one needs a reason.

## Architecture

```
manifest.ts ─▶ units.ts ─▶ planner.ts ─▶ apply.ts
 (resources)   (resource × target      (inspect each unit,     (drivers mutate, documents
                → units with a driver)  decide an action)       flush, ownership recorded)
```

| Module                                  | Responsibility                                                            |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `manifest.ts`                           | Parse + validate `loadout.toml` into `Target[]` and `Resource[]`          |
| `selector.ts`                           | `*`, name, `tag:`, `tool:`, `!exclude` → targets                          |
| `units.ts`                              | Translate a resource for one target into units (locator + value)          |
| `drivers.ts`                            | `link`, `file`, `json-key`, `json-item`, `toml-table`: inspect/put/remove |
| `documents.ts`                          | Cached JSON/TOML documents, optimistic flush, backups, atomic writes      |
| `toml-text.ts`                          | Block-level TOML surgery that keeps the rest of the file byte-identical   |
| `planner.ts` / `apply.ts`               | Actions (`create`, `replace`, `adopt`, `remove`, `forget`, …) and effects |
| `state.ts`                              | Ownership records (state v3) and migrations                               |
| `secrets.ts`                            | `${env:…}` / `${keychain:…}` resolution                                   |
| `importer.ts` / `unmanaged.ts`          | Derive a manifest from targets / list what the manifest doesn't cover     |
| `toggle.ts` / `adopt.ts` / `agent-*.ts` | Manifest-editing commands                                                 |
| `lock.ts`                               | Inter-process lock for every command that writes                          |
| `cli.ts` / `render.ts`                  | Argument handling, text and `--json` output                               |

Adding a resource kind = parse it in `manifest.ts`, map it to units in `units.ts`, import it in
`importer.ts`, and mark unsupported tools in `UNSUPPORTED`. Adding a driver = implement the
`Driver` interface and register it in `DRIVERS`; the planner needs no change.

## Invariants (breaking one is a bug, not a style issue)

1. **Ownership.** Only units recorded in state are replaced or removed. A unit is removed only
   when what's on disk still matches the recorded fingerprint; otherwise it's `forget` or
   `conflict`. Never delete or overwrite something loadout didn't put there.
2. **No secrets at rest outside target configs.** State stores SHA-256 fingerprints for value
   drivers; plan/status/JSON output never contains resolved values.
3. **Surgical edits.** JSON changes only owned keys/items; TOML is edited per table block;
   manifest edits (`toggle`, `adopt`, `agent extract --add`) rewrite one entry or append one.
   Comments and formatting elsewhere must survive (tests assert byte equality).
4. **Optimistic writes + backups.** Re-read a file before writing; abort that file if it changed
   since it was read. Back up anything overwritten. Preserve file modes.
5. **Codex hook trust is index-keyed.** New hook groups are appended; changed ones are replaced in
   place. Never reorder hook arrays, never write `[hooks.state]`.
6. **Writers hold the lock.** `apply`, `toggle`, `adopt`, `import --write`, `agent extract --add`
   run inside `withLock`. Read-only commands (`status`, `plan`) must not take it.
7. **Observe mode never writes**, and switching to it releases ownership without deleting.

## Conventions

- Readable code over comments; comment only non-obvious reasons (see `lock.ts`, `unmanaged.ts`).
- Every behavior change comes with a test in `test/` using the `Sandbox` helper (temp HOME with
  `.claude`, `.claude-work`, `.codex` targets). Never touch the real `~/.claude*` / `~/.codex*`
  from tests; CLI tests run the binary with `HOME` set to the sandbox.
- Exit codes: 0 ok, 2 blocked (conflict/unresolved), 64 usage, 65 manifest error, 75 locked.
- `--json` output is consumed by the herdr mod (`herdr-customized/herdr-loadout`); treat its shape
  as an interface: add fields, don't rename or remove them.
