# Agent Loadout (`agent-loadout`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/andyhung0723/agent-loadout/actions/workflows/ci.yml/badge.svg)](https://github.com/andyhung0723/agent-loadout/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%3E%3D24-green.svg)](<>)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey.svg)](<>)

用**一份宣告式 manifest** 管理每個 Claude Code / Codex 帳號（profile）要載入哪些 Skills、Agents、Hooks、MCP Servers 與 Plugins。
一份 `loadout.toml` 同時驅動多個 target（`~/.claude`、`~/.claude-work`、`~/.codex`、`~/.codex-work`…），從此不用再手動在各個設定檔之間複製貼上。

---

## 🌟 核心概念 (How It Works)

```
loadout.toml ──▶ units (resource × target) ──plan──▶ actions ──apply──▶ symlinks / files / config patches
                                                  ▲                          │
                                   state.json (what loadout owns) ◀──────────┘
```

- **Resource × Target = Unit**：manifest 裡每個資源（例如一個 skill）對每個 target（例如 `~/.claude-work`）展開成一個 unit，各自決定要建立、取代、移除或保持不動。
- **只動自己擁有的東西**：`state.json` 記錄哪些 unit 是 loadout 放上去的。不在紀錄裡的既有設定一律視為衝突、原封不動。
- **先 `plan` 再 `apply`**：跟 Terraform 一樣，先看會改什麼，再實際套用。每次寫入都有備份與 journal，可以逐筆 `restore`。

---

## 📦 安裝說明 (Installation)

需求：**Node >= 24**（直接執行 TypeScript 原始碼，開發時不用 build）與 pnpm。
主要平台是 macOS：`${keychain:…}` secrets 需要系統的 `security` 指令；其餘功能 Linux 也能用（CI 兩個平台都跑）。

```bash
git clone https://github.com/andyhung0723/agent-loadout.git
cd agent-loadout
pnpm install
pnpm add -g "link:$PWD"     # 把 `loadout` 放進 PATH，指向這個 checkout
loadout help
```

- 更新：`git pull` 即可，指令會直接使用最新原始碼。
- 移除：`pnpm remove -g agent-loadout`。
- 沒有設定 pnpm global 時，用 symlink 也可以：`ln -s "$PWD/bin/loadout.js" ~/.local/bin/loadout`。

> **尚未發布到 npm**，但打包流程已就緒。Node 拒絕對 `node_modules` 底下的檔案做 type stripping（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以 `prepack` 會把 `src/` 編譯到 `dist/`，bin 在 `node_modules` 底下時改跑 `dist/`。`pnpm smoke:pack`（CI 也會跑）會打包 tarball、用 npm 裝進暫存專案，再對暫存 HOME 跑一輪 `import` → `plan` → `apply` → `status`。

---

## 🚀 快速開始 (First Run)

第一次使用時，先讓 loadout「接收」現有設定，**不會改動任何東西**：

```bash
loadout import               # 預覽：從所有 ~/.claude* / ~/.codex* 推導出 manifest
loadout import --write       # 寫入 ~/.config/agent-loadout/loadout.toml（secrets 自動轉存 keychain）
loadout plan                 # 應該只列出 "adopt"：只記錄現況，不做任何變更
loadout apply                # 正式接管；之後改 manifest 或用 toggle 切換即可
```

預設路徑：

| 檔案           | 預設位置                                      | 覆寫方式                           |
| -------------- | --------------------------------------------- | ---------------------------------- |
| Manifest       | `~/.config/agent-loadout/loadout.toml`        | `--manifest` 或 `LOADOUT_MANIFEST` |
| State          | `~/.local/state/agent-loadout/state.json`     | `--state` 或 `LOADOUT_STATE`       |
| 備份與 journal | `~/.local/state/agent-loadout/backups/<run>/` | 跟著 state 的位置                  |

> **提示**：想先在副本上試，把 `--manifest` 和 `--state` 都指到暫存資料夾即可。

