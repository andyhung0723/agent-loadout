# agent-loadout

Declarative manager for what each Claude Code / Codex profile loads. One manifest drives many
targets (`~/.claude`, `~/.claude-work`, `~/.codex`, `~/.codex-work`, …).

```
loadout.toml ──▶ units (resource × target) ──plan──▶ actions ──apply──▶ symlinks / files / config patches
                                                  ▲                          │
                                   state.json (what loadout owns) ◀──────────┘
```

## Usage

```bash
pnpm install && pnpm link --global      # exposes `loadout` (Node >= 24, runs TS natively)

loadout import            # print a manifest derived from the current setup
loadout import --write    # write it to ~/.config/agent-loadout/loadout.toml
loadout plan              # dry run (exit 2 if anything is blocked)
loadout apply             # reconcile; the first run after import only "adopts"
loadout status [--json]   # resource × target matrix (JSON feeds the herdr mod)

loadout toggle ddd-discovery claude-work on    # flip one resource for one account
loadout toggle skill:code-review codex-work off --no-apply

loadout release ddd-discovery claude-work      # stop managing it there, keep the files
loadout history                                # journaled runs, newest first
loadout restore latest [--only mcp:zhtw@codex] [--dry-run]   # undo a run, entry by entry

loadout status --unmanaged                     # also list what the manifest doesn't cover
loadout adopt ~/.codex/skills/gsap-core --into ~/agent-config/skills [--dry-run]
loadout agent extract task-worker --out ~/agent-config/agents/task-worker.md [--add]
```

**Bringing existing things under management**

- `adopt` moves a real skill directory (or Claude command file) out of a profile into a source
  folder, links it back, and appends it to the manifest. A byte-identical copy in another profile
  is parked in the backups folder and linked to the same source; a different copy is refused.
- `agent extract` writes a neutral agent source from the existing `.md` / `.toml` copies and
  reports which profiles it reproduces byte-for-byte; those are adopted without rewriting.

