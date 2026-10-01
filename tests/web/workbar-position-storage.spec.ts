// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadWorkbarPositions,
  saveWorkbarPositions,
  WORKBAR_POSITION_STORAGE_KEY,
  type WorkbarWorkspace,
} from "../../web/ui/src/features/workbar/workbar-position-storage.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function position(
  sessionId = "session-a",
  sessionPath = "/workspace/a.jsonl",
): WorkbarWorkspace {
  return {
    sessionId,
    sessionPath,
    tool: "terminal",
    requestRevision: 3,
    open: true,
    reading: {
      tabs: {
        tabs: ["files", "terminal", "terminal:second", "browser", "review"],
        active: "terminal:second",
        launcherOpen: false,
        activationHistory: ["files", "terminal", "terminal:second"],
      },
      requestRevision: 3,
      files: {
        selected: "report.pdf",
        treeVisible: true,
        query: "report",
        expanded: ["docs"],
        treeScroll: 140,
      },
      artifact: {
        reference: "report.pdf",
        source: false,
        editing: true,
        scroll: 900,
        document: {
          path: "report.pdf",
          revision: "a".repeat(64),
          page: 12,
          scale: 1.5,
        },
      },
      review: {
        scope: "workspace:unstaged",
        source: "unstaged",
        selected: "src/file.ts",
        query: "src",
        collapsedDirectories: [],
        visibleFiles: 50,
        listScroll: 240,
        previewScroll: 570,
        viewed: { revision: "b".repeat(64), paths: ["src/file.ts"] },
      },
      terminals: {
        terminal: {
          id: "native-a",
          title: "Dev server",
          viewport: 15,
          atBottom: false,
        },
        "terminal:second": {
          id: "native-b",
          title: "Tests",
          viewport: 0,
          atBottom: true,
        },
      },
      browser: {
        tabs: [
          {
            id: 0,
            title: "Documentation",
            initialUrl: "https://example.com/docs",
          },
        ],
        selected: 0,
        pages: {
          0: {
            draft: "https://example.com/guide",
            history: ["https://example.com/docs", "https://example.com/guide"],
            index: 1,
          },
        },
      },
      sideConversation: {
        selectedId: "btw-a",
        drafts: { "btw-a": "PRIVATE SIDE DRAFT" },
      },
    },
    reviewTurn: {
      promptEntryId: "turn-a",
      filePath: "src/file.ts",
      revision: 2,
    },
  };
}

it("persists exact Session identities and tool bookmarks, not content or live resources", () => {
  const workspace = position();
  const withPayload = {
    ...workspace,
    transcript: "PRIVATE SESSION HISTORY",
    model: { apiKey: "PRIVATE PROVIDER KEY" },
    reading: {
      ...workspace.reading,
      artifact: {
        ...workspace.reading.artifact!,
        body: "PRIVATE FILE CONTENT",
        editDraft: "PRIVATE EDIT DRAFT",
      },
      browser: {
        ...workspace.reading.browser!,
        dom: "PRIVATE IFRAME DOM",
        cookies: "PRIVATE COOKIE",
      },
      terminals: {
        ...workspace.reading.terminals,
        terminal: {
          ...workspace.reading.terminals!.terminal!,
          handle: "PRIVATE PROCESS HANDLE",
          input: "PRIVATE INPUT",
          output: "PRIVATE TERMINAL OUTPUT",
        },
      },
    },
  };
  saveWorkbarPositions([withPayload]);
  const raw = window.localStorage.getItem(WORKBAR_POSITION_STORAGE_KEY)!;
  expect(raw).not.toContain("PRIVATE");
  const [restored] = loadWorkbarPositions();
  expect(restored?.sessionId).toBe(workspace.sessionId);
  expect(restored?.sessionPath).toBe(workspace.sessionPath);
  expect(restored?.reading.files).toEqual(workspace.reading.files);
  expect(restored?.reading.artifact).toEqual({
    ...workspace.reading.artifact,
    editing: false,
  });
  expect(restored?.reading.review).toEqual(workspace.reading.review);
  expect(restored?.reading.terminals).toEqual(workspace.reading.terminals);
  expect(restored?.reading.browser).toEqual(workspace.reading.browser);
  expect(restored?.reading.sideConversation).toEqual({
    selectedId: "btw-a",
    drafts: {},
  });
  expect(restored?.reviewTurn).toEqual(workspace.reviewTurn);
});

it("keeps copied same-ID Session paths distinct and uses the final exact-identity bookmark", () => {
  const original = position();
  const copied = position(original.sessionId, "/workspace/copied.jsonl");
  const newest = { ...original, requestRevision: 9 };
  window.localStorage.setItem(
    WORKBAR_POSITION_STORAGE_KEY,
    JSON.stringify([original, copied, newest]),
  );
  const restored = loadWorkbarPositions();
  expect(restored).toHaveLength(2);
  expect(
    restored.find((item) => item.sessionPath === original.sessionPath)
      ?.requestRevision,
  ).toBe(9);
  expect(
    restored.find((item) => item.sessionPath === copied.sessionPath)
      ?.requestRevision,
  ).toBe(3);
});