---

## ⌨️ 指令速查 (Command Reference)

### 日常操作

| 指令                                         | 說明                                                     |
| :------------------------------------------- | :------------------------------------------------------- |
| `loadout status [--json]`                    | 顯示 resource × target 矩陣（JSON 供 herdr mod 使用）    |
| `loadout plan`                               | Dry run，列出 apply 會做的變更（有東西被擋下時 exit 2）  |
| `loadout apply`                              | 讓所有 target 對齊 manifest；import 後的第一次只會 adopt |
| `loadout toggle <resource> <target> on\|off` | 針對單一帳號開關某個資源，只套用這一個資源               |
| `loadout history`                            | 列出有 journal 的執行紀錄，新的在前                      |
| `loadout restore <run>\|latest`              | 逐筆復原某次執行                                         |

```bash
loadout toggle ddd-discovery claude-work on    # 在 claude-work 開啟
loadout toggle skill:code-review codex-work off --no-apply   # 只改 manifest，不套用
loadout apply --only mcp:context7 --only 'hook:*@codex'      # 只套用這些，其餘保持 pending
loadout restore latest --only mcp:zhtw@codex --dry-run
```

### 接管既有設定 (Bringing Things Under Management)

| 指令                                                | 用途                                                                                                            |
| :-------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `loadout status --unmanaged`                        | 同時列出 manifest 沒涵蓋的項目                                                                                  |
| `loadout adopt <path> --into <dir>`                 | 把 profile 裡的實體 skill 目錄（或 Claude command 檔）搬到來源資料夾、連結回去並寫進 manifest                   |
| `loadout capture <kind>:<name> <target>`            | 接管工具自己裝的 hook / MCP / plugin / marketplace（例如 `claude mcp add`、`/plugin install`、`codex mcp add`） |
| `loadout agent extract <name> --out <file> [--add]` | 從既有的 `.md` / `.toml` 產生中性 agent 原始檔                                                                  |

- **`adopt`**：其他 profile 裡若有內容完全相同的副本，會移到備份資料夾並連到同一份來源；內容不同則拒絕。
- **`capture`**：把線上的定義轉成 manifest entry（secrets 跟 `import` 一樣轉成 reference），再只套用這一筆，也就是只記錄擁有權。manifest 已有完全相同的 entry 時，只把 target 加進它的 `to`；內容不同則拒絕。keychain 名稱已存了別的值也會拒絕。Skills 與 commands 請用 `adopt`，agents 請用 `agent extract`。
- **`agent extract`**：會回報哪些 profile 能逐位元組重現，這些 profile 會直接 adopt、不重寫。

### 放手與清理 (Letting Go)

| 指令                                                       | 用途                                                                  |
| :--------------------------------------------------------- | :-------------------------------------------------------------------- |
| `loadout toggle … off`                                     | **刪除** loadout 放上去的東西                                         |
| `loadout release <resource> [<target>…]`                   | **保留檔案**、停止管理：從 `to` 移除並忘記擁有權（預設：所有 target） |
| `loadout prune [--keep N] [--older-than DAYS] [--dry-run]` | 手動清理超出保留策略的舊執行紀錄                                      |

`release` 後，symlink 或設定值會留著變成 unmanaged 項目（`status --unmanaged` 看得到），適合交還給手動管理或其他工具。它跟其他寫入一樣有 journal，`restore` 可以把擁有權拿回來。

**`toggle` 的運作方式**：只改 manifest 裡該 entry 的 `to` 那一行（保留註解與排版），並用最小變動達成要求，例如 `["*"]` 變成 `["*", "!codex-work"]`，再開回來時會把排除項移掉。接著**只套用這一個資源**，不會把 manifest 其他還沒套用的修改一起帶進去。

> **提示**：skills、MCP servers 與 hooks 都在 session 啟動時載入，toggle 之後要重開目標帳號的 session。

### Secrets

