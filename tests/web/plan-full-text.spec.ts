// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { projectMessage } from "../../web/protocol/types.ts";
import { FullMessageText } from "../../web/ui/src/features/transcript/FullMessageText.tsx";
import { PlanCard } from "../../web/ui/src/features/transcript/PlanCard.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { copyText } from "../../web/ui/src/lib/clipboard.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

vi.mock("../../web/ui/src/lib/clipboard.ts", () => ({
  copyText: vi.fn(async () => true),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const completePlan = `# Native valid plan\n${"Step. ".repeat(6000)}\nEND OF PLAN`;
const result = projectMessage({
  role: "toolResult",
  toolName: "plan_ready",
  toolCallId: "plan-call",
  isError: false,
  content: [
    {
      type: "text",
      text: `Plan ready for explicit user action. No implementation has started.\n\n${completePlan}`,
    },
  ],
  details: { status: "ready", plan: completePlan },
});

function card(entryId: string | null = "native-result", path = "/tmp/session") {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(PlanCard, {
      result,
      sessionId: "session",
      sessionPath: path,
      entryId: entryId ?? undefined,
    }),
  );
}

it("recovers only the native plan receipt in explicit pages and copies the full plan only after completion", async () => {
  const split = 20_000;
  const read = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: completePlan.slice(0, split),
      nextCursor: split,
      totalChars: completePlan.length,
      planStatus: "ready",
    })
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: completePlan.slice(split),
      nextCursor: null,
      totalChars: completePlan.length,
      planStatus: "ready",
    });
  const view = render(card());
  expect(result.truncation?.details).toBe(true);
  expect(view.container.textContent).not.toContain("END OF PLAN");
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(result.content);
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  expect(read).toHaveBeenNthCalledWith(
    1,
    "session",
    "/tmp/session",
    "native-result",
    0,
    expect.any(AbortSignal),
    "plan",
  );
  expect(screen.queryByText(i18n.t("planCardReady"))).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(completePlan.slice(0, split));
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(i18n.t("planCardResult")) }),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("messageLoadMore") }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(i18n.t("planCardResult")) }),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("messageLoadMore") }),
    ),
  );
  expect(read).toHaveBeenNthCalledWith(
    2,
    "session",
    "/tmp/session",
    "native-result",
    split,
    expect.any(AbortSignal),
    "plan",
  );
  expect(view.container.textContent).toContain("END OF PLAN");
  expect(screen.getByText(i18n.t("planCardReady"))).toBeTruthy();
  expect(screen.getByText(i18n.t("planCardNotApproval"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("planCardTruncated"))).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopy") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(completePlan);
  expect(read).toHaveBeenCalledTimes(2);
});

it("leaves live receipts without a native entry as previews and later enables exact receipt recovery", () => {
  const read = vi.spyOn(WebClient.prototype, "sessionItem");
  const { rerender } = render(card(null));
  expect(
    screen.queryByRole("button", { name: i18n.t("planCardLoadFull") }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  ).toBeTruthy();
  rerender(card("native-result"));
  expect(
    screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
  ).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
});

it("rejects recovered text without explicit native ready evidence and retries without promoting readiness", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: "Plan ready by prose only",
      nextCursor: null,
      totalChars: 24,
    })
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: completePlan,
      nextCursor: null,
      totalChars: completePlan.length,
      planStatus: "ready",
    });
  const { container } = render(card());
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  expect(screen.queryByText(i18n.t("planCardReady"))).toBeNull();
  expect(container.textContent).not.toContain("Plan ready by prose only");
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFailed") }),
    ),
  );
  expect(screen.getByText(i18n.t("planCardReady"))).toBeTruthy();
  expect(read.mock.calls.map((call) => call[3])).toEqual([0, 0]);
});

it("aborts old native scope recovery and never copies its full text into the new scope", async () => {
  let finish!: (page: Awaited<ReturnType<WebClient["sessionItem"]>>) => void;
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender, container } = render(card());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
  );
  const signal = read.mock.calls[0]![4];
  rerender(card("native-result", "/tmp/other-session"));
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({
      entryId: "native-result",
      text: completePlan,
      nextCursor: null,
      totalChars: completePlan.length,
      planStatus: "ready",
    }),
  );
  expect(container.textContent).not.toContain("END OF PLAN");
  expect(screen.queryByText(i18n.t("planCardReady"))).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(result.content);
});

it("keeps retry and copy scoped to the visible intermediate plan after a failed next page", async () => {
  const first = "# Read portion\nFirst part of plan";
  const read = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: first,
      nextCursor: first.length,
      totalChars: completePlan.length,
      planStatus: "ready",
    })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      entryId: "native-result",
      text: "\nEND OF PLAN",
      nextCursor: null,
      totalChars: first.length + 12,
      planStatus: "ready",
    });
  render(card());
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("messageLoadMore") }),
    ),
  );
  expect(screen.queryByText(i18n.t("planCardReady"))).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(first);
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFailed") }),
    ),
  );
  expect(read.mock.calls.map((call) => call[3])).toEqual([
    0,
    first.length,
    first.length,
  ]);
  expect(screen.getByText(i18n.t("planCardReady"))).toBeTruthy();
});

