# OpenPI Web development port-conflict handling

- Status: draft
- Created: 2026-09-03
- Last reviewed: 2026-09-03
- Source boundary: OpenPI `72fbba5` plus the local `codex/web-react-mvp` development launcher
- Related issue: none; local validation branch only
- Related PR: none
- Supersedes: none

## Context

`bun run dev:web` starts two loopback listeners: a WebHost backend and a Vite UI. The current launcher fixes them to ports `57107` and `5173`, waits up to 15 seconds for the backend, and starts Vite with `strictPort: true`.

Two failures currently look similar even though they require different operator actions:

- an unrelated process owns a preferred port, so another loopback port is safe;
- another OpenPI WebHost owns the shared Web Session directory, so starting a second runtime is unsafe regardless of port.

A backend started through Node watch can also fail while the watch supervisor remains alive. In that case the launcher waits for the full readiness timeout and reports a secondary timeout after the real startup error.

The TUI `/web` command inherits child output while the TUI is suspended, but after the terminal is restored its notification reports only the exit code. The actionable child error can therefore disappear from the operator-facing result.

## Chosen behavior

### Default ports

When `OPENPI_WEB_UI_PORT` or `OPENPI_WEB_BACKEND_PORT` is absent, its documented value is a preferred port rather than a required port. The launcher checks loopback availability starting at `5173` for the UI and `57107` for the backend and selects the first available port among at most 100 consecutive candidates, without exceeding `65535`.

If either preferred port is skipped, startup output names the occupied preferred port and the selected replacement. The selected backend origin and UI origin are the only values passed to the readiness probe, Vite proxy, WebHost `--port`, `OPENPI_WEB_ALLOWED_ORIGIN`, and browser URL.

Port discovery is a development convenience, not an ownership boundary. The eventual listener bind remains authoritative. If another process wins the port after discovery, startup fails explicitly rather than claiming success.

### Explicit ports

When an operator sets either port environment variable, that port is an exact request. The launcher validates it as an integer from 1 through 65535 and fails immediately if it cannot be bound. It does not silently select a different port.

The error names the occupied port and the matching environment variable. This preserves deterministic CI, scripts, bookmarks, and debugging commands.

### Existing OpenPI WebHost

The single WebHost lease remains unchanged. A live `/web`, `openpi web`, `dev:web`, or `dev:web:backend` process cannot be bypassed by selecting another port because all of them own the same Web Session and metadata directory.

During development startup, the launcher observes up to the latest 8 KiB of backend startup stderr while continuing to forward it to the terminal. A lease conflict or other terminal startup failure ends the launcher promptly and preserves the original error in the final diagnostic instead of waiting for a readiness timeout. It does not reuse the existing Host, persist or recover its token, or terminate it automatically.

### TUI diagnostics

`/web` continues to run the packaged CLI in the foreground with the terminal suspended. It forwards normal child output and retains only the latest 8 KiB, terminal-sanitized tail of stderr. If the child exits unsuccessfully, the restored TUI notification includes the actionable final error when available; otherwise it retains the existing exit-code or signal fallback.

This diagnostic projection is display evidence only. It does not change child lifecycle, Session state, or the canonical process exit result.

## Implementation boundaries

- Keep port selection and startup-output handling in small development-script helpers with injected listener/process seams for deterministic tests.
- Do not weaken or duplicate `acquireWebHostLease`.
- Do not add a daemon, registry, persisted development token, or attach-to-existing-Host behavior.
- Do not make the standalone production CLI silently avoid an explicitly requested `--port`.
- Preserve normal `SIGINT` and `SIGTERM` cleanup for Vite, the watch supervisor, WebHost, and its lease.
- Bound both the number of candidate ports and captured stderr bytes.

## Alternatives considered

1. Let Vite alone choose another port. Rejected because the backend, proxy, allowed origin, readiness endpoint, and displayed URL would not share one resolved configuration.
2. Bind both services to port `0` and return their assigned ports over a new IPC protocol. This removes the small discovery-to-bind race but requires a larger CLI/watch protocol refactor than the development problem justifies.
3. Fail on every conflict and require manual environment variables. This is deterministic but makes ordinary local development unnecessarily brittle when common frontend ports are occupied.
4. Reuse an existing WebHost. Rejected because the process token is intentionally ephemeral and not persisted, and a second UI cannot infer compatible source, protocol, or runtime ownership from a port alone.

## Validation

Automated checks must cover:

- default UI and backend ports remain unchanged when available;
- occupied default ports select the next available candidates and update every downstream origin;
- explicitly configured occupied ports fail immediately without fallback;
- invalid and out-of-range port values fail before spawning children;
- a backend lease/startup failure rejects immediately with the original cause rather than the readiness timeout;
- a bind race fails explicitly and cleans up any process or listener already started;
- `/web` reports a bounded sanitized child error and preserves signal/code fallbacks;
- successful shutdown still releases both ports and the WebHost lease.

Repository validation remains `bun run check` and `bun run test`. Manual validation starts an unrelated listener on each preferred port, confirms automatic fallback, then starts an existing OpenPI WebHost and confirms the second launcher fails promptly without selecting a second runtime.

## Evidence boundary

Verified facts in the source boundary are the fixed current ports, Vite strict-port configuration, 15-second readiness timeout, Node watch supervision, and the single WebHost lease. The behavior above is approved local design, not shipped behavior or an accepted project Decision. Exact output wording and helper names may change during implementation while preserving the stated operator-visible outcomes.