```bash
pbpaste | loadout secret set github     # → ${keychain:agent-loadout/github}
loadout secret check github             # exit 0 存在 / 2 不存在；永遠不印出值
```

### `--only` 選擇器

`--only <resource>[@<target>]` 可重複指定（OR 邏輯），適用於 `plan`、`apply` 與 `restore`。
`<resource>` 可以是 `kind:name`、單純的 name、`kind:*` 或 `*`。**選擇器沒有命中任何東西時會報錯**（exit 64），打錯字不會被當成成功的 no-op。

### Exit Codes

| Code | 意義                            |
| :--- | :------------------------------ |
| `0`  | 成功                            |
| `2`  | 被擋下（conflict / unresolved） |
| `64` | 用法錯誤（含 `--only` 沒命中）  |
| `65` | Manifest 錯誤                   |
| `75` | 被其他寫入程序鎖住              |

---

## 🧩 支援的資源類型 (What It Manages)

| Kind           | Claude target                                  | Codex target                       | Driver             |
| :------------- | :--------------------------------------------- | :--------------------------------- | :----------------- |
| `instructions` | `CLAUDE.md`                                    | `AGENTS.md`                        | symlink            |
| `skill`        | `skills/<name>`                                | `skills/<name>`                    | symlink            |
| `command`      | `commands/<name>.md`                           | 不支援                             | symlink            |
| `agent`        | `agents/<name>.md`                             | `agents/<name>.toml`               | 產生的檔案         |
| `hook`         | `settings.json` → `hooks.<Event>[]`            | `hooks.json` → `hooks.<Event>[]`   | 擁有的陣列項目     |
| `mcp`          | `.claude.json` → `mcpServers.<name>`           | `config.toml` → `[mcp_servers.x]`  | 擁有的 key / table |
| `plugin`       | `settings.json` → `enabledPlugins.<id>`        | `config.toml` → `[plugins."id"]`   | 擁有的 key / table |
| `marketplace`  | `settings.json` → `extraKnownMarketplaces.<n>` | `config.toml` → `[marketplaces.x]` | 擁有的 key / table |

Claude Code 與 Codex 是內建的 adapter（`src/tools/`）。要支援其他 CLI agent，只要新增一個 adapter 檔案（見 `AGENTS.md` 的「Adding a tool」）。

### Status 圖例

```
✓ in place  + pending  ! conflict  ✗ unresolved  ○ observed  ◌ absent  ↥ inherited (shared layer)  · off  - unsupported
```

---

## 📝 Manifest 寫法 (Manifest)

```toml
[targets.claude-work]
tool = "claude"            # claude | codex
dir = "~/.claude-work"
tags = ["work"]

[sources]
toolkit = "~/Workspace/claude/claude-toolkit/skills"

[[skill]]
name = "code-review"
from = "toolkit"           # 或：path = "~/abs/path"
to = ["*", "!codex-work"]

[[hook]]
name = "atuin"
events = ["PreToolUse", "PostToolUse"]
matcher = "Bash"
command = "~/.atuin/bin/atuin hook claude-code"
to = ["*"]
[hook.codex]               # 依工具覆寫，合併到基本定義之上
matcher = "^Bash$"
command = "~/.atuin/bin/atuin hook codex"

[[mcp]]
name = "zhtw"
command = "~/.local/bin/zhtw-mcp"   # 或：url = "...", headers = { ... }
env = { ZHTW_NO_NETWORK = "1" }
to = ["tag:work"]

[[plugin]]
name = "figma@claude-plugins-official"
enabled = true
to = ["tool:claude"]

[[marketplace]]
name = "hub-work"
key = "hub"                # 設定檔裡的 key，需要跟 name 不同時才填（預設等於 name）
source = { source = "github", repo = "org/hub" }
to = ["claude-work"]

[[marketplace]]            # Codex 格式：source_type + source（字串）
name = "hub-codex"
key = "hub"
source_type = "git"        # git | local（local 為路徑，會展開 "~/"）
source = "https://github.com/org/hub.git"
ref = "main"               # 選填，sparse_paths = ["…"] 也是
to = ["tool:codex"]
```