it("does not label a recovered full plan as copied when an earlier preview copy finishes late", async () => {
  let finishCopy!: (success: boolean) => void;
  vi.mocked(copyText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCopy = resolve;
      }),
  );
  vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "native-result",
    text: completePlan,
    nextCursor: null,
    totalChars: completePlan.length,
    planStatus: "ready",
  });
  render(card());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  await act(async () => finishCopy(true));
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopy") }),
  ).toBeTruthy();
});

it("does not replace full-plan copy feedback with a late preview-copy failure", async () => {
  let finishCopy!: (success: boolean) => void;
  vi.mocked(copyText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCopy = resolve;
      }),
  );
  vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "native-result",
    text: completePlan,
    nextCursor: null,
    totalChars: completePlan.length,
    planStatus: "ready",
  });
  render(card());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopy") }),
    ),
  );
  expect(screen.getByRole("status").textContent).toBe(i18n.t("copiedMessage"));
  await act(async () => finishCopy(false));
  expect(screen.getByRole("status").textContent).toBe(i18n.t("copiedMessage"));
});

it("resets completed text and copy feedback for the same entry ID under a different native path", async () => {
  vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "native-result",
    text: completePlan,
    nextCursor: null,
    totalChars: completePlan.length,
    planStatus: "ready",
  });
  const { rerender, container } = render(card());
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopy") }),
    ),
  );
  rerender(card("native-result", "/tmp/other-session"));
  expect(container.textContent).not.toContain("END OF PLAN");
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  ).toBeTruthy();
});

function fullMessage(extra?: ReturnType<typeof createElement>) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      "div",
      null,
      createElement(FullMessageText, {
        preview: "Preview",
        sessionId: "session",
        sessionPath: "/tmp/session",
        entryId: "message",
        markdown: false,
      }),
      extra,
    ),
  );
}

it("prefers complete canonical details over a previously loaded partial projection of the same native entry", async () => {
  const plan = "# Canonical plan\nComplete steps\nEND OF PLAN";
  const canonical = projectMessage({
    role: "toolResult",
    toolName: "plan_ready",
    toolCallId: "plan-call",
    isError: false,
    content: [{ type: "text", text: plan }],
    details: { status: "ready", plan },
  });
  const preview: typeof canonical = {
    ...canonical,
    content: "Plan result preview",
    details: undefined,
    truncation: { truncated: true, details: true, text: true },
  };
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "native-result",
    text: "# Canonical plan\n",
    nextCursor: 17,
    totalChars: plan.length,
    planStatus: "ready",
  });
  const renderCard = (result: typeof canonical) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(PlanCard, {
        result,
        sessionId: "session",
        sessionPath: "/tmp/session",
        entryId: "native-result",
      }),
    );
  const { rerender, container } = render(renderCard(preview));
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardLoadFull") }),
    ),
  );
  expect(container.textContent).not.toContain("END OF PLAN");
  rerender(renderCard(canonical));
  expect(
    container.querySelector(".plan-card-body .markdown")?.textContent,
  ).toContain("END OF PLAN");
  expect(
    screen.queryByRole("button", { name: i18n.t("messageLoadMore") }),
  ).toBeNull();
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planCardCopy") }),
    ),
  );
  expect(copyText).toHaveBeenLastCalledWith(plan);
  expect(read).toHaveBeenCalledOnce();
});

it("keeps the load button focused between pages and moves into completed text only while that button still owns focus", async () => {
  let finish!: (page: Awaited<ReturnType<WebClient["sessionItem"]>>) => void;
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { container } = render(fullMessage());
  const button = screen.getByRole("button", {
    name: i18n.t("messageLoadFull"),
  });
  button.focus();
  fireEvent.click(button);
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(read).toHaveBeenCalledOnce();
  await act(async () =>
    finish({
      entryId: "message",
      text: "First ",
      nextCursor: 6,
      totalChars: 12,
    }),
  );
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  await act(async () =>
    finish({
      entryId: "message",
      text: "second",
      nextCursor: null,
      totalChars: 12,
    }),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("messageLoadMore") }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    container.querySelector(".message-full-text"),
  );
  expect(document.activeElement?.textContent).toBe("First second");
});

it("preserves newer focus and keeps a failed page's retry button reachable", async () => {
  let finish!: (page: Awaited<ReturnType<WebClient["sessionItem"]>>) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionItem")
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  render(
    fullMessage(createElement("button", { type: "button" }, "Main input")),
  );
  const load = screen.getByRole("button", { name: i18n.t("messageLoadFull") });
  load.focus();
  await act(async () => fireEvent.click(load));
  const retry = screen.getByRole("button", {
    name: i18n.t("messageLoadFailed"),
  });
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  const input = screen.getByRole("button", { name: "Main input" });
  input.focus();
  await act(async () =>
    finish({
      entryId: "message",
      text: "Restored",
      nextCursor: null,
      totalChars: 8,
    }),
  );
  expect(document.activeElement).toBe(input);
  expect(read).toHaveBeenCalledTimes(2);
});
