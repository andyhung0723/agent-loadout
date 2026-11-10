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
```

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

Selectors: `*`, `<target>`, `tag:<tag>`, `tool:<tool>`, prefix `!` to exclude. A leading `~/` in
`path`, `dir` and `command` is expanded.

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

## Safety model

- **Ownership.** Only units recorded in `state.json` are ever replaced or removed. Anything else
  at a destination is a **conflict** and stays untouched; an owned unit edited by hand is a
  conflict while desired and is **forgotten** (not deleted) once dropped from the manifest.
- **Surgical patches.** JSON is rewritten as a whole object but only owned keys/items change;
  `config.toml` is edited at table-block level, so comments and formatting elsewhere survive.
- **Optimistic writes.** Each patched file is re-read before writing; if it changed since `plan`
  (e.g. a running Claude session saved `.claude.json`), that file is skipped and reported.
- **Backups.** Every file loadout overwrites is copied to
  `~/.local/state/agent-loadout/backups/<timestamp>/` first. File modes are preserved.
- **Codex hook trust** is keyed by array index in `config.toml` (`[hooks.state]`). loadout
  appends new hook groups and replaces changed ones in place so existing indices stay stable. It
  never writes trust state: Codex asks you to approve new hooks itself.

## Known limits

- Secrets: `import` copies values verbatim and flags likely secrets with a `⚠` comment. Move
  them to env vars before committing the manifest (secret references are on the roadmap).
- App-managed entries (e.g. Codex's bundled `computer-use` / `node_repl` MCP servers) change on
  app updates; drop them from the manifest instead of owning them.
- TOML tables defined with dotted keys at the root (`mcp_servers.x.command = …`) are not edited.

## Roadmap

| Version | Scope                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| v0.1 ✓  | skills, instructions · import / plan / apply / status                                 |
| v0.2 ✓  | commands, agents (rendered), hooks / MCP / plugins / marketplaces (owned patches)     |
| v0.3    | settings fragments, secret references, `doctor` (managed-policy awareness), herdr mod |