### 選擇器 (Selectors)

| 寫法          | 選到                        |
| :------------ | :-------------------------- |
| `*`           | 所有 profile target         |
| `<target>`    | 指定名稱的 target           |
| `tag:<tag>`   | 帶有該 tag 的 target        |
| `tool:<tool>` | 該工具的所有 profile target |
| `!…`          | 排除（前綴）                |

- `to = []`：資源留在目錄裡，但所有地方都關閉。
- `path`、`dir`、`command` 開頭的 `~/` 會自動展開。

### Marketplace 格式

Marketplace 用某一個工具自己的格式撰寫，格式決定它能套用到哪裡：`source = { … }` table 是 Claude 格式，`source_type` + `source` 是 Codex 格式；其他 target 會顯示 `n/a`。
Codex 只讀設定檔，所以當 Git marketplace 還沒 clone、或啟用的 plugin 還沒安裝時，`plan` 會提出警告並附上要執行的指令（`codex plugin marketplace upgrade`、`codex plugin add <id>`）。Codex app 自己解開的 marketplace 會以 `mode = "observe"` 匯入。

### 只觀察不管理 (Observe Mode)

```toml
[[mcp]]
name = "node_repl"
command = "/Applications/ChatGPT.app/node_repl"
mode = "observe"           # manage（預設）| observe
to = ["tool:codex"]
```

- `observe` 的資源**永遠不寫入**，即使設定不存在或已經偏移，只在 `status` 顯示 `○ observed` / `◌ absent`。
- 把已擁有的資源切成 `observe` 會釋放擁有權，但**不刪除**任何東西。
- `import` 會自動把 app 內建的 MCP servers 與 plugins 標成 `observe`，因為它們會隨 app 更新變動。

### 拆分 Manifest (Include)

```toml
include = ["~/agent-config/work.toml", "./mcp.toml"]   # 任何 manifest 檔的最上層
```

- 被 include 的檔案跟 root 一樣可以放 targets、sources 與 resources，全部合併成同一份 manifest，所以選擇器可以指到別的檔案定義的 target。
- 相對路徑以 include 它的檔案所在資料夾為基準；可以巢狀 include；同一個檔案只讀一次；循環 include 會報錯。
- 名稱跨檔案必須唯一（錯誤訊息會標出檔名）。`[shared]` 與 `[backups]` 只能放在 root。
- `toggle`、`release`、`adopt` 會修改**定義該資源的那個檔案**（`adopt` 新增的 entry 一律加在 root），`restore` 也會還原那個檔案。

> **典型拆法**：root 與個人設定放在個人 repo，再 `include` 一份放在公司 repo 的工作設定。

### 專案 Target (Project Targets)

Target 也可以是一個 repository，而不是 profile 資料夾：

```toml
[targets.web]
tool = "claude"
dir = "~/Workspace/web"
scope = "project"
visibility = "local"       # 預設；或 "shared"
profile = "claude-work"    # 只有 local Claude 需要：MCP servers 存在哪個 profile 的 .claude.json
```

| Kind                        | Claude · local                                | Claude · shared         | Codex · local    | Codex · shared                                                 |
| :-------------------------- | :-------------------------------------------- | :---------------------- | :--------------- | :------------------------------------------------------------- |
| instructions                | `CLAUDE.local.md`（link）                     | `CLAUDE.md`（copy）     | –                | `AGENTS.md`（copy）                                            |
| skill                       | `.claude/skills/<name>`（link）               | 同路徑（copy）          | `.agents/skills` | `.agents/skills`（copy）                                       |
| command                     | `.claude/commands/<name>.md`（link）          | 同路徑（copy）          | –                | –                                                              |
| agent                       | `.claude/agents/<name>.md`                    | 同路徑                  | –                | –                                                              |
| hook / plugin / marketplace | `.claude/settings.local.json`                 | `.claude/settings.json` | –                | `.codex/hooks.json` · `.codex/config.toml`（不含 marketplace） |
| mcp                         | profile 的 `.claude.json` → `projects[<dir>]` | `.mcp.json`             | –                | `.codex/config.toml`                                           |