**Letting go.** `toggle … off` deletes what loadout put there. `release <resource> [<target>…]`
(default: every target it's on) instead keeps the files: the targets leave `to` and loadout
forgets it owned them, so the symlink or config value stays as an unmanaged entry
(`status --unmanaged` lists it). Use it to hand something back to manual care or another tool.
Like every write it's journaled, so `restore` takes ownership back.

`toggle` rewrites only the `to` line of that entry in the manifest (comments and layout are kept),
using the smallest change that yields the requested selection: `["*"]` becomes
`["*", "!codex-work"]`, and turning it back on removes the exclusion again. It then applies **just
that resource**, so other pending manifest edits are not swept in. Restart sessions on the target
afterwards: skills, MCP servers and hooks load at session start.

## What it manages

| Kind           | Claude target                                  | Codex target                      | Driver            |
| -------------- | ---------------------------------------------- | --------------------------------- | ----------------- |
| `instructions` | `CLAUDE.md`                                    | `AGENTS.md`                       | symlink           |
| `skill`        | `skills/<name>`                                | `skills/<name>`                   | symlink           |
| `command`      | `commands/<name>.md`                           | unsupported                       | symlink           |
| `agent`        | `agents/<name>.md`                             | `agents/<name>.toml`              | generated file    |
| `hook`         | `settings.json` → `hooks.<Event>[]`            | `hooks.json` → `hooks.<Event>[]`  | owned array item  |
| `mcp`          | `.claude.json` → `mcpServers.<name>`           | `config.toml` → `[mcp_servers.x]` | owned key / table |
| `plugin`       | `settings.json` → `enabledPlugins.<id>`        | `config.toml` → `[plugins."id"]`  | owned key / table |
| `marketplace`  | `settings.json` → `extraKnownMarketplaces.<n>` | unsupported                       | owned key         |

## Manifest

```toml
[targets.claude-work]
tool = "claude"            # claude | codex
dir = "~/.claude-work"
tags = ["work"]

[sources]
toolkit = "~/Workspace/claude/claude-toolkit/skills"

[[skill]]
name = "code-review"
from = "toolkit"           # or: path = "~/abs/path"
to = ["*", "!codex-work"]

[[hook]]
name = "atuin"
events = ["PreToolUse", "PostToolUse"]
matcher = "Bash"
command = "~/.atuin/bin/atuin hook claude-code"
to = ["*"]
[hook.codex]               # per-tool overrides, merged over the base definition
matcher = "^Bash$"
command = "~/.atuin/bin/atuin hook codex"

[[mcp]]
name = "zhtw"
command = "~/.local/bin/zhtw-mcp"   # or: url = "...", headers = { ... }
env = { ZHTW_NO_NETWORK = "1" }
to = ["tag:work"]

[[plugin]]
name = "figma@claude-plugins-official"
enabled = true
to = ["tool:claude"]

[[marketplace]]
name = "hub-work"
key = "hub"                # config key, when the label must differ (defaults to name)
source = { source = "github", repo = "org/hub" }
to = ["claude-work"]
```

Selectors: `*`, `<target>`, `tag:<tag>`, `tool:<tool>`, prefix `!` to exclude. `to = []` keeps a
resource in the catalog but off everywhere. A leading `~/` in `path`, `dir` and `command` is
expanded.

### Agents

One neutral Markdown source renders to both formats. `name`/`description` are shared, other
top-level keys are Claude-only, and the `claude:` / `codex:` blocks are per-tool. The body becomes
the Claude prompt and Codex `developer_instructions`.

```markdown
---
name: task-worker
description: 處理範圍明確的執行型任務。
claude:
  model: claude-sonnet-5-5
  effort: medium
codex:
  model: gpt-6.1-sol
  model_reasoning_effort: xhigh
---

只處理主 Agent 明確委派的任務。
```

### Shared layers (Codex `~/.agents/skills`)

Codex loads skills from two places: the profile's own `$CODEX_HOME/skills`, and
`~/.agents/skills`, which **every** Codex profile loads. (Verified on codex-cli 0.167 from the
skill list injected into sessions.) Per-account control therefore only works for skills linked
into `$CODEX_HOME/skills`.

- `status` marks a skill found in the shared folder as `↥ inherited` on every Codex target that
  doesn't enable it explicitly, and warns when a profile enables it too (it would load twice).
- `toggle … off` on an inherited cell is refused with a hint; `toggle … on` reports it's already on.
- `status --unmanaged` lists shared skills the manifest doesn't mention.
- Keep `~/.agents/skills` for skills every Codex profile should have. Override the folder list
  with:

```toml
[shared]
codex_skills = ["~/.agents/skills"]
```

### Secrets

String values in `hook`, `mcp`, `plugin` and `marketplace` entries may reference secrets, so the
manifest can live in git:

```toml
[[mcp]]
name = "context7"
command = "npx"
args = ["-y", "@upstash/context7-mcp", "--api-key", "${keychain:context7}"]
headers = { Authorization = "Bearer ${env:GITHUB_TOKEN}" }
to = ["*"]
```

| Reference         | Resolved from                                                         |
| ----------------- | --------------------------------------------------------------------- |
| `${env:NAME}`     | environment of the `loadout` process                                  |
| `${keychain:svc}` | macOS Keychain (`security add-generic-password -s svc -a "$USER" -w`) |
| `$${env:NAME}`    | escape: writes the literal `${env:NAME}`                              |

Secrets are resolved at plan/apply time and written into the target config, where the tools read
them. They never reach `state.json` (fingerprints are SHA-256), plan output or JSON output. An
unresolvable reference marks the unit `unresolved` and nothing is written. Rotating a secret
shows up as `replace`.

**Import converts what it finds.** `loadout import` scans the strings MCP servers, hooks and
marketplaces write (args, env, headers, URL query, hook commands) and replaces secrets with
references. Detection looks at the value, not just the key: known token formats (`sk-…`,
`ghp_…`, `ctx7sk-…`, JWTs, …) anywhere, plus opaque values under secret-named keys, flags
(`--api-key x`, `--token=x`), `Authorization`/`Bearer` and query params. One value used in
several places becomes one reference. Long high-entropy strings with no other signal are only
flagged with `# ⚠`, not converted.

| `--secrets`                | Reference                           | `--write` also                          |
| -------------------------- | ----------------------------------- | --------------------------------------- |
| `keychain` (macOS default) | `${keychain:agent-loadout/<name>}`  | stores each value in the login keychain |
| `env`                      | `${env:LOADOUT_<NAME>}`             | nothing: lists the variables to export  |
| `keep`                     | none (values verbatim, `⚠` comment) | –                                       |

Keychain writes pass the secret to `security -i` on stdin, never on the command line, and are
read back to verify. Neither the text nor the `--json` output of `import` contains the values.

Prefer the keychain: `${env:…}` has to be exported in whatever shell runs `loadout apply`, which
is easy to forget once applies are triggered from the herdr mod.

## Safety model

- **Ownership.** Only units recorded in `state.json` are ever replaced or removed. Anything else
  at a destination is a **conflict** and stays untouched; an owned unit edited by hand is a
  conflict while desired and is **forgotten** (not deleted) once dropped from the manifest.
- **Surgical patches.** JSON is rewritten as a whole object but only owned keys/items change;
  `config.toml` is edited at table-block level, so comments and formatting elsewhere survive.
- **Optimistic writes, scoped to what the plan touches.** Each patched file is re-read before
  writing. If another process changed it since `plan` (a running Claude session saves
  `.claude.json` constantly), loadout compares only the keys the plan read or edits: unchanged →
  its edits are replayed onto the new content; changed → that file is skipped and the key named.
- **Backups and undo.** Every file loadout overwrites is copied to
  `~/.local/state/agent-loadout/backups/<run>/` first; file modes are preserved. `apply`,
  `toggle`, `release` and `restore` also write `<run>/journal.json`: per entry, the value before and after
  plus the ownership record. `restore <run>` replays it backwards, newest first, and only while
  the location still holds what that run wrote (anything changed since is reported, left alone).
  Unlike copying a whole backup file back, this keeps everything else that changed in the file
  since. Undoing a toggle also restores the manifest line if the manifest hasn't been edited
  since; undoing an `apply` doesn't touch the manifest, so the next `apply` redoes it. A restore
  is itself journaled, so it can be undone.
- **Codex hook trust** is keyed by array index in `config.toml` (`[hooks.state]`). loadout
  appends new hook groups and replaces changed ones in place so existing indices stay stable. It
  never writes trust state: Codex asks you to approve new hooks itself.
- **One writer at a time.** Commands that write (`apply`, `toggle`, `release`, `restore`, `adopt`, `import --write`,
  `agent extract --add`) take an inter-process lock next to the state file, so the herdr mod and
  the CLI can't interleave and lose ownership records. A busy lock waits up to 10 s, then exits
  75 naming the holder; a lock left by a dead process is taken over.

## Known limits

- Backups and journals may contain resolved secrets; they live in a `0700` directory under
  `~/.local/state/agent-loadout/backups/` (journals are `0600`). Nothing prunes them yet.
- `restore` of a TOML table rewrites that block in loadout's own formatting; comments inside the
  block are only in the full-file backup. Undoing `adopt` isn't journaled.
- App-managed entries (e.g. Codex's bundled `computer-use` / `node_repl` MCP servers) change on
  app updates; drop them from the manifest instead of owning them.
- TOML tables defined with dotted keys at the root (`mcp_servers.x.command = …`) are not edited.

## Roadmap

| Version | Scope                                                                                      |
| ------- | ------------------------------------------------------------------------------------------ |
| v0.1 ✓  | skills, instructions · import / plan / apply / status                                      |
| v0.2 ✓  | commands, agents (rendered), hooks / MCP / plugins / marketplaces (owned patches)          |
| v0.3    | secret references ✓ · settings fragments · `doctor` (managed-policy awareness) · herdr mod |
