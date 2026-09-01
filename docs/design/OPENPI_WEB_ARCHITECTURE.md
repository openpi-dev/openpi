# OpenPI Web Workbench Architecture

Status: draft implementation architecture
Created: 2026-08-30
Verified: 2026-08-30
Applicable source boundary: current checkout standalone `bin/openpi.js` and `web/` implementation
Source issue: https://github.com/openpi-dev/openpi/issues/76
Related research: https://github.com/openpi-dev/openpi/issues/166

This document defines the current implementation direction and visual design for OpenPI Web. It is a design record, not an adopted runtime constraint. The first vertical implementation lives outside `extensions/`: `bin/openpi.js` starts a standalone process and `web/` owns its Pi SDK runtime, local host, protocol adapter, and browser assets.

## 1. Product Boundary

OpenPI Web is a local browser workbench backed by a standalone Pi SDK runtime process. It is not a browser mirror of a running TUI, does not attach to an interactive terminal Session, and does not implement a second Agent runtime.

The browser consumes projections and sends typed commands to its process-local Pi `AgentSessionRuntime`. Pi remains authoritative for:

- Session files, branches, compaction, resume, and Session lifecycle;
- provider, model, thinking level, Skills, project trust, and ordinary tools;
- tool execution, approval, cancellation, and model-loop state;
- OpenPI capability runtimes such as Subagents, Workflows, Tasks, Goals, and Background Terminals.

The Web Host owns only browser connectivity, controller serialization, bounded derived indexes, protocol sequencing, and cleanup. It must never infer completion from a label, a missing event, a disconnected browser, or a rendered status.

## 2. Design Goals

### Required for the first vertical slice

- `openpi [workspace]` starts a loopback-only host in a standalone process and opens the browser.
- A browser can inspect projects and Sessions visible to the Web process's Pi authority.
- A selected Session has a bounded, compaction-aware snapshot.
- New runtime events are delivered incrementally and have a monotonic cursor.
- Refresh and reconnect can recover from a snapshot plus cursor.
- The browser can submit a bounded text prompt only to the active Web `AgentSession` through `session.prompt`; historical Sessions remain read-only.
- Known Session `cwd` values form the workspace index, and an operator may add a validated local directory to the host-lifetime index.
- Stopping the Web process aborts its active turn, closes runtime resources, the host, and client connections.
- Starting, switching, reloading, or stopping an interactive terminal Pi Session has no effect on the Web runtime, and Web commands have no route into that terminal Session.
- Without the `openpi` process, no Web server, timer, network connection, model call, tool, prompt, or schema exists.

### Explicitly deferred

- Browser interrupt;
- registration of a literal `pi open` package subcommand, because Pi currently exposes no package CLI-command seam;
- General TUI/Web command parity beyond active-Session prompt submission;
- remote, LAN, public, or relay access;
- file mutation and arbitrary file serving;
- Session fork and bulk operations;
- model/provider configuration writes;
- multi-user identity and collaboration;
- a second database or a second Session store.

## 3. Ownership Model

```text
Browser Workbench
  UI state, route, selection, expansion, scroll position
        |
        | HTTP snapshot / SSE events / typed commands (future)
        v
Local Web Host
  auth, origin checks, bounded queues, controller lease, protocol cursor
        |
        | Adapter interface
        v
Pi/OpenPI Adapter
  SessionManager, AgentSession lifecycle, extension projections
        |
        v
Pi Runtime and OpenPI extensions
  canonical Session and execution facts
```

The adapter is the only module allowed to translate Pi events into Web protocol records. The frontend must not parse JSONL Session files, read the filesystem, or reconstruct runtime state from display text.

## 4. Proposed Repository Layout

