# OpenPI Web Workbench Architecture

Status: draft implementation architecture
Created: 2026-08-30
Verified: 2026-09-01
Applicable source boundary: PR #326 standalone `bin/openpi.js` and `web/` implementation
Source issues: https://github.com/openpi-dev/openpi/issues/76 and https://github.com/openpi-dev/openpi/issues/325
Implementation PR: https://github.com/openpi-dev/openpi/pull/326
Related research: https://github.com/openpi-dev/openpi/issues/166

This document defines the current implementation direction and visual design for OpenPI Web. It is a design record, not an adopted runtime constraint. The first vertical implementation lives outside `extensions/`: `bin/openpi.js` starts a standalone process and `web/` owns its Pi SDK runtime, local host, protocol adapter, and browser assets.

## 1. Product Boundary

OpenPI Web is a local browser workbench backed by a standalone Pi SDK runtime process. It is not a browser mirror of a running TUI, does not attach to an interactive terminal Session, and does not implement a second Agent runtime.

The browser consumes projections and sends typed commands to its process-local Pi `AgentSessionRuntime`. Pi remains authoritative for:

- Session files, branches, compaction, resume, and Session lifecycle;
- provider, model, thinking level, Skills, project trust, and ordinary tools;
- tool execution, approval, cancellation, and model-loop state;
- OpenPI capability runtimes. The first slice projects Subagents, Workflows, and Background Terminals; Tasks, Goals, and broader coverage remain deferred.

The Web Host owns only browser connectivity, controller serialization, bounded derived indexes, protocol sequencing, and cleanup. It must never infer completion from a label, a missing event, a disconnected browser, or a rendered status.

## 2. Design Goals

### Required for the first vertical slice

- `openpi [workspace]` starts a loopback-only host in a standalone process and opens the browser.
- A browser can inspect projects and Sessions visible to the Web process's Pi authority.
- A selected Session has a bounded projection of Pi's current branch.
- New runtime events are delivered incrementally and have a monotonic cursor.
- Refresh and reconnect can recover from a snapshot plus cursor.
- Selecting a Session activates it in the Web-owned runtime. The browser can submit a bounded text prompt only when the request still matches that active `AgentSession`, through `session.prompt`.
- Known Session `cwd` values form the workspace index, and an operator may add a validated local directory to the host-lifetime index.
- Stopping the Web process aborts its active turn, closes runtime resources, the host, and client connections.
- One package-owned process lease protects the shared Web Session and metadata directory; a second live Host fails closed, while a dead owner's lease can be recovered only after its PID and OS process-start identity no longer match. The nonce identifies the exact published owner during release and recovery. Candidate, released, and stale safety directories live in the private `.openpi-web-host.artifacts/` container so their bounded accounting never scans, limits, or deletes ordinary Pi Session files.
- Starting, switching, reloading, or stopping an interactive terminal Pi Session has no effect on the Web runtime, and Web commands have no route into that terminal Session.
- Without the `openpi` process, no Web server, timer, network connection, model call, tool, prompt, or schema exists.

### Explicitly deferred

- Browser interrupt;
- registration of a literal `pi open` package subcommand, because Pi currently exposes no package CLI-command seam;
- General TUI/Web command parity beyond active-Session prompt submission;
- remote, LAN, public, or relay access;
- file mutation and arbitrary file serving;
- Session fork and bulk operations;
- separate read-only browsing of a non-active Session, detailed compaction summaries, and custom-entry state;
- Tasks and Goals capability projection;
- provider credentials, provider configuration, and arbitrary Settings writes; model selection for the current Web Session uses Pi's native `session.setModel` and updates Pi's normal default-model preference;
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

The runtime and adapter modules form the only Pi-to-Web projection boundary: `PiWebRuntime` translates live Pi events, while `PiWebAdapter` reads bounded Session and capability snapshots. `PiWebRuntime` also owns the single-process lease for the shared Web Session directory, preventing cross-process lost updates without adding another database or daemon. The frontend must not parse JSONL Session files, read the filesystem, or reconstruct runtime state from display text.

## 4. Future Repository Layout

