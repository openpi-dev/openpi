# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.

## Configure this package

Use the single package-owned command. With no arguments, the current model explains the configurable areas and their impact, then uses `ask_user`: first run initializes them; later runs explain the saved state and ask whether to keep it, change one area, or review everything. With arguments, it treats the rest as a targeted natural-language request:

```text
/my-pi-setup
/my-pi-setup 开启摘要，使用 seal/deepseek-v4-flash，关闭推理
/my-pi-setup 开启本地 fallback 摘要，不调用模型
/my-pi-setup 关闭自动摘要
/my-pi-setup workflow 同时跑 16 个 agent，总任务最多 256 个
/my-pi-setup 显示大标题
/my-pi-setup 切换 Footer 为 powerline
/my-pi-setup 用 mono powerline Footer
/my-pi-setup Footer 用 compact
/my-pi-setup Footer 两行：cwd flex model / context cost flex git
/my-pi-setup Footer 只显示 model、thinking、context、cache 和 git
/my-pi-setup 关闭自定义状态栏
/my-pi-setup 编辑后自动跑 npm run format
/my-pi-setup 关闭 post-edit 命令
/my-pi-setup 给 explorer 指定当前 Registry 中可用的模型
/my-pi-setup 清除 explorer 的模型，让它继承父模型
```

Run recaps default to off. Run `/my-pi-setup` to explicitly choose an available summary model or enable the no-model local fallback. Workflows default to 8 concurrent agents and 128 total agent calls per run; configurable hard maxima are 64 and 1024. The large decorative header defaults off and the custom dashboard footer defaults on with a one-line Powerline layout (`cwd model thinking context cache cost throughput |flex| git pr`). Footer presets are `powerline`, `powerline-mono`, and `compact`; style can also be set independently to `plain`, `powerline`, or `powerline-mono`. Custom layouts use a 2D `footerLines` array with at most one `flex` per row for left/right alignment. Nerd Font only affects powerline separator glyphs (``); metric text stays readable without it. Footer changes apply immediately in the active TUI session. Subagent results default to the existing full display; users who do not usually inspect implementation detail can select compact previews. Bash defaults to a folded one-line command with bounded output and a hidden-line count. Write/Edit defaults to an extra-short folded preview capped at three rendered lines including the operation header; its hidden-line hint remains inside the operation's status background. Select full independently for any category to keep it expanded. Compact views temporarily expand with `app.tools.expand` (`Ctrl+O` by default). An optional post-edit command is off by default: set one (for example `npm run format`, maximum 500 characters) and it runs once in the background after each interactive-TUI turn with successful Write/Edit operations, with failures reported as a notification. It deliberately does not guess whether arbitrary Bash commands changed files. Built-in Subagent roles `explorer`, `implementer`, `reviewer`, and `advisor` always exist and all inherit the parent model by default. `/my-pi-setup` may assign a currently available Registry model to any subset; clearing one returns it to inheritance and omitted roles stay unchanged. On spawn, model precedence is explicit spawn > selected role-file model > setup assignment > parent inheritance; effort is explicit spawn > selected role > parent. A trusted project `.pi/agents/<role>.md` overrides global `~/.pi/agent/agents/<role>.md`, which overrides the complete built-in role definition; overrides are diagnosed. Role-model changes apply to the next spawn without reload. Configuration is stored privately at `~/.pi/agent/my-pi-setup.json`.

## Session Goal and Tasks

`/goal`, `/goal <objective>`, `/goal edit`, `/goal pause`, `/goal resume`, and `/goal clear` implement a branch-scoped persistent objective with the current OpenAI Codex Goal semantics. `/goal <objective>` starts immediately with no second success-condition prompt or admission judge; the objective can contain up to 4000 characters. `/goal` shows status, objective, elapsed time, consumed tokens, optional token budget, and status-specific command hints. Replacing unfinished work requires `Replace current goal` confirmation, while a complete goal is replaced silently. Editing preserves usage and the optional budget; it reactivates complete or budget-limited goals only when the preserved budget is not already exhausted.

Model callers use `get_goal`, `create_goal`, and `update_goal`. `create_goal` is only for an explicitly requested persistent autonomous goal and fails while an unfinished goal exists. `update_goal` can only mark `complete` after a strict requirement-by-requirement evidence audit, or `blocked` after the same genuine blocker repeats for at least three consecutive Goal Turns. User/system operations own pause, resume, clear, usage limits, and budget limits.

There are no normal user-facing Turn, no-progress, or wall-clock caps; a hidden 1000-continuation circuit breaker exists only to stop runaway automation. An optional `token_budget` must only be positive. Goal non-cached Assistant input-plus-output Token and elapsed-time usage are persisted; crossing the budget marks `budget_limited` and queues one wrap-up Turn. Active goals continue after reload/resume. Fork and tree navigation defer inherited active continuation until the first explicit user input; paused, blocked, and usage-limited goals remain stopped and can prompt for Resume. A v1 active/waiting goal migrates once to paused. Assistant aborts pause an active goal and Assistant errors block it. Print/json automation is inert. Footer text mirrors Codex (`Pursuing goal (…)`, resume hints, `Goal unmet`, `Goal achieved`) without showing the objective or legacy Turn counts. An achieved Footer remains visible until the next explicit interactive/RPC input, then a branch-persisted acknowledgement hides only the Footer while `/goal` retains the completed record.

Session Tasks remain advisory multi-item work intent and do not determine Goal completion. They are scoped to the current request batch: once every item is done or dropped, the batch closes and the next `tasks_add` starts again at T1. Active items persist in a polished Claude Code-style panel above the editor; `Ctrl+Shift+T` or `/tasks hide|show|toggle` controls visibility, while `/tasks` opens the full list. No `/my-pi-setup` setting or secondary judge model is required.

## Other commands added by this fork

- `/sessions` searches and previews project sessions before switching.
- `/tasks` inspects branch-scoped advisory work items.
- `/goal ...` controls the persistent autonomous session objective.
- `/context-pivot <next phase>` deliberately compacts a long current session into a next-phase brief. It requires at least 30,000 context tokens and is rejected below that; use the separate `/handoff` skill when work should move to a genuinely new session.
- `/cron every <5m> <prompt>`, `/cron in <30s> <prompt>`, `/cron list`, and `/cron remove <id>` schedule a prompt for this session. Jobs are in-memory and session-scoped (cleared on shutdown), fire only while the session is idle, and use a duration grammar (`30s`/`5m`/`2h`, minimum 30s) rather than crontab fields, because the scheduler polls about every 30 seconds.
- `/plan [objective]` explores read-only before changing anything: while armed it blocks `edit`, `write`, mutating Bash, `subagent_send`, `workflow`, and `bg_start`, while read/grep/find/ls/fd/rg and verified read-only Git/GitHub commands stay available. It permits `subagent_spawn`, but the harness narrows every newly spawned planning child to investigation-only tools; agent types can narrow that list further, never widen it. `/plan done` asks for approval and then releases the gate; `/plan off` cancels.
