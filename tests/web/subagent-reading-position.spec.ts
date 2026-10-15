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
import { afterEach, expect, it, vi } from "vitest";
import type { WebSubagentDetail } from "../../extensions/shared/web-observer-registry.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import {
  SubagentDetailView,
  SubagentPanel,
} from "../../web/ui/src/features/subagents/SubagentPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function detail(id = "A", status: "running" | "done" = "done") {
  return {
    kind: "subagents",
    id,
    title: `Child ${id}`,
    status,
    createdAt: 1,
    cwd: "/workspace",
    prompt: `Task ${id}`,
    transcript: [
      {
        kind: "assistant",
        parts: [
          { type: "thinking", text: `Thinking ${id}` },
          {
            type: "toolCall",
            toolId: `tool-${id}`,
            name: "read",
            argsPreview: "source.ts",
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: `tool-${id}`,
        name: "read",
        isError: false,
        outputPreview: `Result ${id}`,
      },
    ],
    liveTools: [],
    finalText: "",
    truncated: false,
    omittedEntries: 0,
  } satisfies WebSubagentDetail;
}

function readingPosition(container: HTMLElement) {
  const viewport = container.querySelector<HTMLElement>(
    ".subagent-transcript",
  )!;
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 },
  });
  viewport.scrollTop = 150;
  fireEvent.scroll(viewport);
  const disclosures = Array.from(
    container.querySelectorAll<HTMLDetailsElement>(
      ".subagent-task, .subagent-thinking, .subagent-tool",
    ),
  );
  for (const disclosure of disclosures) disclosure.open = true;
  return { viewport, disclosures };
}

it("keeps the current child reading position across overview/back while pausing reads", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockImplementation(async (_session, id) => ({
      sessionId: "parent",
      detail: detail(id, "running"),
    }));
  const view = render(
    createElement(
      Providers,
      null,
      createElement(SubagentPanel, {
        sessionId: "parent",
        initialId: "A",
        activity: {
          items: [detail("A", "running"), detail("B", "running")],
          omitted: 0,
          truncated: false,
        },
        onClose: vi.fn(),
      }),
    ),
  );
  await act(async () => {});
  const position = readingPosition(view.container);
  const section = position.viewport.closest<HTMLElement>(".subagent-detail")!;

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("backToSubagents") }),
  );
  expect(section.hidden).toBe(true);
  expect(read.mock.calls[0]![2]!.aborted).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: /Child A/u }));
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(2);
  expect(section.hidden).toBe(false);
  expect(view.container.querySelector(".subagent-transcript")).toBe(
    position.viewport,
  );
  expect(position.viewport.scrollTop).toBe(150);
  expect(position.disclosures.every((disclosure) => disclosure.open)).toBe(
    true,
  );

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("backToSubagents") }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Child B/u }));
  await act(async () => {});
  expect(position.viewport.isConnected).toBe(false);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenLastCalledWith("parent", "B", expect.any(AbortSignal));
  expect(
    Array.from(
      view.container.querySelectorAll<HTMLDetailsElement>("details"),
    ).every((disclosure) => !disclosure.open),
  ).toBe(true);
});

it("refreshes a child after a native action without remounting its disclosures or scroll", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockImplementation(async () => ({
      sessionId: "parent",
      detail: detail(),
    }));
  const client = new WebClient();
  const node = (refreshRevision: number) =>
    createElement(
      Providers,
      null,
      createElement(SubagentDetailView, {
        sessionId: "parent",
        id: "A",
        client,
        liveAvailable: true,
        fullView: true,
        refreshRevision,
      }),
    );
  const view = render(node(0));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  await screen.findByText("Thinking A");
  const position = readingPosition(view.container);

  view.rerender(node(1));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls[0]![2]!.aborted).toBe(true);
  expect(view.container.querySelector(".subagent-transcript")).toBe(
    position.viewport,
  );
  expect(position.viewport.scrollTop).toBe(150);
  expect(position.disclosures.every((disclosure) => disclosure.open)).toBe(
    true,
  );

  read.mockRejectedValueOnce(new Error("Temporary read failure"));
  view.rerender(node(2));
  await screen.findByText("Temporary read failure");
  expect(screen.getByText(i18n.t("subagentStale"))).toBeTruthy();
  expect(position.viewport.isConnected).toBe(true);
  expect(position.disclosures.every((disclosure) => disclosure.open)).toBe(
    true,
  );
});
