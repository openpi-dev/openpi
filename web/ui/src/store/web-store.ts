import { createStore } from "zustand/vanilla";
import type {
  WebCommandSummary,
  WebEvent,
  WebLiveMessage,
  WebModelSummary,
  WebSnapshot,
  WebThinkingState,
} from "../../../protocol/types.ts";
import { i18n } from "../i18n.ts";
import { WebApiError, WebClient } from "../protocol/client.ts";
import { consumeEventStream } from "../protocol/event-stream.ts";
import { reduceLiveTools } from "../../../protocol/live-tools.ts";

const collapsedWorkspacesStorageKey = "openpi.collapsed-workspaces";
const sidebarCollapsedStorageKey = "openpi.sidebar-collapsed";
const refreshEventTypes = new Set([
  "agent_start",
  "turn_started",
  "turn_settled",
  "agent_settled",
  "prompt_settled",
  "message_end",
  "tool_execution_end",
  "session_start",
  "session_switched",
  "session_progress",
  "prompt_failed",
  "model_select",
  "workspace_imported",
  "workspace_removed",
  "workspace_renamed",
  "session_renamed",
  "session_archived",
  "session_unarchived",
  "session_created",
  "prompt_accepted",
  "runtime_changed",
]);

function readStringSet(key: string) {
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(key) || "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function readBoolean(key: string) {
  try {
    return window.sessionStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function persist(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export interface LiveEntry {
  key: string;
  message: WebLiveMessage;
}

interface SessionActivation {
  epoch: number;
  kind: "create" | "select";
  commandId?: string;
  expectedPath: string | null;
  observedPath?: string | null;
}

export interface CommandDiscoveryState {
  sessionId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  commands: WebCommandSummary[];
  totalAvailable: number;
  commandsOmitted: number;
  error: string | null;
}

export interface WebStoreState {
  activeTurn: WebSnapshot["runtime"]["activeTurn"] | null;
  turnCancellationPending: boolean;
  turnTerminalStatus: string | null;
  pendingFollowUpsReceipt: number | null;
  draftModel: WebModelSummary | null;
  modelSelectionPending: boolean;
  modelSearch: ModelSearchState;
  snapshot: WebSnapshot | null;
  cursor: number | null;
  selectedPath: string | null;
  selectedWorkspace: string | null;
  // A workspace draft is operator intent, not the canonical Pi Session's cwd.
  // Keep it through snapshots/failures until native creation is confirmed or
  // the operator explicitly opens an existing Session.
  workspaceDraft: boolean;
  collapsed: Set<string>;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  query: string;
  searchOpen: boolean;
  connection: "connected" | "connecting" | "reconnecting" | "unavailable";
  notice: string | null;
  liveMessages: LiveEntry[];
  liveRunning: boolean;
  livePhase: "idle" | "preparing" | "running";
  liveRetry: { attempt: number; maxAttempts: number } | null;
  thinkingStarts: Record<string, number>;
  thinkingDurations: Record<string, number>;
  promptAdmissionPending: boolean;
  sessionSwitching: boolean;
  scrollToBottom: number;
  // Optimistic display only; the confirmed value lives in snapshot.thinking.
  thinkingPendingLevel: string | null;
  commandDiscovery: CommandDiscoveryState;
  actions: WebStoreActions;
}

export interface WebStoreActions {
  start: () => void;
  stop: () => void;
  refreshSnapshot: (options?: {
    resetCursor?: boolean;
    epoch?: number;
    canonicalRetry?: boolean;
  }) => Promise<boolean>;
  chooseWorkspace: () => Promise<void>;
  setWorkspace: (path: string | null) => void;
  renameWorkspace: (path: string, name: string) => Promise<void>;
  removeWorkspace: (path: string) => Promise<void>;
  createSession: (workspacePath: string) => Promise<boolean>;
  selectSession: (path: string) => Promise<void>;
  renameSession: (path: string, name: string) => Promise<void>;
  archiveSession: (path: string) => Promise<void>;
  unarchiveSession: (path: string) => Promise<boolean>;
  selectModel: (value: string) => Promise<void>;
  searchModels: (query: string) => Promise<void>;
  clearModelSearch: () => void;
  selectThinking: (level: string) => void;
  cancelActiveTurn: () => Promise<void>;
  sendPrompt: (content: string) => Promise<boolean>;
  discoverCommands: () => Promise<void>;
  clearCommandDiscovery: () => void;
  setQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  toggleWorkspace: (path: string) => void;
  toggleSidebar: (narrow: boolean) => void;
  closeMobileSidebar: () => void;
  clearNotice: () => void;
}

export interface ModelSearchState {
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  models: WebModelSummary[];
  totalMatches: number;
  matchesOmitted: number;
  error: string | null;
}

export interface WebStoreDependencies {
  consumeEvents?: typeof consumeEventStream;
}

function waitForReconnect(delay: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createWebStore(
  client = new WebClient(),
  dependencies: WebStoreDependencies = {},
) {
  const consumeEvents = dependencies.consumeEvents ?? consumeEventStream;
  let sessionEpoch = 0;
  let snapshotGeneration = 0;
  let promptAdmissionSequence = 0;
  let promptAdmissionToken: number | null = null;
  let promptAdmission: {
    sessionId: string;
    content: string;
    commandId: string;
    optimisticKey: string;
  } | null = null;
  let sessionActivation: SessionActivation | null = null;
  let sessionSelectionTail = Promise.resolve();
  let refreshTimer: number | null = null;
  let refreshInFlight = false;
  let refreshPending = false;
  let streamController: AbortController | null = null;
  let modelSearchController: AbortController | null = null;
  let modelSearchGeneration = 0;
  let thinkingTarget: string | null = null;
  let thinkingSeq = 0;
  let thinkingInFlight = false;
  let thinkingFlushToken = 0;
  let lastThinkingRevision = 0;
  let acceptedThinking: WebThinkingState | null = null;
  let acceptedThinkingEpoch = -1;
  let commandDiscoveryController: AbortController | null = null;
  let commandDiscoveryGeneration = 0;
  const terminalPromptIds = new Set<string>();
  const completedActivationIds = new Set<string>();

  const rememberBounded = (set: Set<string>, value: unknown) => {
    if (typeof value !== "string") return;
    set.add(value);
    while (set.size > 32) {
      const first = set.values().next().value;
      if (first) set.delete(first);
    }
  };

  const resetLivePatch = () => ({
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    liveMessages: [] as LiveEntry[],
    liveRunning: false,
    livePhase: "idle" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
  });

  const resetModelSearch = (): { modelSearch: ModelSearchState } => {
    modelSearchGeneration++;
    modelSearchController?.abort();
    modelSearchController = null;
    return {
      modelSearch: {
        query: "",
        status: "idle",
        models: [],
        totalMatches: 0,
        matchesOmitted: 0,
        error: null,
      },
    };
  };
  const emptyCommandDiscovery = (): CommandDiscoveryState => ({
    sessionId: null,
    status: "idle",
    commands: [],
    totalAvailable: 0,
    commandsOmitted: 0,
    error: null,
  });

  const promptAcceptedLivePatch = (
    settled: boolean,
    currentPhase: WebStoreState["livePhase"],
  ) => ({
    liveRunning: currentPhase === "running" || !settled,
    livePhase:
      currentPhase === "running"
        ? ("running" as const)
        : settled
          ? ("idle" as const)
          : ("preparing" as const),
  });

  const store = createStore<WebStoreState>((set, get) => {
    const showError = (error: unknown) => {
      set({
        notice: error instanceof Error ? error.message : String(error),
      });
    };

    const clearCommandDiscovery = () => {
      commandDiscoveryGeneration++;
      commandDiscoveryController?.abort();
      commandDiscoveryController = null;
      set({ commandDiscovery: emptyCommandDiscovery() });
    };

    const applyModel = async (
      model: { provider: string; id: string },
      epoch: number,
      sessionId: string,
    ) => {
      if (get().modelSelectionPending) return false;
      set({ modelSelectionPending: true });
      try {
        const result = await client.selectModel(
          model.provider,
          model.id,
          sessionId,
        );
        if (
          epoch !== sessionEpoch ||
          sessionId !== get().snapshot?.selectedSession?.id
        )
          return false;
        if (
          result.provider !== model.provider ||
          result.id !== model.id ||
          !result.current
        ) {
          throw new Error(
            "Model selection was not confirmed. Please select a model again.",
          );
        }
        if (
          !(await get().actions.refreshSnapshot({ epoch })) ||
          epoch !== sessionEpoch ||
          sessionId !== get().snapshot?.selectedSession?.id
        )
          return false;
        const current = get().snapshot?.models.find((item) => item.current);
        if (current?.provider !== model.provider || current.id !== model.id) {
          throw new Error(
            "The Session model changed. Please select a model again.",
          );
        }
        set({ draftModel: null, notice: null });
        return true;
      } catch (error) {
        if (
          epoch === sessionEpoch &&
          sessionId === get().snapshot?.selectedSession?.id
        )
          showError(error);
        return false;
      } finally {
        if (epoch === sessionEpoch) set({ modelSelectionPending: false });
      }
    };

    const scheduleSnapshotRefresh = (delay = 160) => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(async () => {
        refreshTimer = null;
        refreshInFlight = true;
        try {
          await get().actions.refreshSnapshot();
        } finally {
          refreshInFlight = false;
          if (refreshPending) {
            refreshPending = false;
            scheduleSnapshotRefresh();
          }
        }
      }, delay);
    };

    // Accepted-value bookkeeping. `acceptedThinking` holds the highest revision
    // we have confirmed from a snapshot, a POST response, or a local event
    // patch; anything older is refused so an out-of-order snapshot can never
    // regress the displayed level. The gate is scoped to the Session epoch so a
    // session switch (or host restart) cannot carry a stale value forward.
    const clearThinkingGate = () => {
      acceptedThinking = null;
      lastThinkingRevision = 0;
      acceptedThinkingEpoch = -1;
    };

    const reconcileSnapshotThinking = () => {
      const snapshot = get().snapshot;
      if (!snapshot) return;
      if (acceptedThinking && acceptedThinkingEpoch !== sessionEpoch) {
        clearThinkingGate();
      }
      const incoming = snapshot.thinking;
      // An absent projection is authoritative: never resurrect a local value.
      if (!incoming) return;
      if (!acceptedThinking || incoming.revision >= lastThinkingRevision) {
        acceptedThinking = incoming;
        lastThinkingRevision = incoming.revision;
        acceptedThinkingEpoch = sessionEpoch;
        return;
      }
      if (incoming !== acceptedThinking) {
        set({ snapshot: { ...snapshot, thinking: acceptedThinking } });
      }
    };

    const acceptThinking = (next?: WebThinkingState) => {
      if (acceptedThinking && acceptedThinkingEpoch !== sessionEpoch) {
        clearThinkingGate();
      }
      if (next && next.revision >= lastThinkingRevision) {
        acceptedThinking = next;
        lastThinkingRevision = next.revision;
        acceptedThinkingEpoch = sessionEpoch;
      }
      reconcileSnapshotThinking();
    };

    const resetThinking = () => {
      thinkingTarget = null;
      thinkingSeq++;
      thinkingInFlight = false;
      set({ thinkingPendingLevel: null });
    };

    const reconcileThinking = async () => {
      const epoch = sessionEpoch;
      const sessionId = get().snapshot?.selectedSession?.id;
      if (!sessionId) return;
      try {
        const result = await client.thinking(
          sessionId,
          new AbortController().signal,
        );
        if (
          epoch !== sessionEpoch ||
          sessionId !== get().snapshot?.selectedSession?.id
        )
          return;
        acceptThinking(result);
      } catch {
        // Reconciliation is best-effort; the caller already surfaced the
        // original failure to the operator.
      }
    };

    const flushThinking = async () => {
      if (thinkingInFlight) return;
      thinkingInFlight = true;
      const flushToken = ++thinkingFlushToken;
      try {
        while (thinkingTarget !== null) {
          const target = thinkingTarget;
          const seq = thinkingSeq;
          const epoch = sessionEpoch;
          const sessionId = get().snapshot?.selectedSession?.id;
          if (!sessionId || get().modelSelectionPending) {
            resetThinking();
            return;
          }
          if (get().snapshot?.thinking?.level === target) {
            if (seq === thinkingSeq) {
              thinkingTarget = null;
              set({ thinkingPendingLevel: null });
            }
            continue;
          }
          let result: WebThinkingState;
          try {
            result = await client.setThinkingLevel(sessionId, target);
          } catch (error) {
            // A superseded session owns its own flush; drop this one instead of
            // re-looping into a duplicate POST. Same-epoch newer intent still
            // re-reads the latest target below.
            if (epoch !== sessionEpoch) return;
            if (seq !== thinkingSeq) continue;
            resetThinking();
            showError(error);
            void reconcileThinking();
            return;
          }
          if (
            epoch !== sessionEpoch ||
            sessionId !== get().snapshot?.selectedSession?.id
          ) {
            // The session changed underneath this request; a newer flush (if
            // any) already owns the pending intent. Drop the superseded flush
            // rather than re-looping and issuing a duplicate POST.
            return;
          }
          if (seq !== thinkingSeq) continue;
          if (result.level !== target) {
            resetThinking();
            showError(new Error(i18n.t("thinkingNotConfirmed")));
            return;
          }
          acceptThinking(result);
          thinkingTarget = null;
          set({ thinkingPendingLevel: null });
          scheduleSnapshotRefresh();
          return;
        }
      } finally {
        if (flushToken === thinkingFlushToken) thinkingInFlight = false;
      }
    };

    const applyRuntimeEvent = (event: WebEvent) => {
      const current = get();
      const detail = event.detail ?? {};
      const eventSessionId = detail.sessionId;
      const sessionTransition = [
        "session_start",
        "session_switched",
        "session_created",
      ].includes(event.type);
      if (current.cursor !== null && event.sequence <= current.cursor) return;
      set({ cursor: event.sequence });

      if (event.type === "runtime_changed") set(resetModelSearch());
      if (event.type === "runtime_changed") clearCommandDiscovery();

      if (current.sessionSwitching && !sessionTransition) {
        scheduleSnapshotRefresh();
        return;
      }
      if (
        typeof eventSessionId === "string" &&
        eventSessionId !== current.snapshot?.currentSessionId &&
        !sessionTransition
      ) {
        scheduleSnapshotRefresh();
        return;
      }

      if (current.snapshot) {
        const liveTools = reduceLiveTools(
          current.snapshot.runtime.liveTools ?? [],
          event.type,
          detail,
        );
        set({
          snapshot: {
            ...current.snapshot,
            runtime: { ...current.snapshot.runtime, liveTools },
          },
        });
      }
      if (sessionTransition) {
        const eventCommandId = detail.commandId;
        if (
          typeof eventCommandId === "string" &&
          completedActivationIds.has(eventCommandId)
        ) {
          scheduleSnapshotRefresh();
          return;
        }
        const eventPath = detail.sessionPath;
        const knownPath = current.snapshot?.sessions.some(
          (session) => session.path === eventPath,
        );
        let belongs = false;
        if (sessionActivation?.kind === "select") {
          belongs = sessionActivation.expectedPath === eventPath;
        } else if (
          sessionActivation?.kind === "create" &&
          sessionActivation.commandId === eventCommandId &&
          event.type === "session_switched" &&
          typeof eventPath === "string" &&
          !knownPath
        ) {
          sessionActivation.observedPath = eventPath;
          belongs = true;
        } else if (
          sessionActivation?.kind === "create" &&
          sessionActivation.commandId === eventCommandId &&
          event.type === "session_created" &&
          typeof sessionActivation.observedPath === "string"
        ) {
          belongs = true;
        }
        if (belongs && sessionActivation?.epoch !== sessionEpoch) return;
        if (!belongs) {
          clearCommandDiscovery();
          const epoch = ++sessionEpoch;
          resetThinking();
          promptAdmissionToken = null;
          promptAdmission = null;
          set({
            ...resetLivePatch(),
            promptAdmissionPending: false,
            selectedPath: typeof eventPath === "string" ? eventPath : null,
            draftModel: current.workspaceDraft ? current.draftModel : null,
            modelSelectionPending: false,
            sessionSwitching: true,
          });
          void get()
            .actions.refreshSnapshot({ epoch })
            .then((refreshed) => {
              if (epoch !== sessionEpoch) return;
              set({
                selectedPath: refreshed ? get().selectedPath : null,
                sessionSwitching: false,
              });
            });
        } else {
          set(resetLivePatch());
        }
      } else if (event.type === "prompt_accepted") {
        const settled = terminalPromptIds.has(String(detail.commandId ?? ""));
        set({
          ...promptAcceptedLivePatch(settled, current.livePhase),
          liveRetry: null,
          pendingFollowUpsReceipt: Number.isInteger(detail.pendingFollowUps)
            ? Number(detail.pendingFollowUps)
            : current.pendingFollowUpsReceipt,
        });
      } else if (event.type === "turn_started") {
        set({
          activeTurn: {
            sessionId: String(detail.sessionId),
            commandId: String(detail.commandId),
            epoch: Number(detail.epoch),
          },
          liveRunning: true,
          livePhase: "running",
          liveRetry: null,
          turnTerminalStatus: null,
        });
      } else if (event.type === "agent_start") {
        set({
          ...(detail.activeTurn
            ? { activeTurn: detail.activeTurn as WebStoreState["activeTurn"] }
            : {}),
          liveRunning: true,
          livePhase: "running",
          liveRetry: null,
        });
      } else if (event.type === "turn_settled") {
        rememberBounded(terminalPromptIds, detail.commandId);
        const turn = current.activeTurn;
        if (
          turn?.sessionId === detail.sessionId &&
          turn?.commandId === detail.commandId &&
          turn?.epoch === detail.epoch
        ) {
          set({
            activeTurn: null,
            liveRunning: false,
            livePhase: "idle",
            liveRetry: null,
            turnTerminalStatus:
              typeof detail.outcome === "string" ? detail.outcome : null,
          });
        }
      } else if (event.type === "agent_settled") {
        set({
          pendingFollowUpsReceipt: null,
          ...(!current.activeTurn
            ? {
                liveRunning: false,
                livePhase: "idle" as const,
                liveRetry: null,
              }
            : {}),
        });
      } else if (event.type === "prompt_settled") {
        rememberBounded(terminalPromptIds, detail.commandId);
        if (current.livePhase !== "running")
          set({ liveRunning: false, livePhase: "idle", liveRetry: null });
      } else if (detail.message && typeof detail.message === "object") {
        const message = detail.message as WebLiveMessage;
        let liveMessages = current.liveMessages;
        if (message.role === "user") {
          liveMessages = liveMessages.filter(
            (entry) =>
              !entry.key.startsWith("optimistic-") ||
              entry.message.content !== message.content,
          );
        }
        const key =
          typeof detail.messageKey === "string"
            ? detail.messageKey
            : `${message.role || "message"}-${event.sequence}`;
        const live = { key, message };
        const index = liveMessages.findIndex((entry) => entry.key === key);
        liveMessages =
          index >= 0
            ? liveMessages.map((entry, entryIndex) =>
                entryIndex === index ? live : entry,
              )
            : [...liveMessages, live].slice(-8);
        const thinkingStarts = { ...current.thinkingStarts };
        const thinkingDurations = { ...current.thinkingDurations };
        if (message.parts?.some((part) => part.type === "thinking")) {
          thinkingStarts[key] ??= Date.now();
          if (event.type === "message_end") {
            thinkingDurations[key] = Date.now() - thinkingStarts[key];
          }
        }
        set({ liveMessages, thinkingDurations, thinkingStarts });
      }

      if (event.type === "prompt_failed") {
        rememberBounded(terminalPromptIds, detail.commandId);
        set({
          liveMessages: get().liveMessages.filter(
            (entry) => !entry.key.startsWith("optimistic-"),
          ),
          liveRunning: false,
          livePhase: "idle",
          liveRetry: null,
          notice:
            typeof detail.error === "string" ? detail.error : "Prompt failed",
        });
      }
      if (event.type === "auto_retry_start") {
        set({
          liveRunning: true,
          livePhase: "running",
          liveRetry: {
            attempt: Number(detail.attempt) || 0,
            maxAttempts: Number(detail.maxAttempts) || 0,
          },
        });
      }
      if (event.type === "thinking_level_changed") {
        const thinking = get().snapshot?.thinking;
        if (thinking && typeof detail.level === "string") {
          acceptThinking({
            ...thinking,
            level: detail.level,
            revision: event.sequence,
          });
        }
      }
      if (refreshEventTypes.has(event.type)) scheduleSnapshotRefresh();
    };

    const runEventLoop = async (signal: AbortSignal) => {
      let reconnectDelay = 500;
      while (!signal.aborted) {
        let recoveryAttempted = false;
        try {
          if (get().cursor === null) {
            recoveryAttempted = true;
            const ready = await get().actions.refreshSnapshot({
              resetCursor: true,
            });
            if (!ready) throw new Error("snapshot unavailable");
            recoveryAttempted = false;
          }
          if (signal.aborted) return;
          await consumeEvents({
            client,
            cursor: get().cursor ?? 0,
            onConnected: () => {
              reconnectDelay = 500;
              set({ connection: "connected", notice: null });
            },
            onEvent: applyRuntimeEvent,
            onHeartbeat: () => scheduleSnapshotRefresh(0),
            signal,
          });
        } catch (error) {
          if (signal.aborted) return;
          set({ connection: "reconnecting" });
          const recovered =
            !recoveryAttempted &&
            (await get().actions.refreshSnapshot({ resetCursor: true }));
          if (!recovered) set(resetLivePatch());
          await waitForReconnect(reconnectDelay, signal);
          reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
          if (error instanceof SyntaxError)
            set({ notice: "Invalid event data" });
        }
      }
    };

    const actions: WebStoreActions = {
      start() {
        if (streamController) return;
        streamController = new AbortController();
        void runEventLoop(streamController.signal);
      },
      stop() {
        streamController?.abort();
        streamController = null;
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = null;
        resetThinking();
        clearCommandDiscovery();
      },
      async refreshSnapshot(options = {}) {
        const epoch = options.epoch ?? sessionEpoch;
        const generation = ++snapshotGeneration;
        const requestedPath = get().selectedPath;
        try {
          const snapshot = await client.snapshot(requestedPath);
          if (epoch !== sessionEpoch || generation !== snapshotGeneration)
            return false;
          const hasCurrent = typeof snapshot.currentSessionId === "string";
          const currentSession = hasCurrent
            ? snapshot.sessions.find(
                (session) => session.id === snapshot.currentSessionId,
              )
            : undefined;
          const selectedIsCurrent = hasCurrent
            ? snapshot.selectedSession?.id === snapshot.currentSessionId
            : snapshot.selectedSession === undefined;
          const requestedExists =
            !requestedPath ||
            snapshot.sessions.some((session) => session.path === requestedPath);
          const requestedMatches =
            !requestedPath || snapshot.selectedSession?.path === requestedPath;
          if (!requestedExists || !requestedMatches || !selectedIsCurrent) {
            set({ selectedPath: null });
            if (!options.canonicalRetry) {
              return actions.refreshSnapshot({
                ...options,
                canonicalRetry: true,
                epoch,
              });
            }
            return false;
          }
          const selectedSessionWorkspace = snapshot.selectedSession?.cwd;
          const activeWorkspace = snapshot.workspaces.find(
            (workspace) => workspace.current,
          )?.path;
          const retainedWorkspace = snapshot.workspaces.some(
            (workspace) => workspace.path === get().selectedWorkspace,
          )
            ? get().selectedWorkspace
            : undefined;
          const selectedWorkspace = get().workspaceDraft
            ? get().selectedWorkspace
            : snapshot.workspaces.some(
                  (workspace) => workspace.path === selectedSessionWorkspace,
                )
              ? selectedSessionWorkspace
              : (activeWorkspace ?? retainedWorkspace ?? null);
          const shouldReset = options.resetCursor;
          if (shouldReset) {
            // A cursor reset means a fresh stream (e.g. host restart), whose
            // sequence restarts at 0. The old revision gate would reject every
            // projection below the old floor and freeze the picker.
            clearThinkingGate();
          }
          const previousSessionId = get().snapshot?.currentSessionId;
          if (previousSessionId !== snapshot.currentSessionId) {
            clearCommandDiscovery();
          }
          set({
            ...(shouldReset ? resetLivePatch() : {}),
            connection:
              get().connection === "connecting"
                ? "connecting"
                : get().connection,
            cursor:
              shouldReset || get().cursor === null
                ? snapshot.cursor
                : Math.max(get().cursor ?? 0, snapshot.cursor),
            activeTurn: snapshot.runtime.activeTurn ?? null,
            livePhase:
              snapshot.runtime.status !== "running" &&
              !get().promptAdmissionPending &&
              !promptAdmission
                ? "idle"
                : get().livePhase,
            liveRetry:
              snapshot.runtime.status !== "running" &&
              !get().promptAdmissionPending &&
              !promptAdmission
                ? null
                : get().liveRetry,
            liveRunning:
              snapshot.runtime.status === "running"
                ? true
                : !get().promptAdmissionPending && !promptAdmission
                  ? false
                  : get().liveRunning,
            selectedPath:
              currentSession?.path ?? snapshot.selectedSession?.path ?? null,
            selectedWorkspace,
            snapshot,
            ...resetModelSearch(),
          });
          acceptThinking();
          return true;
        } catch (error) {
          if (epoch !== sessionEpoch || generation !== snapshotGeneration)
            return false;
          set({ connection: "unavailable" });
          showError(error);
          return false;
        }
      },
      async chooseWorkspace() {
        const epoch = sessionEpoch;
        try {
          const result = await client.chooseWorkspace();
          if (epoch !== sessionEpoch) return;
          if (result.cancelled || !result.path) return;
          actions.setWorkspace(result.path);
          await actions.refreshSnapshot();
        } catch (error) {
          if (epoch === sessionEpoch) showError(error);
        }
      },
      setWorkspace(path) {
        const current = get();
        if (path === current.selectedWorkspace && !current.sessionSwitching)
          return;
        ++sessionEpoch;
        resetThinking();
        clearCommandDiscovery();
        promptAdmissionToken = null;
        promptAdmission = null;
        set({
          ...resetLivePatch(),
          ...resetModelSearch(),
          selectedWorkspace: path,
          workspaceDraft: true,
          sessionSwitching: false,
          modelSelectionPending: false,
          promptAdmissionPending: false,
          notice: null,
        });
      },
      async renameWorkspace(path, name) {
        try {
          await client.renameWorkspace(path, name);
          await actions.refreshSnapshot();
        } catch (error) {
          showError(error);
          throw error;
        }
      },
      async removeWorkspace(path) {
        try {
          await client.removeWorkspace(path);
          if (get().selectedWorkspace === path) clearCommandDiscovery();
          set({
            selectedPath: null,
            selectedWorkspace:
              get().selectedWorkspace === path ? null : get().selectedWorkspace,
          });
          await actions.refreshSnapshot();
        } catch (error) {
          showError(error);
        }
      },
      async createSession(workspacePath) {
        if (!workspacePath || get().modelSelectionPending) return false;
        const epoch = ++sessionEpoch;
        resetThinking();
        clearCommandDiscovery();
        const commandId =
          globalThis.crypto?.randomUUID?.() ??
          `web-create-${Date.now()}-${epoch}`;
        promptAdmissionToken = null;
        promptAdmission = null;
        set({
          ...resetLivePatch(),
          ...resetModelSearch(),
          mobileSidebarOpen: false,
          promptAdmissionPending: false,
          selectedPath: null,
          selectedWorkspace: workspacePath,
          workspaceDraft: true,
          sessionSwitching: true,
        });
        let created = false;
        const creation = sessionSelectionTail.then(async () => {
          if (epoch !== sessionEpoch) return;
          sessionActivation = {
            commandId,
            epoch,
            expectedPath: null,
            kind: "create",
            observedPath: null,
          };
          try {
            const receipt = await client.createSession(
              workspacePath,
              commandId,
            );
            if (epoch !== sessionEpoch) return;
            if (receipt.cancelled || !receipt.sessionPath) {
              throw new Error(
                "Session creation was not confirmed. Please try again.",
              );
            }
            set({ selectedPath: null });
            let refreshed = await actions.refreshSnapshot({ epoch });
            if (!refreshed && epoch === sessionEpoch) {
              // A Session event may start a newer snapshot while this
              // authoritative creation refresh is in flight. Retry once so
              // the receipt can still be checked against canonical Pi state.
              refreshed = await actions.refreshSnapshot({ epoch });
            }
            if (epoch !== sessionEpoch) return;
            if (!refreshed) {
              throw new Error(
                "The created Session could not be confirmed. Please try again.",
              );
            }
            const selected = get().snapshot?.selectedSession;
            // A successful HTTP response alone cannot authorize a prompt:
            // another browser may have activated a different Session meanwhile.
            if (
              !selected ||
              selected.path !== receipt.sessionPath ||
              selected.cwd !== workspacePath ||
              selected.id !== get().snapshot?.currentSessionId
            ) {
              throw new Error(
                "The created Session is no longer active in the selected workspace. Please try again.",
              );
            }
            set({ workspaceDraft: false, notice: null });
            const draft = get().draftModel;
            const sessionId = selected.id;
            created = !draft || (await applyModel(draft, epoch, sessionId));
          } catch (error) {
            if (epoch !== sessionEpoch) return;
            set({ selectedPath: null });
            showError(error);
            await actions.refreshSnapshot({ epoch });
          } finally {
            rememberBounded(completedActivationIds, commandId);
            if (sessionActivation?.epoch === epoch) sessionActivation = null;
            if (epoch === sessionEpoch) set({ sessionSwitching: false });
          }
        });
        sessionSelectionTail = creation.catch(() => undefined);
        await creation;
        return created && epoch === sessionEpoch;
      },
      async selectSession(path) {
        if (!path) return;
        clearCommandDiscovery();
        set({
          ...resetModelSearch(),
          workspaceDraft: false,
          draftModel: null,
          modelSelectionPending: false,
        });
        const epoch = ++sessionEpoch;
        resetThinking();
        promptAdmissionToken = null;
        promptAdmission = null;
        set({
          ...resetLivePatch(),
          mobileSidebarOpen: false,
          promptAdmissionPending: false,
          selectedPath: path,
          sessionSwitching: true,
        });
        const selection = sessionSelectionTail.then(async () => {
          if (epoch !== sessionEpoch) return;
          sessionActivation = { epoch, expectedPath: path, kind: "select" };
          try {
            await client.selectSession(path);
            if (epoch !== sessionEpoch) return;
            if (!(await actions.refreshSnapshot({ epoch }))) {
              set({ selectedPath: null });
            }
          } catch (error) {
            if (epoch !== sessionEpoch) return;
            set({ selectedPath: null });
            showError(error);
            await actions.refreshSnapshot({ epoch });
          } finally {
            if (sessionActivation?.epoch === epoch) sessionActivation = null;
            if (epoch === sessionEpoch) set({ sessionSwitching: false });
          }
        });
        sessionSelectionTail = selection.catch(() => undefined);
        await selection;
      },
      async renameSession(path, name) {
        try {
          await client.renameSession(path, name);
          await actions.refreshSnapshot();
        } catch (error) {
          showError(error);
          throw error;
        }
      },
      async archiveSession(path) {
        try {
          await client.archiveSession(path);
          await actions.refreshSnapshot();
        } catch (error) {
          showError(error);
        }
      },
      async unarchiveSession(path) {
        const epoch = sessionEpoch;
        try {
          await client.unarchiveSession(path);
          if (epoch !== sessionEpoch) return true;
          return await actions.refreshSnapshot({ epoch });
        } catch (error) {
          if (epoch === sessionEpoch) showError(error);
          return false;
        }
      },
      async selectModel(value) {
        const [provider, ...idParts] = value.split("/");
        const modelId = idParts.join("/");
        const state = get();
        if (
          !provider ||
          !modelId ||
          state.sessionSwitching ||
          state.modelSelectionPending ||
          state.promptAdmissionPending ||
          (!state.workspaceDraft &&
            (state.liveRunning || state.snapshot?.runtime.status === "running"))
        )
          return;
        const sessionId = state.snapshot?.selectedSession?.id;
        if (
          state.workspaceDraft ||
          (!sessionId && !state.snapshot?.currentSessionId)
        ) {
          const model = [
            ...(state.snapshot?.models ?? []),
            ...state.modelSearch.models,
          ].find((item) => item.provider === provider && item.id === modelId);
          if (model) set({ draftModel: model, notice: null });
          return;
        }
        if (!sessionId || sessionId !== state.snapshot?.currentSessionId)
          return;
        resetThinking();
        await applyModel({ provider, id: modelId }, sessionEpoch, sessionId);
      },
      async searchModels(query) {
        const normalized = query.trim();
        if (!normalized) {
          set(resetModelSearch());
          return;
        }
        modelSearchController?.abort();
        const controller = new AbortController();
        modelSearchController = controller;
        const generation = ++modelSearchGeneration;
        const epoch = sessionEpoch;
        const catalogGeneration = snapshotGeneration;
        const sessionId = get().snapshot?.currentSessionId;
        set({
          modelSearch: {
            query: normalized,
            status: "loading",
            models: [],
            totalMatches: 0,
            matchesOmitted: 0,
            error: null,
          },
        });
        try {
          const result = await client.searchModels(
            normalized,
            sessionId,
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            epoch !== sessionEpoch ||
            catalogGeneration !== snapshotGeneration ||
            generation !== modelSearchGeneration
          )
            return;
          set({
            modelSearch: {
              query: normalized,
              status: "ready",
              models: result.models,
              totalMatches: result.totalMatches,
              matchesOmitted: result.truncation.matchesOmitted,
              error: null,
            },
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            epoch !== sessionEpoch ||
            catalogGeneration !== snapshotGeneration ||
            generation !== modelSearchGeneration
          )
            return;
          set({
            modelSearch: {
              query: normalized,
              status: "error",
              models: [],
              totalMatches: 0,
              matchesOmitted: 0,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          if (modelSearchController === controller)
            modelSearchController = null;
        }
      },
      clearModelSearch() {
        set(resetModelSearch());
      },
      selectThinking(level) {
        const state = get();
        const thinking = state.snapshot?.thinking;
        const sessionId = state.snapshot?.selectedSession?.id;
        if (
          !level ||
          !thinking?.supported ||
          state.sessionSwitching ||
          state.modelSelectionPending ||
          state.workspaceDraft ||
          !sessionId ||
          sessionId !== state.snapshot?.currentSessionId ||
          state.liveRunning ||
          state.snapshot?.runtime.status === "running"
        )
          return;
        if (level === (state.thinkingPendingLevel ?? thinking.level)) return;
        thinkingTarget = level;
        thinkingSeq++;
        set({ thinkingPendingLevel: level });
        void flushThinking();
      },
      async cancelActiveTurn() {
        const turn = get().activeTurn ?? get().snapshot?.runtime.activeTurn;
        if (!turn || get().turnCancellationPending || get().sessionSwitching)
          return;
        const epoch = sessionEpoch;
        set({ turnCancellationPending: true });
        try {
          await client.cancelActiveTurn(turn);
        } catch (error) {
          if (epoch !== sessionEpoch) return;
          await actions.refreshSnapshot({ epoch });
          if (epoch === sessionEpoch) showError(error);
        } finally {
          if (epoch === sessionEpoch) set({ turnCancellationPending: false });
        }
      },
      async sendPrompt(rawContent) {
        const content = rawContent.trim();
        const workspace = get().selectedWorkspace;
        if (
          !workspace ||
          !content ||
          get().sessionSwitching ||
          get().promptAdmissionPending ||
          get().modelSelectionPending ||
          get().thinkingPendingLevel !== null
        ) {
          return false;
        }
        const creating =
          get().workspaceDraft || !get().snapshot?.selectedSession?.id;
        if (creating && !(await actions.createSession(workspace))) return false;
        if (creating && get().draftModel) return false;
        const sessionId = get().snapshot?.selectedSession?.id;
        if (
          !sessionId ||
          get().workspaceDraft ||
          get().selectedWorkspace !== workspace ||
          get().snapshot?.selectedSession?.cwd !== workspace ||
          sessionId !== get().snapshot?.currentSessionId ||
          get().sessionSwitching ||
          get().promptAdmissionPending
        ) {
          return false;
        }
        const epoch = sessionEpoch;
        const draft = get().draftModel;
        if (draft && !(await applyModel(draft, epoch, sessionId))) return false;
        if (
          epoch !== sessionEpoch ||
          sessionId !== get().snapshot?.selectedSession?.id ||
          sessionId !== get().snapshot?.currentSessionId ||
          get().workspaceDraft ||
          get().selectedWorkspace !== workspace ||
          get().snapshot?.selectedSession?.cwd !== workspace
        )
          return false;
        const admission = ++promptAdmissionSequence;
        const retrying =
          promptAdmission?.sessionId === sessionId &&
          promptAdmission.content === content;
        const commandId = retrying
          ? promptAdmission!.commandId
          : (globalThis.crypto?.randomUUID?.() ??
            `web-prompt-${Date.now()}-${admission}`);
        const optimisticKey = retrying
          ? promptAdmission!.optimisticKey
          : `optimistic-${commandId}`;
        promptAdmission = { sessionId, content, commandId, optimisticKey };
        promptAdmissionToken = admission;
        set({
          liveMessages: retrying
            ? get().liveMessages
            : [
                ...get().liveMessages,
                { key: optimisticKey, message: { role: "user", content } },
              ].slice(-8),
          notice: null,
          pendingFollowUpsReceipt: null,
          turnTerminalStatus: null,
          promptAdmissionPending: true,
          scrollToBottom: get().scrollToBottom + 1,
        });
        try {
          const receipt = await client.prompt(
            sessionId,
            content,
            commandId,
            retrying,
          );
          if (epoch !== sessionEpoch || promptAdmissionToken !== admission)
            return false;
          const settled = terminalPromptIds.has(receipt.id);
          if (promptAdmission?.commandId === commandId) promptAdmission = null;
          set({
            ...promptAcceptedLivePatch(settled, get().livePhase),
            pendingFollowUpsReceipt: receipt.pendingFollowUps ?? null,
          });
          scheduleSnapshotRefresh(120);
          return true;
        } catch (error) {
          if (epoch !== sessionEpoch || promptAdmissionToken !== admission)
            return false;
          const knownRejection =
            error instanceof WebApiError &&
            [
              "WORKSPACE_REQUIRED",
              "SESSION_CONFLICT",
              "PROMPT_REJECTED",
              "COMMAND_CONFLICT",
              "PROMPT_ADMISSION_CAPACITY",
            ].includes(error.code ?? "");
          if (!knownRejection) {
            set({
              liveRunning: true,
              livePhase:
                get().livePhase === "running" ? "running" : "preparing",
              liveRetry: null,
            });
            showError(error);
            return false;
          }
          if (promptAdmission?.commandId === commandId) promptAdmission = null;
          set({
            liveMessages: get().liveMessages.filter(
              (entry) => entry.key !== optimisticKey,
            ),
            livePhase: "idle",
            liveRetry: null,
            liveRunning: false,
          });
          showError(error);
          return false;
        } finally {
          if (epoch === sessionEpoch && promptAdmissionToken === admission) {
            promptAdmissionToken = null;
            set({ promptAdmissionPending: false });
          }
        }
      },
      async discoverCommands() {
        const state = get();
        const sessionId = state.snapshot?.selectedSession?.id;
        if (
          state.workspaceDraft ||
          !sessionId ||
          sessionId !== state.snapshot?.currentSessionId ||
          state.sessionSwitching
        ) {
          clearCommandDiscovery();
          return;
        }
        if (
          state.commandDiscovery.sessionId === sessionId &&
          (state.commandDiscovery.status === "loading" ||
            state.commandDiscovery.status === "ready")
        ) {
          return;
        }
        const epoch = sessionEpoch;
        const generation = ++commandDiscoveryGeneration;
        commandDiscoveryController?.abort();
        const controller = new AbortController();
        commandDiscoveryController = controller;
        set({
          commandDiscovery: {
            sessionId,
            status: "loading",
            commands: [],
            totalAvailable: 0,
            commandsOmitted: 0,
            error: null,
          },
        });
        try {
          const result = await client.commands(sessionId, controller.signal);
          if (
            controller.signal.aborted ||
            epoch !== sessionEpoch ||
            generation !== commandDiscoveryGeneration ||
            sessionId !== get().snapshot?.currentSessionId
          ) {
            return;
          }
          set({
            commandDiscovery: {
              sessionId,
              status: "ready",
              commands: result.commands,
              totalAvailable: result.totalAvailable,
              commandsOmitted: result.truncation.commandsOmitted,
              error: null,
            },
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            epoch !== sessionEpoch ||
            generation !== commandDiscoveryGeneration
          ) {
            return;
          }
          set({
            commandDiscovery: {
              sessionId,
              status: "error",
              commands: [],
              totalAvailable: 0,
              commandsOmitted: 0,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          if (commandDiscoveryController === controller) {
            commandDiscoveryController = null;
          }
        }
      },
      clearCommandDiscovery,
      setQuery(query) {
        set({ query });
      },
      setSearchOpen(open) {
        set({ searchOpen: open, ...(open ? {} : { query: "" }) });
      },
      toggleWorkspace(path) {
        const collapsed = new Set(get().collapsed);
        if (collapsed.has(path)) collapsed.delete(path);
        else collapsed.add(path);
        persist(collapsedWorkspacesStorageKey, [...collapsed]);
        set({ collapsed });
      },
      toggleSidebar(narrow) {
        if (narrow) {
          set({ mobileSidebarOpen: !get().mobileSidebarOpen });
          return;
        }
        const sidebarCollapsed = !get().sidebarCollapsed;
        try {
          window.sessionStorage.setItem(
            sidebarCollapsedStorageKey,
            String(sidebarCollapsed),
          );
        } catch {}
        set({ sidebarCollapsed });
      },
      closeMobileSidebar() {
        set({ mobileSidebarOpen: false });
      },
      clearNotice() {
        set({ notice: null });
      },
    };

    return {
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      snapshot: null,
      cursor: null,
      selectedPath: null,
      selectedWorkspace: null,
      workspaceDraft: false,
      draftModel: null,
      modelSelectionPending: false,
      modelSearch: {
        query: "",
        status: "idle",
        models: [],
        totalMatches: 0,
        matchesOmitted: 0,
        error: null,
      },
      collapsed: readStringSet(collapsedWorkspacesStorageKey),
      sidebarCollapsed: readBoolean(sidebarCollapsedStorageKey),
      mobileSidebarOpen: false,
      query: "",
      searchOpen: false,
      connection: "connecting",
      notice: null,
      liveMessages: [],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      promptAdmissionPending: false,
      sessionSwitching: false,
      scrollToBottom: 0,
      thinkingPendingLevel: null,
      commandDiscovery: emptyCommandDiscovery(),
      actions,
    };
  });

  return store;
}

export const webStore = createWebStore();
