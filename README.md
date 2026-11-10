# agent-loadout

Declarative manager for what each Claude Code / Codex profile loads — one manifest, many targets
(`~/.claude`, `~/.claude-work`, `~/.codex`, `~/.codex-work`, …).

```
loadout.toml (desired state) ──plan──▶ actions ──apply──▶ symlinks / config patches
                                   ▲                         │
                     state.json (what loadout owns) ◀────────┘
```

## Usage

```bash
pnpm install && pnpm link --global      # exposes `loadout` (Node >= 24, runs TS natively)

loadout import            # print a manifest generated from existing symlinks
loadout import --write    # write it to ~/.config/agent-loadout/loadout.toml
loadout plan              # dry run
loadout apply             # reconcile; first run after import only "adopts"
loadout status [--json]   # resource × target matrix (JSON feeds the herdr mod)
```

## Manifest

```toml
[targets.claude-work]
tool = "claude"          # claude | codex
dir = "~/.claude-work"
tags = ["work"]

[sources]
toolkit = "~/Workspace/claude/claude-toolkit/skills"

[[skill]]
name = "code-review"
from = "toolkit"         # or: path = "~/abs/path/to/skill"
to = ["*", "!codex-work"]

[[instructions]]          # → CLAUDE.md (claude) / AGENTS.md (codex)
path = "~/Workspace/claude/CLAUDE.md"
to = ["*"]
```

Selectors: `*`, `<target>`, `tag:<tag>`, `tool:<tool>`, prefix `!` to exclude.

## Safety model

- Only paths recorded in `state.json` are ever replaced or removed.
- A real file/dir or a foreign symlink at a destination is a **conflict** and is left untouched.
- An owned link edited by hand is **forgotten**, not deleted.

## Roadmap

| Version | Scope                                                                         |
| ------- | ----------------------------------------------------------------------------- |
| v0.1    | skills, instructions (link) · import / plan / apply / status                  |
| v0.2    | sub-agents & commands (format transform), hooks / MCP / plugins (owned patch) |
| v0.3    | settings fragments, `doctor` (managed-policy awareness), herdr-app mod        |
