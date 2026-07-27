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

Use the single package-owned command. With no arguments the current model starts an interactive `ask_user` setup for recaps, workflow limits, and UI; with arguments it treats the rest as a targeted natural-language request:

```text
/my-pi-setup
/my-pi-setup 开启摘要，使用 seal/deepseek-v4-flash，关闭推理
/my-pi-setup 开启本地 fallback 摘要，不调用模型
/my-pi-setup 关闭自动摘要
/my-pi-setup workflow 同时跑 16 个 agent，总任务最多 256 个
/my-pi-setup 显示大标题
/my-pi-setup 关闭自定义状态栏
```

Run recaps default to off. Run `/my-pi-setup` to explicitly choose an available summary model or enable the no-model local fallback. Workflows default to 8 concurrent agents and 128 total agent calls per run; configurable hard maxima are 64 and 1024. The large decorative header defaults off and the custom dashboard footer defaults on. Configuration is stored privately at `~/.pi/agent/my-pi-setup.json`.

## Other commands added by this fork

- `/sessions` searches and previews project sessions before switching.
- `/context-pivot <next phase>` deliberately compacts a long current session into a next-phase brief. It requires roughly 30,000 context tokens; use the separate `/handoff` skill when work should move to a genuinely new session.
