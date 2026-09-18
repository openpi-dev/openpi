// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(cleanup);

function snapshot(
  id = "session-1",
  path = "/tmp/workspace/one.jsonl",
): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-18T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: id,
    workspaces: [{ path: "/tmp/workspace", name: "Workspace", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/tmp/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        name: id === "session-1" ? "First task" : "Second task",
        modified: "2026-09-18T00:00:00Z",
        created: "2026-09-18T00:00:00Z",
        messageCount: 0,
        firstMessage: "",
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/tmp/workspace",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2 * 1024 * 1024,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const store = createWebStore();
  const sendPrompt = vi.fn(async (_content: string) => true);
  const discoverCommands = vi.fn(async () => {});
  const props = {
    snapshot: snapshot(),
    selectedPath: "/tmp/workspace/one.jsonl",
    selectedWorkspace: "/tmp/workspace",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPrompt, discoverCommands },
    ...overrides,
  };
  const node = (next = props) =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, next));
  const view = render(node());
  return { ...view, node, props, sendPrompt, discoverCommands };
}

it("shows the snapshot target and only an authorized command action", async () => {
  const { discoverCommands, sendPrompt } = setup();
  expect(screen.getByText("First task")).toBeTruthy();
  expect(screen.getByText("Workspace")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("commands") }));
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  expect(
    screen.getByRole("menuitem", { name: i18n.t("commands") }),
  ).toBeTruthy();
  expect(screen.queryByText(/attachment|upload|file reference/iu)).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("commands") }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.value).toBe("/");
  expect(input.selectionStart).toBe(1);
  expect(discoverCommands).toHaveBeenCalledOnce();
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(document.activeElement).toBe(input);
});

it("keeps a nonempty draft and its exact text-only prompt contract", async () => {
  const { sendPrompt } = setup();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "  Review this\ncarefully  " } });
  expect(screen.queryByRole("button", { name: i18n.t("commands") })).toBeNull();
  fireEvent(
    input,
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    }),
  );
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).toHaveBeenCalledWith("  Review this\ncarefully  ");
  await waitFor(() => expect(input.value).toBe(""));
});

it("does not submit with Enter while a model choice is unconfirmed", () => {
  const { sendPrompt } = setup({ modelSelectionPending: true });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "keep me" } });
  expect(screen.getByText(i18n.t("thinkingModelPendingHint"))).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(input.value).toBe("keep me");
});

it("does not transfer a settled submission into a different session", async () => {
  let resolve!: (accepted: boolean) => void;
  const receipt = new Promise<boolean>((done) => {
    resolve = done;
  });
  const sendPrompt = vi.fn(() => receipt);
  const { node, props, rerender } = setup({
    actions: { ...createWebStore().getState().actions, sendPrompt },
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "old draft" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).toHaveBeenCalledWith("old draft");

  rerender(
    node({
      ...props,
      snapshot: snapshot("session-2", "/tmp/workspace/two.jsonl"),
      selectedPath: "/tmp/workspace/two.jsonl",
    }),
  );
  expect(screen.getByText("Second task")).toBeTruthy();
  fireEvent.change(input, { target: { value: "new draft" } });
  await act(async () => {
    resolve(true);
    await receipt;
  });
  expect(input.value).toBe("new draft");
});
