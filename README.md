# agent-loadout

Declarative manager for what each Claude Code / Codex profile loads. One manifest drives many
targets (`~/.claude`, `~/.claude-work`, `~/.codex`, `~/.codex-work`, …).

```
loadout.toml ──▶ units (resource × target) ──plan──▶ actions ──apply──▶ symlinks / files / config patches
                                                  ▲                          │
                                   state.json (what loadout owns) ◀──────────┘
```

## Install

Requires **Node >= 24** (it runs the TypeScript sources directly, no build step) and pnpm.
macOS is the main platform: `${keychain:…}` secrets need the `security` tool; everything else
works on Linux too (CI runs both).

```bash
git clone https://github.com/andyhung0723/agent-loadout.git
cd agent-loadout
pnpm install
pnpm add -g "link:$PWD"     # puts `loadout` on PATH, pointing at this checkout
loadout help
```

`git pull` updates the command in place. Uninstall with `pnpm remove -g agent-loadout`. Without
a global pnpm setup, a symlink works as well: `ln -s "$PWD/bin/loadout.js" ~/.local/bin/loadout`.

Not on npm yet. Packaging is ready: Node refuses to strip types under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so `prepack` compiles `src/` to `dist/` and the
bin runs `dist/` when it is installed under `node_modules`, the sources otherwise.
`pnpm smoke:pack` (also in CI) packs the tarball, installs it with npm into a scratch project and
runs `import` → `plan` → `apply` → `status` against a scratch HOME.

### First run, without touching anything

```bash
loadout import               # preview a manifest derived from every ~/.claude* / ~/.codex*
loadout import --write       # write ~/.config/agent-loadout/loadout.toml (secrets → keychain)
loadout plan                 # should list only "adopt": it records what exists, changes nothing
loadout apply                # take ownership; from here on edit the manifest, or toggle
```

Paths default to `~/.config/agent-loadout/loadout.toml` and `~/.local/state/agent-loadout/`;
override with `--manifest` / `--state` or `LOADOUT_MANIFEST` / `LOADOUT_STATE`. Point both at a
scratch folder to try it on copies first.

## Usage

```bash
loadout import            # print a manifest derived from the current setup
loadout import --write    # write it to ~/.config/agent-loadout/loadout.toml
loadout plan              # dry run (exit 2 if anything is blocked)
loadout apply             # reconcile; the first run after import only "adopts"
loadout apply --only mcp:context7 --only 'hook:*@codex'   # just these; the rest stays pending
loadout status [--json]   # resource × target matrix (JSON feeds the herdr mod)

loadout toggle ddd-discovery claude-work on    # flip one resource for one account
loadout toggle skill:code-review codex-work off --no-apply

loadout release ddd-discovery claude-work      # stop managing it there, keep the files
loadout history                                # journaled runs, newest first
loadout prune --dry-run                        # what the retention policy would delete
loadout restore latest [--only mcp:zhtw@codex] [--dry-run]   # undo a run, entry by entry

loadout status --unmanaged                     # also list what the manifest doesn't cover
loadout adopt ~/.codex/skills/gsap-core --into ~/agent-config/skills [--dry-run]
loadout agent extract task-worker --out ~/agent-config/agents/task-worker.md [--add]
```

`--only <resource>[@<target>]` (repeatable, OR-ed) narrows `plan`, `apply` and `restore`.
`<resource>` is `kind:name`, a bare name, `kind:*` or `*`. A selector that matches nothing is an
error (exit 64), so a typo never looks like a successful no-op.

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

| Kind           | Claude target                                  | Codex target                       | Driver            |
| -------------- | ---------------------------------------------- | ---------------------------------- | ----------------- |
| `instructions` | `CLAUDE.md`                                    | `AGENTS.md`                        | symlink           |
| `skill`        | `skills/<name>`                                | `skills/<name>`                    | symlink           |
| `command`      | `commands/<name>.md`                           | unsupported                        | symlink           |
| `agent`        | `agents/<name>.md`                             | `agents/<name>.toml`               | generated file    |
| `hook`         | `settings.json` → `hooks.<Event>[]`            | `hooks.json` → `hooks.<Event>[]`   | owned array item  |
| `mcp`          | `.claude.json` → `mcpServers.<name>`           | `config.toml` → `[mcp_servers.x]`  | owned key / table |
| `plugin`       | `settings.json` → `enabledPlugins.<id>`        | `config.toml` → `[plugins."id"]`   | owned key / table |
| `marketplace`  | `settings.json` → `extraKnownMarketplaces.<n>` | `config.toml` → `[marketplaces.x]` | owned key / table |

Claude Code and Codex are built-in adapters (`src/tools/`); supporting another CLI agent means
adding one adapter file (see "Adding a tool" in `AGENTS.md`).

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

