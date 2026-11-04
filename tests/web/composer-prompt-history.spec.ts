// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import * as draftStorageModule from "../../web/ui/src/features/composer/composer-draft-storage.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

type Props = ComponentProps<typeof Composer>;
type Entry = NonNullable<WebSnapshot["selectedSession"]>["entries"][number];

beforeEach(() => {
  const drafts = new Map<string, unknown>();
  vi.spyOn(
    draftStorageModule,
    "createBrowserComposerDraftStorage",
  ).mockReturnValue({
    async read() {
      return Array.from(drafts, ([key, draft]) => ({ key, draft }));
    },
    async write(changes) {
      for (const { key, draft } of changes) {
        if (draft) drafts.set(key, structuredClone(draft));
        else drafts.delete(key);
      }
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let entryId = 0;
function userEntry(content: string, extra: Partial<Entry["message"]> = {}) {
  return {
    id: `entry-${++entryId}`,
    type: "message",
    timestamp: "2026-10-31T00:00:00Z",
    message: { role: "user", content, ...extra },
  } as Entry;
}
function assistantEntry(content: string) {
  return {
    id: `entry-${++entryId}`,
    type: "message",
    timestamp: "2026-10-31T00:00:00Z",
    message: { role: "assistant", content },
  } as Entry;
}

function snapshot(
  entries: Entry[],
  id = "A",
  path = "/workspace/a.jsonl",
): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-10-31T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: id,
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        name: id,
        modified: "",
        created: "",
        messageCount: entries.length,
        firstMessage: "",
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/workspace",
      entries,
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 1,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 1,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

function setup(entries: Entry[], overrides: Partial<Props> = {}) {
  const store = createWebStore();
  const sendPrompt = vi.fn(async (_content: string) => true);
  let props: Props = {
    snapshot: snapshot(entries),
    selectedPath: "/workspace/a.jsonl",
    selectedWorkspace: "/workspace",
    workspaceDraft: false,
    createdSession: null,
    sessionSwitching: false,
    promptAdmissionPending: false,
    thinkingPendingLevel: null,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    actions: { ...store.getState().actions, sendPrompt },
    ...overrides,
  };
  const node = () =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, props));
  const view = render(node());
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  return {
    input,
    sendPrompt,
    update(patch: Partial<Props>) {
      props = { ...props, ...patch };
      view.rerender(node());
    },
  };
}

const press = (
  input: HTMLTextAreaElement,
  key: "ArrowUp" | "ArrowDown",
  init: Partial<KeyboardEventInit> = {},
) => fireEvent.keyDown(input, { key, ...init });

const type = (input: HTMLTextAreaElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
};

const history = () => [
  userEntry("first question"),
  assistantEntry("first answer"),
  userEntry("second question"),
  assistantEntry("second answer"),
  userEntry("second question"),
  userEntry("latest question"),
];

const truncatedPrompt = () =>
  userEntry(`${"长".repeat(12_000)}\n[truncated]`, {
    truncation: { truncated: true, text: true, visibleText: true },
  });

it("Up recalls earlier prompts newest first and Down returns to the draft", () => {
  const { input } = setup(history());
  type(input, "");
  press(input, "ArrowUp");
  expect(input.value).toBe("latest question");
  press(input, "ArrowUp");
  // A consecutive repeat counts once, like Pi's TUI.
  expect(input.value).toBe("second question");
  press(input, "ArrowUp");
  expect(input.value).toBe("first question");
  press(input, "ArrowUp");
  expect(input.value).toBe("first question");

  input.setSelectionRange(input.value.length, input.value.length);
  press(input, "ArrowDown");
  expect(input.value).toBe("second question");
  press(input, "ArrowDown");
  expect(input.value).toBe("latest question");
  press(input, "ArrowDown");
  expect(input.value).toBe("");
});

it("Up keeps the unsent draft and restores it after browsing", () => {
  const { input } = setup(history());
  type(input, "half written");
  input.setSelectionRange(0, 0);
  press(input, "ArrowUp");
  expect(input.value).toBe("latest question");
  input.setSelectionRange(input.value.length, input.value.length);
  press(input, "ArrowDown");
  expect(input.value).toBe("half written");
});

it("modified keys and IME composition never recall history", () => {
  const { input } = setup(history());
  type(input, "");
  for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) {
    press(input, "ArrowUp", { [modifier]: true });
    expect(input.value).toBe("");
  }
  press(input, "ArrowUp", { isComposing: true });
  expect(input.value).toBe("");
  press(input, "ArrowUp", { keyCode: 229 });
  expect(input.value).toBe("");
});

it("the slash command menu keeps Up and Down for command selection", () => {
  const { input } = setup(history(), {
    commandDiscovery: {
      sessionId: "A",
      status: "ready",
      commands: [
        {
          name: "plan",
          description: "Plan",
          source: "extension",
          availability: "available",
        },
        {
          name: "plugins",
          description: "Plugins",
          source: "extension",
          availability: "available",
        },
      ],
      totalAvailable: 2,
      commandsOmitted: 0,
      error: null,
    } as NonNullable<Props["commandDiscovery"]>,
  });
  fireEvent.focus(input);
  type(input, "/p");
  press(input, "ArrowDown");
  press(input, "ArrowUp");
  expect(input.value).toBe("/p");
});

it("editing a recalled prompt sends the edit and leaves history unchanged", async () => {
  const { input, sendPrompt } = setup(history());
  type(input, "");
  press(input, "ArrowUp");
  expect(input.value).toBe("latest question");
  type(input, "latest question, but shorter");
  // Editing ends browsing; Down no longer walks history.
  press(input, "ArrowDown");
  expect(input.value).toBe("latest question, but shorter");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
  expect(sendPrompt.mock.calls[0]?.[0]).toBe("latest question, but shorter");
});

it("a recalled truncated prompt is filled with its complete native text", async () => {
  const full = `${"长".repeat(12_000)}的结尾`;
  const sessionItem = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockImplementation(async (_id, _path, entryId, cursor) =>
      cursor === 0
        ? {
            entryId,
            text: full.slice(0, 6_000),
            nextCursor: 6_000,
            totalChars: full.length,
          }
        : {
            entryId,
            text: full.slice(6_000),
            nextCursor: null,
            totalChars: full.length,
          },
    );
  const { input } = setup([userEntry("short one"), truncatedPrompt()]);
  type(input, "");
  press(input, "ArrowUp");
  // Never place the shortened preview as if it were the original prompt.
  expect(input.value).toBe("");
  await waitFor(() => expect(input.value).toBe(full));
  expect(sessionItem).toHaveBeenCalledTimes(2);
});

it("a failed full-text load recalls nothing and the next Up tries again", async () => {
  const full = `${"长".repeat(12_000)}的结尾`;
  const sessionItem = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (_id, _path, entryId) => ({
      entryId,
      text: full,
      nextCursor: null,
      totalChars: full.length,
    }));
  const { input } = setup([truncatedPrompt()]);
  type(input, "");
  press(input, "ArrowUp");
  await waitFor(() => expect(sessionItem).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(input.value).toBe("");

  press(input, "ArrowUp");
  await waitFor(() => expect(input.value).toBe(full));
  expect(sessionItem).toHaveBeenCalledTimes(2);
});

it("a pending full-text load does not swallow caret movement", async () => {
  const full = `${"长".repeat(12_000)}的结尾`;
  let finish = () => {};
  vi.spyOn(WebClient.prototype, "sessionItem").mockImplementation(
    (_id, _path, entryId) =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            entryId,
            text: full,
            nextCursor: null,
            totalChars: full.length,
          });
      }),
  );
  const { input } = setup([truncatedPrompt()]);
  type(input, "line one\nline two");
  input.setSelectionRange(0, 0);
  press(input, "ArrowUp");
  expect(input.value).toBe("line one\nline two");

  // Off the first line, Up is ordinary caret movement and is not prevented.
  input.setSelectionRange(input.value.length, input.value.length);
  expect(press(input, "ArrowUp")).toBe(true);
  expect(press(input, "ArrowDown")).toBe(true);
  // A history key still waits for the load in flight.
  input.setSelectionRange(0, 0);
  expect(press(input, "ArrowUp")).toBe(false);

  await act(async () => finish());
  await waitFor(() => expect(input.value).toBe(full));
});

it("history follows the selected session", () => {
  const view = setup([userEntry("from session A")]);
  type(view.input, "");
  view.input.setSelectionRange(0, 0);
  view.update({
    snapshot: snapshot(
      [userEntry("from session B")],
      "B",
      "/workspace/b.jsonl",
    ),
    selectedPath: "/workspace/b.jsonl",
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  type(input, "");
  press(input, "ArrowUp");
  expect(input.value).toBe("from session B");
});