```text
bin/
  openpi.js                   # standalone executable and process signal lifecycle
web/
  host/
    web-host.ts               # lazy HTTP host lifecycle and shutdown
    browser-launcher.ts       # platform-specific open command
    auth.ts                   # token creation, comparison, expiry, origin policy
    request-router.ts         # static assets and API route dispatch
    connection-registry.ts   # SSE/WebSocket clients and bounded queues
  protocol/
    types.ts                  # wire types and version constants
    cursor.ts                 # monotonic cursor and replay window
    errors.ts                 # stable protocol errors
    validation.ts             # request validation and bounds
  runtime/
    pi-runtime.ts             # standalone AgentSessionRuntime ownership
    types.ts                  # host/runtime controller boundary
  adapter/
    pi-adapter.ts             # Pi-facing projection implementation
    session-index.ts          # bounded derived Session index
    snapshot.ts               # Session snapshot projection
    event-projector.ts        # Pi lifecycle -> Web events
    capability-projections.ts# Goal/Tasks/Subagent/Workflow projections
  security/
    path-policy.ts            # workspace and session path boundary checks
    redaction.ts              # output/path/secret redaction policy
  ui/
    package.json              # frontend build boundary, if shipped separately
    src/
      app/
        App.tsx
        routes.ts
        store.ts
      components/
        shell/
        sessions/
        transcript/
        composer/
        activity/
        capabilities/
        primitives/
      features/
        session-browser/
        live-session/
        tool-evidence/
        openpi-capabilities/
      styles/
        tokens.css
        globals.css
        components.css
      protocol/
        client.ts
        schemas.ts
        reconnect.ts
      main.tsx
    public/
      ...
  test-support/
    fake-pi-runtime.ts
    fake-browser-client.ts
```

The frontend must be a separate build and source boundary. It must not be embedded as a template literal in the CLI or Host. During early development it may be shipped as plain assets, but the Host must serve a fixed allowlist rather than arbitrary paths.

A later package split is acceptable if the frontend becomes independently released:

```text
packages/openpi-web-ui/
packages/openpi-web-host/
bin/openpi.js
```

Do not create this split until the adapter and protocol have stabilized; multiple packages before that point would add release and dependency overhead without clarifying ownership.

## 5. Runtime Lifecycle

```text
interactive Pi process
  -> does not load a Web extension
  -> has no Web host, controller, or browser event subscriptions

openpi [workspace]
  -> start a separate Node process
  -> create one persistent Pi AgentSessionRuntime for the selected workspace
  -> bind extensions headlessly to that Web-owned Session
  -> create one WebHost and bind 127.0.0.1 on an ephemeral port
  -> create a high-entropy capability token
  -> attach runtime projection listeners
  -> open browser with a deep link

browser request
  -> validate method, Host, Origin, token, route, and bounds
  -> serve bootstrap or projected data

Web new Session / workspace switch
  -> replace only the Web-owned AgentSessionRuntime
  -> abort and dispose the outgoing Web Session
  -> bind the replacement headlessly
  -> retain the loopback host and browser connection

Web SIGINT / SIGTERM / startup failure
  -> stop accepting requests
  -> close SSE clients
  -> unsubscribe runtime and capability listeners
  -> abort and dispose the Web runtime
  -> close the server and clear in-memory indexes
```

The Host is associated with exactly one Web-owned runtime controller. It never receives an `ExtensionContext`, `ExtensionAPI`, `pi.sendUserMessage`, or terminal Session replacement callback. Web Sessions are persisted under the separate `~/.pi/agent/web-sessions` directory, so interactive terminal Pi processes and the Web process do not enumerate or mutate each other's Session store. They may still use the same Provider credentials and trusted project resources.

## 6. Protocol Shape

The first protocol version should be small and explicit.

### Snapshot

```ts
interface WebSnapshot {
  protocolVersion: 1;
  generatedAt: string;
  cursor: number;
  current: {
    sessionId: string;
    path: string;
    cwd: string;
    name?: string;
    status: "idle" | "running" | "waiting" | "error" | "unknown";
  };
  sessions: SessionSummary[];
  selectedSession?: SessionProjection;
}
```

`SessionProjection` contains a bounded branch projection, not raw Session JSONL. Every message, tool call, tool result, custom entry, and compaction marker must have a stable kind and source identity. Raw arguments and outputs are opt-in expanded fields with independent limits.

### Event

```ts
interface WebEvent {
  protocolVersion: 1;
  cursor: number;
  epoch: number;
  id: string;
  type:
    | "session.started"
    | "session.changed"
    | "agent.started"
    | "agent.settled"
    | "message.updated"
    | "tool.started"
    | "tool.updated"
    | "tool.ended"
    | "capability.changed"
    | "host.stopped";
  timestamp: string;
  payload: unknown;
}
```

### Reconnect

The client sends `Last-Event-ID` or a cursor query. The host either replays events still in the bounded window or returns `409 RESYNC_REQUIRED`, after which the client fetches a fresh snapshot. A reconnect must never pretend that a gap did not occur.

### Future command

Commands are reserved now so the protocol does not grow ad hoc endpoints:

