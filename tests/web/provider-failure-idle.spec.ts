// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import type { WebEvent, WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import type { EventStreamOptions } from "../../web/ui/src/protocol/event-stream.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-10-16T00:00:00Z",
    cursor: 4,
    preferences: { theme: "system" },
    currentSessionId: "session-1",
    currentSessionPath: "/tmp/ws/session.jsonl",
    workspaces: [{ path: "/tmp/ws", name: "Workspace", current: true }],
    sessions: [
      {
        id: "session-1",
        path: "/tmp/ws/session.jsonl",
        cwd: "/tmp/ws",
        name: "Current",
        modified: "2026-10-16T00:00:00Z",
        created: "2026-10-16T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 1,
        firstMessage: "AUDIT_ERROR",
      },
    ],
    selectedSession: {
      id: "session-1",
      path: "/tmp/ws/session.jsonl",
      cwd: "/tmp/ws",
      entries: [
        {
          id: "user",
          type: "message",
          timestamp: "2026-10-16T00:00:00Z",
          message: { role: "user", content: "AUDIT_ERROR" },
        },
      ],
      bytes: 0,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2 * 1024 * 1024,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
    },
  };
}

function runtimeEvent(
  sequence: number,
  type: string,
  detail?: Record<string, unknown>,
): WebEvent {
  return {
    protocolVersion: 1,
    sequence,
    type,
    timestamp: "2026-10-16T00:00:00Z",
    ...(detail ? { detail } : {}),
  };
}