The following split is an architectural direction, not a claim about files already present in PR #326. The current slice keeps routing, authentication, cursors, queue bounds, and security headers inside the small Host until a real separation reduces complexity.

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
    capability-projections.ts# capability projections as they are added
  security/
    path-policy.ts            # workspace and session path boundary checks
    redaction.ts              # deferred remote-sharing policy, if required
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
  -> prepare and bind the replacement Web-owned AgentSessionRuntime atomically
  -> keep an outgoing runtime while an in-flight request captured for that Session settles
  -> dispose the outgoing runtime after its prompt operations settle
  -> retain the loopback host and browser connection

Web SIGINT / SIGTERM / startup failure
  -> stop accepting requests
  -> close SSE clients
  -> unsubscribe runtime and capability listeners
  -> drain every admitted Session and metadata mutation
  -> abort and dispose the Web runtime
  -> release the exact Web Host process lease
  -> finish server closure and clear in-memory indexes
```

The Host is associated with exactly one Web-owned runtime controller. It never receives an `ExtensionContext`, `ExtensionAPI`, `pi.sendUserMessage`, or terminal Session replacement callback. Web Sessions are persisted under the separate `~/.pi/agent/web-sessions` directory, so interactive terminal Pi processes and the Web process do not enumerate or mutate each other's Session store. One live Host owns that directory at a time; it can manage multiple workspaces. They may still use the same Provider credentials and trusted project resources.

Stale-owner recovery retains a nonce-scoped tombstone as a safety fence against a paused contender acting on an obsolete observation. The artifact container is fail-closed at 128 package-owned entries, with at most 64 stale tombstones. OpenPI never deletes these fences automatically: after verifying that no Web Host can still depend on them, an operator may remove obsolete `candidate-*`, `released-*`, or `stale-*` entries from `.openpi-web-host.artifacts/`. This bound applies only to lease artifacts; Pi Session discovery remains complete and is not claimed to have bounded filesystem cost.

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

`SessionProjection` contains a bounded projection of Pi's current branch, not raw Session JSONL. The first slice preserves stable identity for projected messages, tool calls, and tool results. Detailed compaction summaries and custom-entry state are deferred rather than reconstructed in the browser.

### Event

```ts
interface WebEvent {
  protocolVersion: 1;
  sequence: number;
  type: string;
  timestamp: string;
  detail?: Record<string, unknown>;
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
- The protocol projection owns Session, entry, message, output, and snapshot limits; the Host owns event-count, response, client-count, and connection-buffer limits.
- Snapshot generation reads Pi's compaction-aware current branch. The first slice does not separately render compaction summaries or custom-entry state.
- Tool output is represented as evidence with `toolCallId`, `toolName`, phase, error state, and bounded content.
- Subagent, Workflow, and Background Terminal data are separate bounded projections with explicit provenance; Tasks, Goals, and deeper capability inspection are deferred.
- Capability providers and the Host share a versioned process-global registry keyed by the Pi `SessionManager` object. This preserves one lifecycle even when Pi's managed package path and the standalone npm CLI path load separate ESM copies of the same OpenPI version; it is not persistent storage.
- A projection can be stale or uncertain. It must expose that fact instead of upgrading it to `done`.
- The first loopback-only slice does not rewrite Pi transcript content with a second redaction policy. It prevents automatic remote Markdown image loading and applies response bounds and browser security headers; remote sharing requires a separate threat model.
- Event listeners are attached when the Host is constructed immediately before listening and are removed during shutdown.

These limits apply to Web protocol output and to message/capability projection work. Pi's native `SessionManager.listAll()` still performs its own complete Session discovery, and the small package-owned workspace/archive metadata files are loaded as complete sets before their Web projections are capped. PR #326 deliberately does not add a second Session index or persistence control plane, so it does not claim that those source-discovery costs are internally bounded.

## 8. Security Boundary

First slice defaults:

- bind only to `127.0.0.1`;
- use a high-entropy capability token whose lifetime is the Web Host process;
- deliver the token in the fragment, copy it into tab-scoped `sessionStorage`, and immediately remove it from the visible URL;
- require `Authorization: Bearer` for API and event requests;
- validate exact Host and an allowlisted Origin;
- never use a user-provided Session path without resolving it through the Session index;
- never serve arbitrary filesystem paths;
- expose authenticated mutations for Session create/select/rename/archive, workspace import/rename/remove, active-Session prompt admission, and Pi-native model selection; no route serves arbitrary files, edits transcript history, changes provider credentials, or configures remote access;
- enforce response and connection queue limits;
- shut down all connections with the Pi Session lifecycle.

The browser URL is a transport convenience, not a durable identity. `openpi --no-open` (or a failed browser launch) prints it once to startup stdout so the local operator can open it; that output is secret-bearing and should stay in a trusted terminal or protected temporary log. CI uses an explicit fixed test token. Do not persist a real URL in Session data, publish captured startup output, or treat possession of a copied URL as a future collaboration identity.

## 9. Frontend Information Architecture

The first screen is the working surface, not a marketing landing page.

### Desktop

```text
+----------------------+---------------------------------------------+
| workspace switcher   | session title          connection status   |
| search sessions      +---------------------------------------------+
| workspace groups     |       conversation / tool evidence         |
| session rows         |       bounded runtime activity              |
|                      |                                             |
|                      +---------------------------------------------+
|                      | model selector / prompt composer            |
|                      +---------------------------------------------+
+----------------------+---------------------------------------------+
```

- Left rail: workspace and Session navigation, search, Session creation, and workspace import.
- Center: chronological conversation, tool evidence, and the first bounded activity projections.
- Bottom composer: model selection and prompt admission for the Session activated in the Web-owned runtime; the request includes that Session id.

### Mobile

- Header contains current Session and connection status.
- Session rail becomes a drawer.
- Conversation and its bounded activity rows remain the primary full-width surface.
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

## 12. Delivery Status

### Delivered in PR #326: architecture and adapter contract

- Host, protocol, adapter, runtime controller, and UI assets have separate boundaries.
- Protocol types and bounded projection tests cover Sessions, messages, capabilities, snapshots, events, and connection queues.
- Authenticated HTTP mutations cover Session create/select/rename/archive, workspace import/rename/remove, active-Session prompt admission, and Pi-native model selection.
- Snapshot plus cursor-based SSE provide bounded replay and explicit resync behavior.

### Delivered in PR #326: first usable UI

- Keep the first slice as separate dependency-light HTML, CSS, and browser JavaScript assets; a React migration is not required for this protocol boundary.
- Session rail, transcript and tool evidence, connection state, model picker, composer, and a responsive narrow-screen layout are present.
- Manual acceptance from a freshly packed CLI covers desktop and a 390x844 viewport. CI currently verifies packed Host startup and static assets, not browser viewports; automated visual regression remains future work.

### Delivered in PR #326: minimal capability activity

- Subagents, Workflows, and Background Terminals use scoped bounded projections with canonical structured lifecycle fields.
- Tasks, Goals, transcripts, logs, and deeper capability inspection remain deferred.

### Delivered in PR #326: controlled local mutations

- The Web-owned Pi runtime controller serializes Session and model mutations and returns typed request failures.
- Prompt admission is bound to the active Web Session and reports admission separately from settlement.
- Session/workspace metadata mutations remain package-owned projections; unrestricted model tools and interrupt control are not exposed.

### Deferred: optional network research

- Separate Issue and threat model.
- Do not expand loopback design into LAN/public access by adding a flag alone.
- Evaluate observer-only sharing before any remote write capability.

## 13. Acceptance Criteria for PR #326

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
- Desktop and 390x844 layouts have a manual real-browser acceptance receipt; automated viewport coverage remains deferred.

## 14. Sources and Evidence

- OpenPI Issue #76: <https://github.com/openpi-dev/openpi/issues/76>
- OpenPI Issue #166: <https://github.com/openpi-dev/openpi/issues/166>
- Kimi Code Web reference: <https://moonshotai.github.io/kimi-cli/en/reference/kimi-web.html>
- DeepSeek Harness: <https://www.deepseek.com/harness/en/>
- Pi extension lifecycle and RPC documentation: local `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `docs/rpc.md`
- Current OpenPI Session implementation: `extensions/sessions/` and `extensions/shared/agent-session-page.ts`

The external product references inform interaction and presentation patterns only. They do not override Pi's ownership, trust, permission, Session, or lifecycle contracts.
