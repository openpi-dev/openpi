// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSubagentDetail } from "../../extensions/shared/web-observer-registry.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import type { WorkbarTool } from "../../web/ui/src/features/workbar/types.ts";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("pauses side-conversation polling across hidden panels and inactive tabs, then resumes on return", async () => {
  vi.useFakeTimers();
  const detail: WebSubagentDetail = {
    kind: "subagents",
    id: "side-1",
    title: "Side question",
    status: "running",
    origin: "btw",
    createdAt: 1,
    cwd: "/workspace",
    prompt: "Inspect this",
    transcript: [],
    liveTools: [],
    finalText: "",
    truncated: false,
    omittedEntries: 0,
  };
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockResolvedValue({ sessionId: "session-a", detail });
  const changes = vi.fn();
  const node = (
    visible: boolean,
    requestedTool: WorkbarTool,
    requestRevision: number,
  ) =>
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible,
        requestedTool,
        requestRevision,
        sessionId: "session-a",
        cwd: "/workspace",
        capabilities: {
          subagents: { items: [detail], truncated: false, omitted: 0 },
        },
        messages: [],
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onBeforeArtifactOpen: () => {},
        onClose: () => {},
        onActiveToolChange: changes,
      }),
    );
  const view = render(node(true, "side-conversation", 0));
  fireEvent.click(screen.getByRole("button", { name: /Side question/u }));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender(node(false, "side-conversation", 0));
  expect(read.mock.calls[1]![2].aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).toHaveBeenCalledTimes(2);
  expect(changes).toHaveBeenLastCalledWith(null);
  view.rerender(node(true, "side-conversation", 0));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(3);
  expect(changes).toHaveBeenLastCalledWith("side-conversation");
  view.rerender(node(true, "files", 1));
  expect(read.mock.calls[2]![2].aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).toHaveBeenCalledTimes(3);
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("sideConversation"),
    }),
  );
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(4);
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("sideConversation")}`,
    }),
  );
  expect(read.mock.calls[3]![2].aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(changes).toHaveBeenLastCalledWith(null);
});
