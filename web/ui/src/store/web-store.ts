import { createStore } from "zustand/vanilla";
import type {
  WebEvent,
  WebLiveMessage,
  WebSnapshot,
} from "../../../protocol/types.ts";
import { WebClient } from "../protocol/client.ts";
import { consumeEventStream } from "../protocol/event-stream.ts";

const collapsedWorkspacesStorageKey = "openpi.collapsed-workspaces";
const sidebarCollapsedStorageKey = "openpi.sidebar-collapsed";
const refreshEventTypes = new Set([
  "agent_start",
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

export interface WebStoreState {
  snapshot: WebSnapshot | null;
  cursor: number | null;
  selectedPath: string | null;
  selectedWorkspace: string | null;
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
  createSession: (workspacePath: string) => Promise<void>;
  selectSession: (path: string) => Promise<void>;
  renameSession: (path: string, name: string) => Promise<void>;
  archiveSession: (path: string) => Promise<void>;
  selectModel: (value: string) => Promise<void>;
  sendPrompt: (content: string) => Promise<boolean>;
  setQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  toggleWorkspace: (path: string) => void;
  toggleSidebar: (narrow: boolean) => void;
  closeMobileSidebar: () => void;
  clearNotice: () => void;
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
  let sessionActivation: SessionActivation | null = null;
  let sessionSelectionTail = Promise.resolve();
  let refreshTimer: number | null = null;
  let refreshInFlight = false;
  let refreshPending = false;
  let streamController: AbortController | null = null;
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
    liveMessages: [] as LiveEntry[],
    liveRunning: false,
    livePhase: "idle" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
  });

  const promptAcceptedLivePatch = (
    settled: boolean,
    currentPhase: WebStoreState["livePhase"],
  ) => ({
    liveRunning: !settled,
    livePhase: settled
      ? ("idle" as const)
      : currentPhase === "running"
        ? ("running" as const)
        : ("preparing" as const),
  });

  const store = createStore<WebStoreState>((set, get) => {
    const showError = (error: unknown) => {
      set({
        notice: error instanceof Error ? error.message : String(error),
      });
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

    const applyRuntimeEvent = (event: WebEvent) => {
      const current = get();
      const detail = event.detail ?? {};
      const eventSessionId = detail.sessionId;
      const sessionTransition = [
        "session_start",
        "session_switched",
        "session_created",
      ].includes(event.type);
      set({ cursor: event.sequence });

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
          const epoch = ++sessionEpoch;
          promptAdmissionToken = null;
          set({
            ...resetLivePatch(),
            promptAdmissionPending: false,
            selectedPath: typeof eventPath === "string" ? eventPath : null,
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
        });
      } else if (event.type === "agent_start") {
        set({ liveRunning: true, livePhase: "running", liveRetry: null });
      } else if (
        event.type === "agent_settled" ||
        event.type === "prompt_settled"
      ) {
        if (event.type === "prompt_settled") {
          rememberBounded(terminalPromptIds, detail.commandId);
        }
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
      if (refreshEventTypes.has(event.type)) scheduleSnapshotRefresh();
    };

    const runEventLoop = async (signal: AbortSignal) => {
      let reconnectDelay = 500;
      while (!signal.aborted) {
        let recovered = false;
        try {
          if (get().cursor === null) {
            recovered = await get().actions.refreshSnapshot({
              resetCursor: true,
            });
            if (!recovered) throw new Error("snapshot unavailable");
          }
          await consumeEvents({
            client,
            cursor: get().cursor ?? 0,
            onConnected: () => {
              reconnectDelay = 500;
              set({ connection: "connected", notice: null });
            },
            onEvent: applyRuntimeEvent,
            signal,
          });
        } catch (error) {
          if (signal.aborted) return;
          set({ connection: "reconnecting" });
          if (!recovered) {
            recovered = await get().actions.refreshSnapshot({
              resetCursor: true,
            });
          }
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
          const selectedWorkspace = snapshot.workspaces.some(
            (workspace) => workspace.path === selectedSessionWorkspace,
          )
            ? selectedSessionWorkspace
            : (activeWorkspace ?? retainedWorkspace ?? null);
          const shouldReset = options.resetCursor;
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
            livePhase:
              snapshot.runtime.status !== "running" &&
              !get().promptAdmissionPending
                ? "idle"
                : get().livePhase,
            liveRetry:
              snapshot.runtime.status !== "running" &&
              !get().promptAdmissionPending
                ? null
                : get().liveRetry,
            liveRunning:
              snapshot.runtime.status !== "running" &&
              !get().promptAdmissionPending
                ? false
                : get().liveRunning,
            selectedPath:
              currentSession?.path ?? snapshot.selectedSession?.path ?? null,
            selectedWorkspace,
            snapshot,
          });
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
        try {
          const result = await client.chooseWorkspace();
          if (result.cancelled || !result.path) return;
          set({ selectedWorkspace: result.path });
          await actions.refreshSnapshot();
        } catch (error) {
          showError(error);
        }
      },
      setWorkspace(path) {
        set({ selectedWorkspace: path });
        void actions.refreshSnapshot();
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
        if (!workspacePath) return;
        const epoch = ++sessionEpoch;
        const commandId =
          globalThis.crypto?.randomUUID?.() ??
          `web-create-${Date.now()}-${epoch}`;
        promptAdmissionToken = null;
        set({
          ...resetLivePatch(),
          mobileSidebarOpen: false,
          promptAdmissionPending: false,
          selectedPath: null,
          selectedWorkspace: workspacePath,
          sessionSwitching: true,
        });
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
            await client.createSession(workspacePath, commandId);
            if (epoch !== sessionEpoch) return;
            set({ selectedPath: null });
            await actions.refreshSnapshot({ epoch });
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
      },
      async selectSession(path) {
        if (!path) return;
        const epoch = ++sessionEpoch;
        promptAdmissionToken = null;
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
      async selectModel(value) {
        const [provider, ...idParts] = value.split("/");
        const modelId = idParts.join("/");
        const epoch = sessionEpoch;
        const sessionId = get().snapshot?.selectedSession?.id;
        if (!provider || !modelId || !sessionId || get().sessionSwitching)
          return;
        try {
          await client.selectModel(provider, modelId, sessionId);
          if (
            epoch !== sessionEpoch ||
            sessionId !== get().snapshot?.selectedSession?.id
          ) {
            return;
          }
          await actions.refreshSnapshot({ epoch });
        } catch (error) {
          if (
            epoch !== sessionEpoch ||
            sessionId !== get().snapshot?.selectedSession?.id
          ) {
            return;
          }
          showError(error);
          await actions.refreshSnapshot({ epoch });
        }
      },
      async sendPrompt(rawContent) {
        const content = rawContent.trim();
        const workspace = get().selectedWorkspace;
        if (
          !workspace ||
          !content ||
          get().sessionSwitching ||
          get().promptAdmissionPending
        ) {
          return false;
        }
        if (!get().snapshot?.selectedSession?.id)
          await actions.createSession(workspace);
        const sessionId = get().snapshot?.selectedSession?.id;
        if (
          !sessionId ||
          get().sessionSwitching ||
          get().promptAdmissionPending
        ) {
          return false;
        }
        const epoch = sessionEpoch;
        const admission = ++promptAdmissionSequence;
        const optimisticKey = `optimistic-${Date.now()}`;
        promptAdmissionToken = admission;
        set({
          liveMessages: [
            ...get().liveMessages,
            { key: optimisticKey, message: { role: "user", content } },
          ].slice(-8),
          notice: null,
          promptAdmissionPending: true,
          scrollToBottom: get().scrollToBottom + 1,
        });
        try {
          const receipt = await client.prompt(sessionId, content);
          if (epoch !== sessionEpoch || promptAdmissionToken !== admission)
            return false;
          const settled = terminalPromptIds.has(receipt.id);
          set(promptAcceptedLivePatch(settled, get().livePhase));
          scheduleSnapshotRefresh(120);
          return true;
        } catch (error) {
          if (epoch !== sessionEpoch || promptAdmissionToken !== admission)
            return false;
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
      snapshot: null,
      cursor: null,
      selectedPath: null,
      selectedWorkspace: null,
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
      actions,
    };
  });

  return store;
}

export const webStore = createWebStore();