- **local**：只寫留在本機的東西。repository 內的 link 與產生的檔案會加進 `.git/info/exclude`（由 loadout 擁有，移除資源時一併移除），`git status` 保持乾淨。Codex 在 repository 裡沒有個人層，所以只有 skills 適用。
- **shared**：寫入會 commit 的檔案，給整個團隊用。Skills、commands 與 instructions 用**複製**（指向你 home 的 link 對其他人來說是斷的），並以內容比對；隊友改過的副本視為衝突。值裡**不能有已解析的 secret**：寫 `$${env:NAME}` 會輸出 `${NAME}`，由 Claude Code 自己展開。`restore` 不會復原複製的檔案，請用 git。
- **不會意外外洩**：`*` 與 `tool:` 只選 profile。專案 target 只能用名稱或你給它的 tag 選到，新增專案 target 不會把所有 `["*"]` 資源拉進 repository。
- Codex 要等你信任該專案後才會載入 repository 的 `.codex/` 層。標 `–` 的格子沒有官方文件記載的位置，因此不支援，不做猜測。

### Agents

一份中性的 Markdown 原始檔同時產出兩種格式。`name` / `description` 共用，其他最上層 key 只給 Claude，`claude:` / `codex:` 區塊則各自套用。內文會變成 Claude 的 prompt 與 Codex 的 `developer_instructions`。

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

### 共用層 (Codex Shared Layers)

Codex 從兩個地方載入 skills：profile 自己的 `$CODEX_HOME/skills`，以及**所有** Codex profile 都會載入的 `~/.agents/skills`（在 codex-cli 0.167 上，從注入 session 的 skill 清單驗證過）。所以「依帳號開關」只對連結到 `$CODEX_HOME/skills` 的 skill 有效。

- `status` 會把共用資料夾裡的 skill，在沒有明確啟用它的每個 Codex target 上標成 `↥ inherited`；若某個 profile 又另外啟用，會警告重複載入。
- 對 inherited 格子 `toggle … off` 會被拒絕並附提示；`toggle … on` 會回報已經是開的。
- `status --unmanaged` 會列出 manifest 沒提到的共用 skill。
- `~/.agents/skills` 只放每個 Codex profile 都該有的 skill。要改資料夾清單：

```toml
[shared]
codex_skills = ["~/.agents/skills"]
```

---

## 🔐 Secrets 管理 (Secrets)

`hook`、`mcp`、`plugin` 與 `marketplace` 的字串值可以引用 secret，manifest 因此可以安心放進 git：

```toml
[[mcp]]
name = "context7"
command = "npx"
args = ["-y", "@upstash/context7-mcp", "--api-key", "${keychain:context7}"]
headers = { Authorization = "Bearer ${env:GITHUB_TOKEN}" }
to = ["*"]
```

| Reference         | 來源                                                           |
| :---------------- | :------------------------------------------------------------- |
| `${env:NAME}`     | `loadout` 程序的環境變數                                       |
| `${keychain:svc}` | macOS Keychain（`… \| loadout secret set svc`，從 stdin 讀入） |
| `$${env:NAME}`    | 跳脫：寫出字面上的 `${env:NAME}`                               |

- Secrets 在 plan / apply 時解析，寫進目標設定檔讓工具讀取。**永遠不會出現在 `state.json`**（只存 SHA-256 指紋）、plan 輸出或 JSON 輸出。
- 無法解析的 reference 會把 unit 標成 `unresolved`，什麼都不寫。
- 輪替 secret 會顯示為 `replace`。

