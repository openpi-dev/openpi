// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { projectEntry, type WebSnapshot } from "../../web/protocol/types.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => vi.restoreAllMocks());
const anchor = {
  sessionId: "session-a",
  sessionPath: "/project/a.jsonl",
  entryId: "old-entry",
};
function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-30T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: anchor.sessionId,
    currentSessionPath: anchor.sessionPath,
    workspaces: [],
    sessions: [
      {
        id: anchor.sessionId,
        path: anchor.sessionPath,
        cwd: "/project",
        created: "2026-09-30T00:00:00Z",
        modified: "2026-09-30T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 400,
        firstMessage: "first",
      },
    ],
    selectedSession: {
      id: anchor.sessionId,
      path: anchor.sessionPath,
      cwd: "/project",
      entries: [],
      bytes: 2,
      truncation: {
        truncated: true,
        entriesOmitted: 400,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2 * 1024 * 1024,
      },
      history: { leafEntryId: "newest", beforeEntryId: null },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      bytes: 0,
      maxBytes: 4 * 1024 * 1024,
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
    },
  };
}
function window(entryId = anchor.entryId) {
  return {
    ...snapshot().selectedSession!,
    entries: [
      projectEntry({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: "2026-09-30T00:00:00Z",
        message: { role: "user", content: "older message", timestamp: 1 },
      }),
    ],
    history: {
      leafEntryId: "newest",
      beforeEntryId: null,
      anchorEntryId: entryId,
      anchorOnBranch: true,
    },
  };
}
function mount() {
  const client = new WebClient();
  const store = createWebStore(client);
  store.setState({ snapshot: snapshot(), selectedPath: anchor.sessionPath });
  return { client, store };
}

it("publishes an older exact message window and increments repeated navigation", async () => {
  const { client, store } = mount();
  const locate = vi
    .spyOn(client, "sessionMessageWindow")
    .mockResolvedValue(window());
  const prompt = vi.spyOn(client, "prompt");
  expect(await store.getState().actions.navigateToMessage(anchor)).toBe(true);
  expect(store.getState().historyNavigation?.session.entries[0]?.id).toBe(
    anchor.entryId,
  );
  expect(store.getState().historyNavigation?.revision).toBe(1);
  expect(await store.getState().actions.navigateToMessage(anchor)).toBe(true);
  expect(store.getState().historyNavigation?.revision).toBe(2);
  expect(locate).toHaveBeenCalledWith(anchor, undefined);
  expect(prompt).not.toHaveBeenCalled();
});

it("rejects copied identity and stale branch evidence", async () => {
  const { client, store } = mount();
  const locate = vi.spyOn(client, "sessionMessageWindow");
  locate.mockResolvedValue({ ...window(), path: "/project/copy.jsonl" });
  expect(await store.getState().actions.navigateToMessage(anchor)).toBe(false);
  locate.mockResolvedValue({
    ...window(),
    history: { ...window().history, anchorOnBranch: false },
  });
  expect(await store.getState().actions.navigateToMessage(anchor)).toBe(false);
  expect(store.getState().historyNavigation).toBeNull();
});

it("does not navigate a late response over a newer workspace selection", async () => {
  const { client, store } = mount();
  let resolve!: (value: ReturnType<typeof window>) => void;
  vi.spyOn(client, "sessionMessageWindow").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = store.getState().actions.navigateToMessage(anchor);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  store.getState().actions.setWorkspace("/other");
  resolve(window());
  expect(await pending).toBe(false);
  expect(store.getState().historyNavigation).toBeNull();
});

it("keeps the newer message when two reads in the same Session resolve out of order", async () => {
  const { client, store } = mount();
  let resolveFirst!: (value: ReturnType<typeof window>) => void;
  const locate = vi
    .spyOn(client, "sessionMessageWindow")
    .mockReturnValueOnce(
      new Promise((done) => {
        resolveFirst = done;
      }),
    )
    .mockResolvedValueOnce(window("newer-entry"));
  const first = store.getState().actions.navigateToMessage(anchor);
  await vi.waitFor(() => expect(locate).toHaveBeenCalledOnce());
  const newer = { ...anchor, entryId: "newer-entry" };
  expect(await store.getState().actions.navigateToMessage(newer)).toBe(true);
  resolveFirst(window());
  expect(await first).toBe(false);
  expect(store.getState().historyNavigation).toMatchObject({
    ...newer,
    revision: 1,
    session: { entries: [{ id: "newer-entry" }] },
  });
});

it("keeps current navigation and feedback when an obsolete message read fails", async () => {
  const { client, store } = mount();
  let rejectFirst!: (reason: Error) => void;
  const locate = vi
    .spyOn(client, "sessionMessageWindow")
    .mockReturnValueOnce(
      new Promise((_done, reject) => {
        rejectFirst = reject;
      }),
    )
    .mockResolvedValueOnce(window("newer-entry"));
  const first = store.getState().actions.navigateToMessage(anchor);
  await vi.waitFor(() => expect(locate).toHaveBeenCalledOnce());
  const newer = { ...anchor, entryId: "newer-entry" };
  expect(await store.getState().actions.navigateToMessage(newer)).toBe(true);
  store.setState({ notice: "Current request feedback" });
  rejectFirst(new Error("Old read failed"));
  expect(await first).toBe(false);
  expect(store.getState().historyNavigation?.entryId).toBe(newer.entryId);
  expect(store.getState().notice).toBe("Current request feedback");
});