```ts
interface WebCommand {
  id: string;
  type: string;
  actor: string;
  expectedEpoch: number;
  payload: unknown;
}

interface WebReceipt {
  id: string;
  accepted: boolean;
  state: "accepted" | "rejected" | "completed" | "failed" | "uncertain";
  cursor?: number;
  evidence?: unknown;
}
```

The first command endpoint accepts a bounded text prompt only when its Session id matches the active Web Session, routes it through `AgentSession.prompt` with preflight admission, and returns an accepted receipt. This receipt proves admission, not model completion. Later commands must preserve the same authority check and return durable execution evidence rather than treating a UI acknowledgement as completion.

## 7. Adapter and Projection Rules

- `SessionManager` is the source for Session listing and branch reads.
- The adapter owns all bounds: maximum Sessions, entries, message bytes, output bytes, queue bytes, and replay age.
- Snapshot generation is compaction-aware and branch-aware.
- Tool output is represented as evidence with `toolCallId`, `toolName`, phase, error state, and bounded content.
- Goal, Tasks, Subagent, Workflow, and Background Terminal data are separate projections with explicit provenance; they are not flattened into transcript text.
- A projection can be stale or uncertain. It must expose that fact instead of upgrading it to `done`.
- Redaction happens before data leaves the adapter. The frontend cannot opt out of redaction by requesting raw entries.
- Event listeners are attached only while the host is running and are removed during every shutdown path.

## 8. Security Boundary

First slice defaults:

- bind only to `127.0.0.1`;
- use a high-entropy process-lifetime token;
- keep the token in the fragment for bootstrap; the browser sends it as an in-memory Bearer credential and it is never persisted;
- require `Authorization: Bearer` for API and event requests;
- validate exact Host and an allowlisted Origin;
- never use a user-provided Session path without resolving it through the Session index;
- never serve arbitrary filesystem paths;
- allow POST only for the bounded active-Session prompt and validated host-lifetime workspace import routes;
- enforce response and connection queue limits;
- shut down all connections with the Pi Session lifecycle.

The browser URL is a transport convenience, not a durable identity. Do not log it, persist it in Session data, or treat possession of a copied URL as a future collaboration identity.

## 9. Frontend Information Architecture

The first screen is the working surface, not a marketing landing page.

### Desktop

```text
+----------------------+---------------------------------------------+
| workspace switcher   | session title      model/status   settings  |
| search sessions      +---------------------------------------------+
| project groups       |                               | activity |
| session rows         |       conversation / run trace | drawer   |
|                      |                               |          |
|                      +-------------------------------+----------+
|                      | context / tools / task status              |
|                      +---------------------------------------------+
|                      | prompt composer                           |
+----------------------+---------------------------------------------+
```

- Left rail: project and Session navigation, search, create affordance reserved for a later phase.
- Center: chronological conversation and execution evidence.
- Right rail: collapsible activity inspector for running tools, Subagents, Workflows, Tasks, Goals, and Background Terminals.
- Bottom composer: enabled only when the selected Session is the active Web Session; historical Sessions display an explicit read-only state.

### Mobile

- Header contains current Session and connection status.
- Session rail becomes a drawer.
- Activity inspector becomes a bottom sheet.
- Conversation remains the primary full-width surface.
- Composer remains visible and is disabled when the selected Session is not active.

## 10. Visual Direction

The direction combines two useful references without copying either product.

### From Kimi Code Web

Kimi's documented Web UI provides the relevant interaction patterns: Session search and switching, a prompt toolbar for context/activity/queue/file state, dedicated tool rendering, structured questions, message actions, and responsive sidebar behavior. The OpenPI version should adopt the same information density and workflow orientation.

Use:

- a persistent Session/navigation rail;
- compact status and context controls near the composer;
- dedicated renderers for shell output, file changes, images, tasks, and questions;
- collapsible detail for long tool arguments and output;
- clear mobile drawer behavior.

Do not copy:

- Kimi-specific command names or backend assumptions;
- a second wire/runtime model;
- implicit permission or network behavior.

### From DeepSeek Harness

The public Harness material emphasizes plugin-based capabilities, traceability of every run, and multiple runtime modes. The visual implication is an operational trace surface rather than a generic chat screen.

Use:

- a visible run/activity identity and lifecycle state;
- provenance labels for capability output;
- an execution timeline that can be inspected independently from prose;
- capability panels that appear when the corresponding runtime resource exists;
- a consistent distinction between model text, runtime evidence, and operator state.