### Import 自動轉換

`loadout import` 會掃描 MCP servers、hooks 與 marketplaces 寫出的字串（args、env、headers、URL query、hook 指令），把 secret 換成 reference。偵測看的是**值本身**，不只是 key：

- 任何位置的已知 token 格式（`sk-…`、`ghp_…`、`ctx7sk-…`、JWT…）
- secret 名稱 key 底下的不透明值、旗標（`--api-key x`、`--token=x`）、`Authorization` / `Bearer` 與 query 參數
- 同一個值用在多處只會產生一個 reference
- 沒有其他訊號的長高熵字串只會標 `# ⚠`，不會轉換

| `--secrets`              | Reference                          | `--write` 時另外               |
| :----------------------- | :--------------------------------- | :----------------------------- |
| `keychain`（macOS 預設） | `${keychain:agent-loadout/<name>}` | 把每個值存進 login keychain    |
| `env`                    | `${env:LOADOUT_<NAME>}`            | 不做事，只列出要 export 的變數 |
| `keep`                   | 無（保留原值，加 `⚠` 註解）        | –                              |

### 手動新增

把 secret pipe 給 `loadout secret set <name>`（沒有 `/` 的名稱會自動加上 `agent-loadout/` 前綴），再把印出的 reference 填進 entry。**它拒絕從終端機讀取**，避免值留在 shell history。`loadout secret check <name>` 讓 agent 確認 reference 能否解析，而不洩漏任何內容。

- Keychain 寫入透過 stdin 傳給 `security -i`，不會出現在命令列，寫完會讀回驗證。
- `import` 的文字與 `--json` 輸出都不含 secret 值。

> **建議優先用 keychain**：`${env:…}` 必須在執行 `loadout apply` 的 shell 裡 export，從 herdr mod 觸發 apply 時很容易忘記。

---

## 🛡️ 安全模型 (Safety Model)

| 機制                | 保證                                                                                                                                                                                                                                                    |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **擁有權**          | 只有記錄在 `state.json` 的 unit 才會被取代或移除。目的地上的其他東西都是**衝突**，原封不動；手動改過的已擁有 unit，在仍需要時是衝突，從 manifest 移除後會被**遺忘**（不刪除）                                                                           |
| **精準修改**        | JSON 整個物件重寫，但只改擁有的 key / 項目；`config.toml` 以 table block 為單位編輯，其他地方的註解與格式保持不變                                                                                                                                       |
| **樂觀寫入**        | 每個要修改的檔案在寫入前重新讀取。若 `plan` 之後被其他程序改過（執行中的 Claude session 會一直存 `.claude.json`），只比對 plan 讀過或要改的 key：沒變就把修改重放到新內容上；有變就跳過該檔案並指出是哪個 key                                           |
| **備份與復原**      | 每個被覆寫的檔案都先複製到 `backups/<run>/`，保留檔案權限。`apply`、`toggle`、`release`、`restore` 會寫 `journal.json`，記錄每筆的前後值與擁有權                                                                                                        |
| **單一寫入者**      | 寫入類指令（`apply`、`toggle`、`release`、`restore`、`adopt`、`capture`、`import --write`、`agent extract --add`）會在 state 旁取得跨程序鎖，herdr mod 與 CLI 不會交錯寫入。鎖被占用時最多等 10 秒，之後 exit 75 並指出持有者；已死程序留下的鎖會被接管 |
| **Codex hook 信任** | Codex 用陣列 index 記錄 hook 信任（`[hooks.state]`）。loadout 新的 hook group 一律附加在後、改過的就地取代，既有 index 不變；**從不寫入信任狀態**，由 Codex 自己詢問你                                                                                  |

### 逐筆復原 (Restore)

`restore <run>` 從最新的一筆開始反向重放 journal，**只在該位置仍是那次執行寫入的內容時**才復原，之後改過的會回報並保留。跟直接把整個備份檔複製回去不同，這樣能保留檔案裡其他後來的變更。

