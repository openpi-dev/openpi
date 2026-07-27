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

## Commands added by this fork

- `/sessions` searches and previews project sessions before switching.
- `/context-pivot <next phase>` deliberately compacts a long current session into a next-phase brief. It requires roughly 30,000 context tokens; use the separate `/handoff` skill when work should move to a genuinely new session.
- `/summary-model` changes the model used for recap cards. The default is `seal/deepseek-v4-flash` with reasoning off.