function eventStreamHarness() {
  let active: EventStreamOptions | null = null;
  const consumeEvents = vi.fn((options: EventStreamOptions) => {
    active = options;
    options.onConnected();
    return new Promise<void>((resolve) => {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  return {
    consumeEvents,
    emit(event: WebEvent) {
      if (!active) throw new Error("Event stream is not connected");
      active.onEvent(event);
    },
  };
}

function IdleComposer({ store }: { store: ReturnType<typeof createWebStore> }) {
  const state = useStore(store);
  return createElement(Composer, {
    snapshot: state.snapshot,
    selectedPath: state.selectedPath,
    selectedWorkspace: state.selectedWorkspace,
    sessionSwitching: state.sessionSwitching,
    promptAdmissionPending: state.promptAdmissionPending,
    liveRunning: state.liveRunning,
    landing: false,
    activeTurn: state.activeTurn,
    turnCancellationPending: state.turnCancellationPending,
    turnTerminalStatus: state.turnTerminalStatus,
    turnFailure: state.turnFailure,
    pendingFollowUpsReceipt: state.pendingFollowUpsReceipt,
    thinkingPendingLevel: state.thinkingPendingLevel,
    actions: state.actions,
  });
}

function composerDock(container: HTMLElement) {
  const dock = container.querySelector(".composer-dock");
  if (!(dock instanceof HTMLElement)) throw new Error("composer dock missing");
  return within(dock);
}

it("keeps a provider or rate-limit failure visible after the run returns to idle until the user dismisses it", async () => {
  const client = new WebClient();
  const idle = snapshot();
  vi.spyOn(client, "snapshot").mockResolvedValue(idle);
  const stream = eventStreamHarness();
  const store = createWebStore(client, { consumeEvents: stream.consumeEvents });
  const turn = {
    sessionId: "session-1",
    sessionPath: "/tmp/ws/session.jsonl",
    commandId: "rate-limit",
    epoch: 1,
  };
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(IdleComposer, { store }),
    ),
  );
  try {
    await act(async () => {
      await store.getState().actions.refreshSnapshot();
    });
    store.getState().actions.start();
    act(() => {
      stream.emit(runtimeEvent(5, "turn_started", turn));
      stream.emit(
        runtimeEvent(6, "message_end", {
          messageKey: "assistant-error",
          message: {
            role: "assistant",
            content: "partial answer",
            stopReason: "error",
            errorMessage: "temporary 502",
          },
        }),
      );
      stream.emit(
        runtimeEvent(7, "auto_retry_start", {
          ...turn,
          attempt: 1,
          maxAttempts: 2,
        }),
      );
      stream.emit(
        runtimeEvent(8, "auto_retry_end", {
          ...turn,
          attempt: 2,
          success: false,
          finalError: "429 rate limit exhausted",
        }),
      );
    });
    expect(store.getState().livePhase).toBe("running");
    expect(store.getState().turnFailure).toBeNull();
    expect(composerDock(view.container).queryByRole("alert")).toBeNull();

    act(() => {
      stream.emit(
        runtimeEvent(9, "turn_settled", { ...turn, outcome: "failed" }),
      );
    });
    store.getState().actions.stop();

    expect(store.getState().livePhase).toBe("idle");
    expect(store.getState().turnTerminalStatus).toBe("failed");
    expect(store.getState().notice).toBeNull();
    expect(store.getState().liveMessages[0]?.message.content).toBe(
      "partial answer",
    );
    const input = view.container.querySelector("textarea");
    expect(input?.disabled).toBe(false);
    const failure = composerDock(view.container).getByRole("alert");
    expect(failure.textContent).toContain(i18n.t("modelRequestFailed"));
    expect(failure.textContent).toContain("429 rate limit exhausted");
    expect(failure.textContent).not.toContain("temporary 502");
    expect(failure.hidden).toBe(false);

    await act(async () => {
      await store.getState().actions.refreshSnapshot();
    });
    expect(store.getState().livePhase).toBe("idle");
    expect(
      composerDock(view.container).getByRole("alert").textContent,
    ).toContain("429 rate limit exhausted");

    fireEvent.click(
      composerDock(view.container).getByRole("button", {
        name: i18n.t("close"),
      }),
    );
    expect(composerDock(view.container).queryByRole("alert")).toBeNull();
    expect(store.getState().turnFailure).toBeNull();

    store.getState().actions.start();
    act(() => {
      stream.emit(
        runtimeEvent(10, "turn_started", {
          ...turn,
          commandId: "recovered",
          epoch: 2,
        }),
      );
      stream.emit(
        runtimeEvent(11, "message_end", {
          messageKey: "assistant-ok",
          message: {
            role: "assistant",
            content: "Recovered answer",
            stopReason: "stop",
          },
        }),
      );
      stream.emit(
        runtimeEvent(12, "turn_settled", {
          ...turn,
          commandId: "recovered",
          epoch: 2,
          outcome: "completed",
        }),
      );
    });
    store.getState().actions.stop();
    expect(store.getState().turnTerminalStatus).toBe("completed");
    expect(composerDock(view.container).queryByRole("alert")).toBeNull();

    store.getState().actions.start();
    act(() => {
      stream.emit(
        runtimeEvent(13, "turn_started", {
          ...turn,
          commandId: "provider",
          epoch: 3,
        }),
      );
      stream.emit(
        runtimeEvent(14, "message_end", {
          messageKey: "assistant-provider",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "AUDIT_PROVIDER_ERROR",
          },
        }),
      );
      stream.emit(
        runtimeEvent(15, "turn_settled", {
          ...turn,
          commandId: "provider",
          epoch: 3,
          outcome: "failed",
        }),
      );
    });
    store.getState().actions.stop();
    expect(store.getState().livePhase).toBe("idle");
    expect(
      composerDock(view.container).getByRole("alert").textContent,
    ).toContain("AUDIT_PROVIDER_ERROR");

    store.getState().actions.start();
    act(() => {
      stream.emit(
        runtimeEvent(16, "turn_started", {
          ...turn,
          commandId: "next",
          epoch: 4,
        }),
      );
    });
    store.getState().actions.stop();
    expect(store.getState().livePhase).toBe("running");
    expect(store.getState().turnFailure).toBeNull();
    expect(composerDock(view.container).queryByRole("alert")).toBeNull();
  } finally {
    view.unmount();
    store.getState().actions.stop();
  }
});
