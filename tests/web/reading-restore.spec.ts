// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  jsonByteLength,
  type WebSessionProjection,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import {
  createSessionReadingCache,
  READING_POSITION_STORAGE_KEY,
  rememberSessionReading,
  sessionReadingScope,
} from "../../web/ui/src/features/transcript/session-reading-state.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { webStore } from "../../web/ui/src/store/web-store.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();

const originalState = webStore.getState();
const scope = sessionReadingScope({ id: "s", path: "/sessions/s.jsonl" });
const position = {
  key: "e10",
  entryId: "e10",
  offset: -12,
  scrollTop: 1800,
  pinned: false,
};
const truncation = {
  entriesOmitted: 70,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  maxBytes: 2 * 1024 * 1024,
  truncated: true,
};

function session(from = 70, through = 79): WebSessionProjection {
  const entries = Array.from({ length: through - from + 1 }, (_, offset) => ({
    type: "message" as const,
    id: `e${from + offset}`,
    parentId: `e${from + offset - 1}`,
    timestamp: "2026-10-02T00:00:00Z",
    message: {
      role: (from + offset) % 2 === 0 ? "user" : "assistant",
      content: `Message ${from + offset}`,
      stopReason: "stop" as const,
    },
  }));
  return {
    id: "s",
    path: "/sessions/s.jsonl",
    cwd: "/workspace",
    entries,
    bytes: jsonByteLength(entries),
    truncation,
    history: { leafEntryId: "e79", beforeEntryId: `e${from}` },
  };
}