Do not turn this into a dashboard full of permanent cards. A capability panel should appear contextually or in the inspector when it has real state.

### Concrete tokens

- Palette: neutral charcoal and graphite surfaces, cool blue for active navigation, green for confirmed healthy state, amber for waiting or attention, red only for failure.
- Avoid a single blue/purple gradient theme. The UI should read as a focused developer tool, not a marketing page.
- Typography: system UI for navigation and labels; monospace only for commands, paths, identifiers, and raw tool output.
- Radius: 6px maximum for controls and evidence frames; no nested card stacks.
- Borders: thin low-contrast separators; use spacing and typography for hierarchy.
- Motion: only short state transitions and a restrained live indicator. Never animate the whole transcript or use decorative background effects.
- Density: default to compact summaries; expand raw evidence on demand.

## 11. Component Contracts

The frontend should be organized around data contracts rather than one large transcript component:

- `SessionRail`: consumes `SessionSummary[]`, search state, and selection callbacks.
- `WorkbenchHeader`: consumes current Session, runtime status, model metadata, and connection state.
- `TranscriptViewport`: consumes ordered projection items and cursor metadata; owns follow/pause scroll behavior.
- `MessageBlock`: renders user and assistant content only.
- `ToolEvidence`: renders tool phases, source, args summary, output, error, and expansion state.
- `CapabilityInspector`: dispatches to capability-specific projections without owning their runtime.
- `PromptToolbar`: displays context, queue, trust, plan, and model state; command behavior comes later.
- `Composer`: routes bounded prompts to the active Session and exposes disabled/error/queued states.
- `ConnectionIndicator`: distinguishes connected, reconnecting, resync required, and stopped.

Each component receives typed projected data and must not inspect raw Pi messages or infer state from CSS classes.

## 12. Delivery Phases

### Phase A: architecture and adapter contract

- Split the current prototype into host, protocol, adapter, and UI asset boundaries.
- Add protocol types and bounded projection tests.
- Keep HTTP snapshot + SSE, with narrowly typed POST routes for active-Session prompts and host-lifetime workspace import.
- Add reconnect/resync behavior.

### Phase B: usable observer UI

- Introduce a real React/TypeScript/Vite frontend boundary, subject to package dependency review.
- Implement Session rail, transcript viewport, tool evidence, connection state, and responsive layout.
- Add visual regression or browser smoke coverage at desktop and mobile widths.

### Phase C: capability inspector

- Project Tasks, Goals, Subagents, Workflows, and Background Terminals through independent adapters.
- Show real lifecycle states and evidence, not labels derived from UI state.

### Phase D: controlled local commands

- Define controller ownership and typed receipts.
- Add prompt and interrupt only after stale command, cancellation, shutdown, and TUI conflict behavior are tested.
- Reuse Pi user/host authority; do not expose unrestricted model tools through the browser.

### Phase E: optional network research

- Separate Issue and threat model.
- Do not expand loopback design into LAN/public access by adding a flag alone.
- Evaluate observer-only sharing before any remote write capability.

## 13. Acceptance Criteria for the Next Implementation PR

- The HTML, CSS, and browser JavaScript are separate assets under `web/ui/`.
- No Web entrypoint exists under `extensions/`, and no `/web` command is registered.
- Host shutdown and Web runtime disposal are tested independently from terminal Session lifecycle.
- API responses have versioned types and explicit byte/count limits.
- Snapshot and events are separate projections with cursor and resync semantics.
- Session paths are selected from an authoritative bounded index.
- Tool evidence preserves call identity and error state.
- Web commands cannot target a non-active Session; prompt admission uses the Web runtime's active Session authority.
- Web prompt and Session commands have no reference or callback path to an interactive terminal runtime.
- No Web resources exist before the standalone `openpi` process starts.
- Desktop and mobile layouts are validated in a real browser.

## 14. Sources and Evidence

- OpenPI Issue #76: <https://github.com/openpi-dev/openpi/issues/76>
- OpenPI Issue #166: <https://github.com/openpi-dev/openpi/issues/166>
- Kimi Code Web reference: <https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html>
- DeepSeek Harness: <https://www.deepseek.com/harness/en/>
- Pi extension lifecycle and RPC documentation: local `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `docs/rpc.md`
- Current OpenPI Session implementation: `extensions/sessions/` and `extensions/shared/agent-session-page.ts`

The external product references inform interaction and presentation patterns only. They do not override Pi's ownership, trust, permission, Session, or lifecycle contracts.