[[marketplace]]            # Codex format: source_type + source (a string)
name = "hub-codex"
key = "hub"
source_type = "git"        # git | local (local: a path; "~/" is expanded)
source = "https://github.com/org/hub.git"
ref = "main"               # optional, as are sparse_paths = ["…"]
to = ["tool:codex"]
```

A marketplace is written in one tool's own format, and that format decides where it can go: a
`source = { … }` table is Claude's, `source_type` + `source` is Codex's; other targets show `n/a`.
Codex only reads its config, so `plan` warns when a Git marketplace isn't cloned yet or an
enabled plugin isn't installed, with the command to run (`codex plugin marketplace upgrade`,
`codex plugin add <id>`). Marketplaces the Codex app unpacks itself import as `mode = "observe"`.

### Splitting the manifest

```toml
include = ["~/agent-config/work.toml", "./mcp.toml"]   # top level of any manifest file
```

Included files hold targets, sources and resources like the root; everything merges into one
manifest, so a selector may name a target defined in another file. Relative paths resolve against
the including file's folder, includes may nest, a file included twice is read once, and a cycle
is an error. Names stay unique across files (errors name the file). `[shared]` and `[backups]`
belong to the root only.

`toggle`, `release` and `adopt` edit the file that defines the resource (`adopt` appends new
entries to the root), and `restore` puts that file back. Typical split: the root and personal
entries in a personal repo, `include` a work file kept in the company's repo.

Selectors: `*`, `<target>`, `tag:<tag>`, `tool:<tool>`, prefix `!` to exclude. `to = []` keeps a
resource in the catalog but off everywhere. A leading `~/` in `path`, `dir` and `command` is
expanded.

### Project targets

A target can be a repository instead of a profile folder:

```toml
[targets.web]
tool = "claude"
dir = "~/Workspace/web"
scope = "project"
visibility = "local"       # default; or "shared"
profile = "claude-work"    # local Claude only: whose .claude.json stores its MCP servers
```

| Kind                        | Claude · local                               | Claude · shared         | Codex · local    | Codex · shared                                              |
| --------------------------- | -------------------------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------- |
| instructions                | `CLAUDE.local.md` (link)                     | `CLAUDE.md` (copy)      | –                | `AGENTS.md` (copy)                                          |
| skill                       | `.claude/skills/<name>` (link)               | same path (copy)        | `.agents/skills` | `.agents/skills` (copy)                                     |
| command                     | `.claude/commands/<name>.md` (link)          | same path (copy)        | –                | –                                                           |
| agent                       | `.claude/agents/<name>.md`                   | same path               | –                | –                                                           |
| hook / plugin / marketplace | `.claude/settings.local.json`                | `.claude/settings.json` | –                | `.codex/hooks.json` · `.codex/config.toml` (no marketplace) |
| mcp                         | profile's `.claude.json` → `projects[<dir>]` | `.mcp.json`             | –                | `.codex/config.toml`                                        |

- **local** writes only what stays on this machine. Links and generated files inside the
  repository are added to `.git/info/exclude` (owned lines, removed again with the resource), so
  `git status` stays clean. Codex has no personal layer inside a repository, so only skills apply.
- **shared** writes the files the repository commits, for the whole team. Skills, commands and
  instructions are copied (a link into your home folder would dangle for everyone else) and
  compared by content; a copy a teammate edited is a conflict. Values must not contain resolved
  secrets: write `$${env:NAME}` to emit `${NAME}`, which Claude Code expands itself. `restore`
  doesn't undo copies; use git.
- `*` and `tool:` select profiles only. A project target is selected by name or by a tag you give
  it, so adding one never pulls every `["*"]` resource into the repository.
- Codex loads a repository's `.codex/` layer only once you trust the project. Cells marked `–`
  have no documented location and are unsupported rather than guessed.

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
- **Retention.** A run (journal + backups) is kept while it is among the newest `keep` runs **or**
  younger than `max_age_days`; every writing command prunes the rest afterwards, always keeping
  the run it just made. `loadout prune [--keep N] [--older-than DAYS] [--dry-run]` does it on
  demand. Only folders named like a run id are ever deleted.

  ```toml
  [backups]          # defaults
  keep = 20
  max_age_days = 30
  ```

- **Codex hook trust** is keyed by array index in `config.toml` (`[hooks.state]`). loadout
  appends new hook groups and replaces changed ones in place so existing indices stay stable. It
  never writes trust state: Codex asks you to approve new hooks itself.
- **One writer at a time.** Commands that write (`apply`, `toggle`, `release`, `restore`, `adopt`, `import --write`,
  `agent extract --add`) take an inter-process lock next to the state file, so the herdr mod and
  the CLI can't interleave and lose ownership records. A busy lock waits up to 10 s, then exits
  75 naming the holder; a lock left by a dead process is taken over.

## Known limits

- Backups and journals may contain resolved secrets; they live in a `0700` directory under
  `~/.local/state/agent-loadout/backups/` (journals are `0600`), and are pruned by the retention policy above.
- `restore` of a TOML table rewrites that block in loadout's own formatting; comments inside the
  block are only in the full-file backup. Undoing `adopt` isn't journaled.
- App-managed entries (e.g. Codex's bundled `computer-use` / `node_repl` MCP servers) change on
  app updates; drop them from the manifest instead of owning them.
- TOML tables defined with dotted keys at the root (`mcp_servers.x.command = …`) are not edited.

## Roadmap

| Version | Scope                                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| v0.1 ✓  | skills, instructions · import / plan / apply / status                                       |
| v0.2 ✓  | commands, agents (rendered), hooks / MCP / plugins / marketplaces (owned patches)           |
| v0.3 ✓  | secret references · observe mode · toggle · herdr mod · lock · adopt · agent extract        |
| v0.4 ✓  | Codex shared layer · rebase writes · journal / restore / history · release · prune · --only |
| next    | settings fragments · `doctor` (managed-policy awareness) · build for npm · manifest include |

## License

[MIT](LICENSE) © 2026 Andy Hung