- 復原 toggle 時，若 manifest 之後沒被改過，也會還原 manifest 那一行。
- 復原 `apply` 不會動 manifest，所以下次 `apply` 會重做。
- restore 本身也有 journal，可以再復原。

### 保留策略 (Retention)

一次執行（journal + 備份）只要符合**任一**條件就保留：在最新的 `keep` 次之內，**或**比 `max_age_days` 新。每個寫入類指令結束後會自動清理其餘的，並且一定保留剛產生的那次。只會刪除名稱符合 run id 格式的資料夾。

```toml
[backups]          # 預設值
keep = 20
max_age_days = 30
```

---

## 🔌 與 Herdr 整合 (Herdr Integration)

[`herdr-mods`](https://github.com/andyhung0723/herdr-mods) 裡的 [`herdr-loadout`](https://github.com/andyhung0723/herdr-mods/tree/main/herdr-loadout) mod 提供視覺化矩陣（`Ctrl+B L`），透過 `loadout status --json` 讀取狀態、呼叫 `toggle` 切換。`--json` 的輸出格式視為介面：只會新增欄位，不會改名或移除。

---

## 🧪 開發與測試 (Development)

```bash
pnpm test         # node --test，執行 test/ 下所有測試
pnpm typecheck    # tsc（不輸出）
pnpm format       # prettier --write .
pnpm smoke:pack   # 打包、用 npm 安裝 tarball，對暫存 HOME 跑一輪
node bin/loadout.js <command> --manifest <file> --state <file>   # 對 sandbox 執行
```

- CI（`.github/workflows/ci.yml`）在 macOS 與 Linux 上跑 typecheck、測試、`smoke:pack` 與 `prettier --check`。
- 測試一律使用 `Sandbox` helper（暫存 HOME），**從不碰真實的 `~/.claude*` / `~/.codex*`**。
- 架構、模組職責、不變式與「新增工具」的步驟請見 [`AGENTS.md`](AGENTS.md)。

---

## ⚠️ 已知限制 (Known Limits)

- 備份與 journal 可能含有已解析的 secret。它們放在 `0700` 的 `~/.local/state/agent-loadout/backups/`（journal 為 `0600`），並依保留策略清理。
- `restore` TOML table 時會用 loadout 自己的格式重寫該 block；block 內的註解只存在於完整備份檔。`adopt` 沒有 journal，無法用 `restore` 復原。
- App 管理的項目（例如 Codex 內建的 `computer-use` / `node_repl` MCP servers）會隨 app 更新變動，請改用 `mode = "observe"` 或從 manifest 移除，不要接管。
- Codex 的 hooks 要在該 profile 的 `config.toml` 設定 `[features] hooks = true` 才會生效。loadout 不會替你打開這個開關，只會在 `plan` / `status` 提出警告。
- 在 root 用 dotted key 定義的 TOML table（`mcp_servers.x.command = …`）不會被編輯。

---

## 🗺️ Roadmap

| 版本   | 範圍                                                                                                                 |
| :----- | :------------------------------------------------------------------------------------------------------------------- |
| v0.1 ✓ | skills、instructions · import / plan / apply / status                                                                |
| v0.2 ✓ | commands、agents（產生檔案）、hooks / MCP / plugins / marketplaces（擁有的 patch）                                   |
| v0.3 ✓ | secret references · observe mode · toggle · herdr mod · lock · adopt · agent extract                                 |
| v0.4 ✓ | Codex 共用層 · rebase 寫入 · journal / restore / history · release · prune · `--only`                                |
| v0.5 ✓ | manifest include · 專案 target · tool adapter 介面 · npm 打包（`dist/`）· Codex marketplaces · capture · secret 指令 |
| next   | settings fragments · `doctor`（感知 managed policy）· 發布到 npm                                                     |

---

## 📄 License

[MIT](LICENSE) © 2026 Andy Hung