function snapshot(selectedSession = session()): WebSnapshot {
  return {
    protocolVersion: 1,
    cursor: 1,
    generatedAt: "2026-10-02T00:00:00Z",
    preferences: { theme: "light" },
    currentSessionId: "s",
    currentSessionPath: "/sessions/s.jsonl",
    selectedSession,
    sessions: [],
    workspaces: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      ...truncation,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

function restoredSession() {
  const restored = session(8, 11);
  restored.history = {
    ...restored.history!,
    anchorEntryId: "e10",
    anchorOnBranch: true,
  };
  return restored;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function show(strict = false) {
  const app = createElement(Providers, null, createElement(App));
  return render(strict ? createElement(StrictMode, null, app) : app);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  window.localStorage.clear();
  window.localStorage.setItem(
    READING_POSITION_STORAGE_KEY,
    JSON.stringify([[scope, position]]),
  );
  vi.spyOn(originalState.actions, "start").mockImplementation(() => {});
  vi.spyOn(originalState.actions, "stop").mockImplementation(() => {});
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: null,
  });
  vi.spyOn(WebClient.prototype, "sessionHistory").mockImplementation(
    () => new Promise(() => {}),
  );
  vi.spyOn(WebClient.prototype, "sessionPromptHistory").mockImplementation(
    () => new Promise(() => {}),
  );
  webStore.setState(
    {
      ...originalState,
      snapshot: snapshot(),
      selectedPath: "/sessions/s.jsonl",
      selectedWorkspace: "/workspace",
      connection: "connected",
      workspaceDraft: false,
      sessionSwitching: false,
      historyNavigation: null,
    },
    true,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  webStore.setState(originalState, true);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it("persists only four exact Session bookmarks, never native messages or history windows", () => {
  const cache = createSessionReadingCache();
  for (let index = 0; index < 5; index++) {
    const selected = {
      ...session(),
      id: `s${index}`,
      path: `/sessions/s${index}.jsonl`,
    };
    rememberSessionReading(cache, sessionReadingScope(selected), {
      window: { session: selected, anchor: "e79", validatedLeaf: "e79" },
      position,
    });
  }
  const stored = window.localStorage.getItem(READING_POSITION_STORAGE_KEY)!;
  expect(stored).not.toContain("Message");
  expect(stored).not.toContain("window");
  expect(JSON.parse(stored)).toHaveLength(4);
  const restored = createSessionReadingCache();
  expect(restored.size).toBe(4);
  expect(
    restored.has(sessionReadingScope({ id: "s0", path: "/sessions/s0.jsonl" })),
  ).toBe(false);
  expect(
    restored.get(sessionReadingScope({ id: "s4", path: "/sessions/s4.jsonl" }))
      ?.position,
  ).toEqual(position);
  expect(
    restored.has(
      sessionReadingScope({ id: "s4", path: "/sessions/copy.jsonl" }),
    ),
  ).toBe(false);
});

it("isolates malformed storage records and rejects excessive or private position fields", () => {
  window.localStorage.setItem(
    READING_POSITION_STORAGE_KEY,
    JSON.stringify([
      ["malformed scope", position],
      [
        scope,
        {
          ...position,
          transcript: "private message",
          entryId: "e10",
          window: { private: true },
        },
      ],
      [
        sessionReadingScope({ id: "other", path: "/other" }),
        { ...position, offset: 1_000_001 },
      ],
    ]),
  );
  const cache = createSessionReadingCache();
  expect([...cache]).toEqual([[scope, { position }]]);
  cache.persist?.();
  expect(
    window.localStorage.getItem(READING_POSITION_STORAGE_KEY),
  ).not.toContain("private");
  window.localStorage.setItem(READING_POSITION_STORAGE_KEY, " ".repeat(32_769));
  expect(createSessionReadingCache().size).toBe(0);
});

it("retries a StrictMode-aborted read and restores only the exact native Session window", async () => {
  const first = deferred<WebSessionProjection>();
  const second = deferred<WebSessionProjection>();
  const read = vi
    .spyOn(WebClient.prototype, "sessionMessageWindow")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  show(true);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[0]![1]?.aborted).toBe(true);
  expect(read.mock.calls[1]![0]).toEqual({
    sessionId: "s",
    sessionPath: "/sessions/s.jsonl",
    entryId: "e10",
  });
  expect(createSessionReadingCache().get(scope)?.position).toEqual(position);
  await act(async () => {
    first.resolve(restoredSession());
  });
  expect(screen.queryByText("Message 10")).toBeNull();
  await act(async () => {
    second.resolve(restoredSession());
  });
  expect(screen.getByText("Message 10")).toBeTruthy();
  expect(document.activeElement?.closest(".message-row")).toBeNull();
});

it("waits for connection and leaves an old bookmark intact on temporary read failures", async () => {
  webStore.setState({ connection: "connecting" });
  const read = vi
    .spyOn(WebClient.prototype, "sessionMessageWindow")
    .mockRejectedValue(new Error("temporarily unavailable"));
  const view = show();
  expect(read).not.toHaveBeenCalled();
  await act(async () => {
    webStore.setState({ connection: "connected" });
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  fireEvent(window, new Event("pagehide"));
  view.unmount();
  expect(createSessionReadingCache().get(scope)?.position).toEqual(position);
});

it("lets manual reading cancel an in-flight restoration and ignores its late result", async () => {
  const pending = deferred<WebSessionProjection>();
  const read = vi
    .spyOn(WebClient.prototype, "sessionMessageWindow")
    .mockImplementation(() => pending.promise);
  const view = show();
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  const conversation =
    view.container.querySelector<HTMLElement>(".conversation")!;
  fireEvent.wheel(conversation, { deltaY: -400 });
  expect(read.mock.calls[0]![1]?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(restoredSession());
  });
  expect(screen.queryByText("Message 10")).toBeNull();
  expect(screen.getByText("Message 78")).toBeTruthy();
});

it("ignores a copied Session or unverified native anchor without destroying the bookmark", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionMessageWindow")
    .mockResolvedValue({ ...restoredSession(), path: "/sessions/copy.jsonl" });
  const view = show();
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(screen.queryByText("Message 10")).toBeNull();
  view.unmount();
  expect(createSessionReadingCache().get(scope)?.position).toEqual(position);
  read.mockResolvedValue({
    ...restoredSession(),
    history: {
      leafEntryId: "e79",
      anchorEntryId: "e9",
      anchorOnBranch: true,
      beforeEntryId: "e8",
    },
  });
  show();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Message 10")).toBeNull();
  expect(createSessionReadingCache().get(scope)?.position).toEqual(position);
});
