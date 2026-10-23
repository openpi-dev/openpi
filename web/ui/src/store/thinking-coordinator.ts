import type { WebSnapshot, WebThinkingState } from "../../../protocol/types.ts";
import { i18n } from "../i18n.ts";
import { isControlledSession } from "../lib/session-control.ts";
import type { WebClient } from "../protocol/client.ts";

interface ThinkingStoreState {
  snapshot: WebSnapshot | null;
  selectedPath: string | null;
  thinkingPendingLevel: string | null;
  sessionSwitching: boolean;
  modelSelectionPending: boolean;
  workspaceDraft: boolean;
  liveRunning: boolean;
}

/** Owns thinking intent and confirmation; Session identity stays in the store. */
export function createThinkingCoordinator({
  client,
  get,
  set,
  getEpoch,
  showError,
  scheduleSnapshotRefresh,
}: {
  client: Pick<WebClient, "thinking" | "setThinkingLevel">;
  get: () => ThinkingStoreState;
  set: (
    patch: Partial<
      Pick<ThinkingStoreState, "snapshot" | "thinkingPendingLevel">
    >,
  ) => void;
  getEpoch: () => number;
  showError: (error: unknown) => void;
  scheduleSnapshotRefresh: () => void;
}) {
  let thinkingTarget: string | null = null;
  let thinkingSeq = 0;
  let thinkingInFlight = false;
  let thinkingFlushToken = 0;
  let receiptGeneration = 0;
  let lastThinkingRevision = 0;
  let acceptedThinking: WebThinkingState | null = null;
  let acceptedThinkingEpoch = -1;

  // Accepted-value bookkeeping. `acceptedThinking` holds the highest revision
  // we have confirmed from a snapshot, a POST response, or a local event
  // patch; anything older is refused so an out-of-order snapshot can never
  // regress the displayed level. The gate is scoped to the Session epoch so a
  // session switch (or host restart) cannot carry a stale value forward.
  const clearThinkingGate = () => {
    receiptGeneration++;
    acceptedThinking = null;
    lastThinkingRevision = 0;
    acceptedThinkingEpoch = -1;
  };

  const reconcileSnapshotThinking = () => {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    if (acceptedThinking && acceptedThinkingEpoch !== getEpoch()) {
      clearThinkingGate();
    }
    const incoming = snapshot.thinking;
    // An absent projection is authoritative: never resurrect a local value.
    if (!incoming) return;
    if (!acceptedThinking || incoming.revision >= lastThinkingRevision) {
      acceptedThinking = incoming;
      lastThinkingRevision = incoming.revision;
      acceptedThinkingEpoch = getEpoch();
      return;
    }
    if (incoming !== acceptedThinking) {
      set({ snapshot: { ...snapshot, thinking: acceptedThinking } });
    }
  };

  const acceptThinking = (next?: WebThinkingState) => {
    if (acceptedThinking && acceptedThinkingEpoch !== getEpoch()) {
      clearThinkingGate();
    }
    if (next && next.revision >= lastThinkingRevision) {
      acceptedThinking = next;
      lastThinkingRevision = next.revision;
      acceptedThinkingEpoch = getEpoch();
    }
    reconcileSnapshotThinking();
  };

  const resetThinking = () => {
    thinkingTarget = null;
    thinkingSeq++;
    thinkingFlushToken++;
    thinkingInFlight = false;
    set({ thinkingPendingLevel: null });
  };

  const reconcileThinking = async () => {
    const generation = receiptGeneration;
    const flushToken = thinkingFlushToken;
    const epoch = getEpoch();
    const sessionId = get().snapshot?.selectedSession?.id;
    const sessionPath = get().selectedPath;
    if (!sessionId) return;
    try {
      const result = await client.thinking(
        sessionId,
        new AbortController().signal,
      );
      if (
        generation !== receiptGeneration ||
        flushToken !== thinkingFlushToken ||
        epoch !== getEpoch() ||
        sessionPath !== get().selectedPath ||
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
        const generation = receiptGeneration;
        const epoch = getEpoch();
        const sessionId = get().snapshot?.selectedSession?.id;
        const sessionPath = get().selectedPath;
        if (
          !sessionId ||
          !sessionPath ||
          sessionId !== get().snapshot?.currentSessionId ||
          sessionPath !== get().snapshot?.selectedSession?.path ||
          get().modelSelectionPending
        ) {
          resetThinking();
          return;
        }
        let result: WebThinkingState;
        try {
          result = await client.setThinkingLevel(
            sessionId,
            target,
            sessionPath,
          );
        } catch (error) {
          // A superseded session owns its own flush; drop this one instead of
          // re-looping into a duplicate POST. Same-epoch newer intent still
          // re-reads the latest target below.
          if (
            flushToken !== thinkingFlushToken ||
            epoch !== getEpoch() ||
            sessionPath !== get().selectedPath ||
            sessionId !== get().snapshot?.selectedSession?.id
          )
            return;
          if (generation !== receiptGeneration || seq !== thinkingSeq) continue;
          resetThinking();
          showError(error);
          void reconcileThinking();
          return;
        }
        if (
          flushToken !== thinkingFlushToken ||
          epoch !== getEpoch() ||
          sessionPath !== get().selectedPath ||
          sessionId !== get().snapshot?.selectedSession?.id
        ) {
          // The session changed underneath this request; a newer flush (if
          // any) already owns the pending intent. Drop the superseded flush
          // rather than re-looping and issuing a duplicate POST.
          return;
        }
        // A reconnect can reset the receipt revision while preserving intent.
        // Confirm that intent again instead of importing an old host's floor.
        if (generation !== receiptGeneration || seq !== thinkingSeq) continue;
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

  const select = (level: string) => {
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
      !isControlledSession(state.snapshot) ||
      sessionId !== state.snapshot?.currentSessionId ||
      state.selectedPath !== state.snapshot?.selectedSession?.path ||
      state.liveRunning ||
      state.snapshot?.runtime.status === "running"
    )
      return;
    if (level === (state.thinkingPendingLevel ?? thinking.level)) return;
    thinkingTarget = level;
    thinkingSeq++;
    set({ thinkingPendingLevel: level });
    void flushThinking();
  };

  return {
    select,
    accept: acceptThinking,
    resetPending: resetThinking,
    resetGate: clearThinkingGate,
  };
}