it("sanitizes malformed tabs, URLs, viewport values and revisions without restoring authority", () => {
  const workspace = position();
  window.localStorage.setItem(
    WORKBAR_POSITION_STORAGE_KEY,
    JSON.stringify([
      {
        ...workspace,
        reading: {
          tabs: {
            tabs: [
              "terminal",
              "terminal",
              "terminal:second",
              "launcher",
              "unknown",
            ],
            active: "unknown",
            activationHistory: ["terminal", "terminal", "unknown"],
            launcherOpen: false,
          },
          terminals: {
            terminal: { id: "native-a", viewport: -10, atBottom: true },
            "terminal:second": {
              id: "native-b",
              title: "x".repeat(81),
              viewport: 1e15,
            },
            "terminal:closed": { id: "must-not-restore" },
            browser: { id: "wrong-kind" },
          },
          browser: {
            tabs: [
              { id: 0, title: "Same app", initialUrl: window.location.href },
              { id: 0, title: "Duplicate" },
              { id: -1 },
              {
                id: 1,
                title: "Credentials",
                initialUrl: "https://user:secret@example.com",
              },
            ],
            selected: 9,
            pages: {
              0: {
                draft: "javascript:alert(1)",
                history: [
                  window.location.href,
                  "https://user:secret@example.com",
                  "https://example.com/valid",
                ],
                index: 99,
              },
              1: { draft: "", history: [], index: 0 },
            },
          },
          artifact: {
            reference: "report.pdf",
            editing: true,
            scroll: -1,
            document: { path: "report.pdf", revision: "unverified", page: 10 },
          },
        },
      },
    ]),
  );
  const [restored] = loadWorkbarPositions();
  expect(restored?.reading.tabs).toEqual({
    tabs: ["terminal", "terminal:second"],
    active: null,
    activationHistory: ["terminal"],
    launcherOpen: true,
  });
  expect(restored?.reading.terminals).toEqual({
    terminal: { id: "native-a", viewport: 0, atBottom: true },
    "terminal:second": {
      id: "native-b",
      title: "",
      viewport: 0,
      atBottom: true,
    },
  });
  expect(restored?.reading.browser?.tabs).toEqual([
    { id: 0, title: "Same app" },
    { id: 1, title: "Credentials" },
  ]);
  expect(restored?.reading.browser?.pages[0]).toEqual({
    draft: "",
    history: ["https://example.com/valid"],
    index: 0,
  });
  expect(restored?.reading.browser?.pages[1]?.index).toBe(-1);
  expect(restored?.reading.artifact?.document).toBeUndefined();
  expect(restored?.reading.artifact?.editing).toBe(false);
});

it("bounds remembered workspaces and evicts old oversized metadata before saving fresh bookmarks", () => {
  saveWorkbarPositions(
    Array.from({ length: 40 }, (_, index) =>
      position(`session-${index}`, `/workspace/${index}.jsonl`),
    ),
  );
  expect(loadWorkbarPositions()).toHaveLength(32);
  expect(loadWorkbarPositions()[0]?.sessionId).toBe("session-8");
  const oversized = position("old", "/workspace/old.jsonl");
  oversized.reading.files!.expanded = Array.from(
    { length: 100 },
    (_, index) => `${index}-${"x".repeat(4000)}`,
  );
  saveWorkbarPositions([
    oversized,
    position("latest", "/workspace/latest.jsonl"),
  ]);
  expect(loadWorkbarPositions().map((item) => item.sessionId)).toEqual([
    "latest",
  ]);
  expect(
    window.localStorage.getItem(WORKBAR_POSITION_STORAGE_KEY)!.length,
  ).toBeLessThanOrEqual(256_000);
});

it.each(["malformed", "oversized", "unavailable"])(
  "does not block tool use when storage is %s",
  (kind) => {
    if (kind === "malformed")
      window.localStorage.setItem(WORKBAR_POSITION_STORAGE_KEY, "{");
    if (kind === "oversized")
      window.localStorage.setItem(
        WORKBAR_POSITION_STORAGE_KEY,
        "x".repeat(256_001),
      );
    if (kind === "unavailable") {
      vi.spyOn(jsdom.window.Storage.prototype, "getItem").mockImplementation(
        () => {
          throw new Error("Storage disabled");
        },
      );
      vi.spyOn(jsdom.window.Storage.prototype, "setItem").mockImplementation(
        () => {
          throw new Error("Quota exceeded");
        },
      );
    }
    expect(loadWorkbarPositions()).toEqual([]);
    expect(() => saveWorkbarPositions([position()])).not.toThrow();
    if (kind === "unavailable") {
      expect(jsdom.window.Storage.prototype.getItem).toHaveBeenCalledOnce();
      expect(jsdom.window.Storage.prototype.setItem).toHaveBeenCalledOnce();
    }
  },
);
