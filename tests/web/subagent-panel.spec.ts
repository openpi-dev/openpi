// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSubagentDetail } from "../../extensions/shared/web-observer-registry.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { ActivityBar } from "../../web/ui/src/features/activity/ActivityBar.tsx";
import { recordedSubagents } from "../../web/ui/src/features/subagents/recorded-subagents.ts";
import { SubagentPanel } from "../../web/ui/src/features/subagents/SubagentPanel.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const activity = {
  items: [
    {
      id: "sa-1",
      title: "Package review",
      status: "running" as const,
      createdAt: 1,
    },
    {
      id: "sa-2",
      title: "Readme review",
      status: "running" as const,
      createdAt: 2,
    },
  ],
  omitted: 0,
  truncated: false,
};
function detail(overrides: Partial<WebSubagentDetail> = {}): WebSubagentDetail {
  return {
    kind: "subagents",
    id: "sa-1",
    title: "Package review",
    status: "running",
    createdAt: 1,
    cwd: "/workspace",
    prompt: "Inspect package",
    transcript: [],
    liveTools: [],
    finalText: "",
    truncated: false,
    omittedEntries: 0,
    ...overrides,
  };
}
function reply(value = detail(), sessionId = "session-a") {
  return { sessionId, detail: value };
}
function showPanel() {
  return render(
    createElement(
      Providers,
      null,
      createElement(SubagentPanel, {
        sessionId: "session-a",
        initialId: "sa-1",
        activity,
        onClose: vi.fn(),
      }),
    ),
  );
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

it("opens a nonmodal grouped overview, then supports detail/back and Escape navigation", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockResolvedValue(reply());
  const onClose = vi.fn();
  render(
    createElement(
      Providers,
      null,
      createElement(SubagentPanel, {
        sessionId: "session-a",
        activity,
        onClose,
        records: [
          {
            id: "saved",
            title: "Saved review",
            state: "done",
            result: "Saved answer",
          },
        ],
      }),
    ),
  );
  const panel = screen.getByRole("complementary", {
    name: i18n.t("subagentDetails"),
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(panel.getAttribute("aria-modal")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  const activeGroup = screen
    .getByRole("heading", { name: new RegExp(i18n.t("subagentActiveGroup")) })
    .closest("section");
  const finishedGroup = screen
    .getByRole("heading", { name: new RegExp(i18n.t("subagentFinishedGroup")) })
    .closest("section");
  expect(activeGroup?.textContent).toContain("Package review");
  expect(activeGroup?.textContent).not.toContain("Saved review");
  expect(finishedGroup?.textContent).toContain("Saved review");
  fireEvent.click(screen.getByRole("button", { name: /Package review/ }));
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("navigation", { name: i18n.t("subagentTasks") }),
  ).toBeNull();
  const back = screen.getByRole("button", { name: i18n.t("backToSubagents") });
  expect(document.activeElement).toBe(back);
  fireEvent.keyDown(back, { key: "Escape" });
  expect(read.mock.calls[0]![2].aborted).toBe(true);
  expect(
    screen.getByRole("navigation", { name: i18n.t("subagentTasks") }),
  ).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each([
  reply(detail({ finalText: "Wrong session payload" }), "session-b"),
  reply(detail({ id: "sa-other", finalText: "Wrong child payload" })),
])(
  "rejects detail whose Session or child identity changed",
  async (response) => {
    const read = vi
      .spyOn(WebClient.prototype, "subagentDetail")
      .mockResolvedValue(response);
    showPanel();
    await flush();
    expect(read).toHaveBeenCalledWith(
      "session-a",
      "sa-1",
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      i18n.t("subagentUnavailable"),
    );
    expect(screen.queryByText(response.detail.finalText)).toBeNull();
    expect(screen.getByText(i18n.t("unknownState"))).toBeTruthy();
  },
);

it("aborts the previous selection and ignores its late detail response", async () => {
  let finishOld: ((value: ReturnType<typeof reply>) => void) | undefined;
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(
      reply(
        detail({
          id: "sa-2",
          title: "Readme review",
          status: "done",
          finalText: "Current answer",
        }),
      ),
    );
  const view = showPanel();
  const oldSignal = read.mock.calls[0]![2];
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("backToSubagents") }),
  );
  expect(oldSignal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Readme review/ }));
  await flush();
  expect(oldSignal.aborted).toBe(true);
  expect(read.mock.calls[1]?.slice(0, 2)).toEqual(["session-a", "sa-2"]);
  await act(async () => {
    finishOld?.(reply(detail({ finalText: "Stale answer" })));
  });
  expect(screen.getByText("Current answer")).toBeTruthy();
  expect(screen.queryByText("Stale answer")).toBeNull();
  view.unmount();
  expect(read.mock.calls[1]![2].aborted).toBe(true);
});

it("polls live evidence, stops when settled, and aborts when closed", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockResolvedValueOnce(
      reply(detail({ liveAssistant: { text: "Working now", thinking: "" } })),
    )
    .mockResolvedValueOnce(
      reply(
        detail({
          status: "done",
          outcome: "completed",
          settledAt: 3,
          finalText: "Verified result",
        }),
      ),
    );
  const view = showPanel();
  await flush();
  expect(screen.getByText("Working now")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.getByText("Verified result")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  const signal = read.mock.calls[1]![2];
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it("pauses detail reads while hidden and refreshes on visibility without stopping the child", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce(
      reply(detail({ status: "done", finalText: "Visible again" })),
    );
  const view = showPanel();
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Visible again")).toBeTruthy();
  } finally {
    view.unmount();
    Reflect.deleteProperty(document, "visibilityState");
  }
});

it("cancels live polling on unmount and shows unavailable on fetch failure", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockRejectedValue(new Error("Resource unavailable"));
  const view = showPanel();
  await flush();
  expect(screen.getByRole("alert").textContent).toContain(
    i18n.t("subagentUnavailable"),
  );
  expect(screen.queryByText(i18n.t("subagentResult"))).toBeNull();
  expect(screen.getByText(i18n.t("unknownState"))).toBeTruthy();
  view.unmount();
  expect(read.mock.calls[0]![2].aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(read).toHaveBeenCalledTimes(1);
});

it("renders real transcript, paired tool errors and redacted thinking without exposing redacted text", async () => {
  vi.spyOn(WebClient.prototype, "subagentDetail").mockResolvedValue(
    reply(
      detail({
        status: "error",
        outcome: "interrupted",
        errorText: "Stopped by parent",
        transcript: [
          { kind: "user", text: "Child task" },
          {
            kind: "assistant",
            parts: [
              { type: "text", text: "Read attempt" },
              {
                type: "thinking",
                text: "Hidden sensitive thought",
                redacted: true,
              },
              {
                type: "toolCall",
                toolId: "call-1",
                name: "read",
                argsPreview: "missing.txt",
              },
            ],
          },
          {
            kind: "toolResult",
            toolId: "call-1",
            name: "read",
            isError: true,
            outputPreview: "File unavailable",
          },
        ],
        liveTools: [
          {
            toolId: "call-2",
            name: "grep",
            argsPreview: "needle",
            outputPreview: "Searching",
          },
        ],
      }),
    ),
  );
  showPanel();
  await flush();
  const log = screen.getByRole("log");
  expect(within(log).getByText("Child task")).toBeTruthy();
  expect(within(log).getByText("Read attempt")).toBeTruthy();
  expect(within(log).queryByText("Hidden sensitive thought")).toBeNull();
  expect(
    within(log).getByText(i18n.t("subagentThinkingRedacted")),
  ).toBeTruthy();
  expect(within(log).getAllByText("File unavailable")).toHaveLength(1);
  expect(within(log).getByText(i18n.t("subagentTool_error"))).toBeTruthy();
  expect(within(log).getByText("Searching")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Stopped by parent");
  expect(screen.getByText(i18n.t("subagentState_interrupted"))).toBeTruthy();
});

const truncation = {
  bytes: 0,
  maxBytes: 4 * 1024 * 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};
function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-18T00:00:00Z",
    cursor: 1,
    currentSessionId: "session-a",
    workspaces: [],
    sessions: [],
    models: [],
    truncation,
    runtime: { status: "running", capabilities: { subagents: activity } },
    selectedSession: {
      id: "session-a",
      path: "/workspace/session.jsonl",
      cwd: "/workspace",
      bytes: 0,
      truncation,
      entries: [
        {
          type: "message",
          id: "call",
          timestamp: "2026-09-18T00:00:00Z",
          message: {
            role: "assistant",
            content: "",
            parts: [
              {
                type: "toolCall",
                id: "spawn-call",
                name: "subagent_spawn",
                arguments: JSON.stringify({ name: "different-title" }),
              },
            ],
          },
        },
        {
          type: "message",
          id: "receipt",
          timestamp: "2026-09-18T00:00:01Z",
          message: {
            role: "toolResult",
            toolName: "subagent_spawn",
            toolCallId: "spawn-call",
            content: "Spawn accepted",
            isError: false,
            details: { id: "sa-1", title: "Package review" },
          },
        },
      ],
    },
  };
}

it("opens only the selected saved child record without fetching a historical Session", async () => {
  const read = vi.spyOn(WebClient.prototype, "subagentDetail");
  render(
    createElement(
      Providers,
      null,
      createElement(SubagentPanel, {
        sessionId: "historical-session",
        initialId: "saved-1",
        liveAvailable: false,
        records: [
          {
            id: "saved-1",
            title: "Owned saved child",
            receipt: "Saved spawn receipt",
            result: "Owned final answer",
            state: "done",
          },
          {
            id: "saved-2",
            title: "Other saved child",
            result: "Other final answer",
            state: "error",
          },
        ],
        onClose: vi.fn(),
      }),
    ),
  );
  await flush();
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByText("Owned final answer")).toBeTruthy();
  expect(screen.queryByText("Other final answer")).toBeNull();
  expect(screen.queryByRole("log")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("backToSubagents") }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Other saved child/ }));
  await flush();
  expect(screen.getByText("Other final answer")).toBeTruthy();
  expect(screen.queryByText("Owned final answer")).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it("derives saved ownership from exact structured IDs, never spawn success or text mentions", () => {
  const records = recordedSubagents([
    { role: "assistant", content: "sa-fake completed" },
    {
      role: "toolResult",
      toolName: "subagent_spawn",
      content: "spawn accepted",
      details: { id: "sa-real", title: "Actual child", status: "done" },
    },
    {
      role: "toolResult",
      toolName: "subagent_spawn",
      content: "failed spawn",
      isError: true,
      details: { id: "sa-failed" },
    },
    {
      role: "toolResult",
      toolName: "subagent_spawn",
      content: "invalid",
      details: { id: "bad\nID" },
    },
    {
      role: "toolResult",
      toolName: "subagent_check",
      content: "interrupted answer",
      details: { id: "sa-settled", status: "error", outcome: "interrupted" },
    },
  ]);
  expect(records).toEqual([
    { id: "sa-real", title: "Actual child", receipt: "spawn accepted" },
    {
      id: "sa-settled",
      title: "sa-settled",
      result: "interrupted answer",
      state: "interrupted",
    },
  ]);
});

it("opens the child list and individual activity chips with exact IDs", () => {
  const inspect = vi.fn();
  render(
    createElement(
      Providers,
      null,
      createElement(ActivityBar, {
        snapshot: snapshot(),
        onInspectSubagent: inspect,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("subagentList", { count: 2, running: 2 }),
    }),
  );
  expect(inspect).toHaveBeenLastCalledWith();
  fireEvent.click(screen.getByRole("button", { name: /Readme review/ }));
  expect(inspect).toHaveBeenLastCalledWith("sa-2");
});

it("distinguishes interrupted activity and record count from active concurrency", () => {
  const value: WebSnapshot = {
    ...snapshot(),
    runtime: {
      status: "idle",
      capabilities: {
        subagents: {
          items: [
            {
              id: "sa-interrupted",
              title: "Interrupted review",
              status: "error",
              outcome: "interrupted",
              createdAt: 1,
              settledAt: 2,
            },
          ],
          omitted: 0,
          truncated: false,
        },
      },
    },
  };
  render(
    createElement(
      Providers,
      null,
      createElement(ActivityBar, {
        snapshot: value,
        onInspectSubagent: vi.fn(),
      }),
    ),
  );
  expect(
    screen.getByRole("button", {
      name: i18n.t("subagentList", { count: 2, running: 0 }),
    }),
  ).toBeTruthy();
  const activityChip = screen.getByRole("button", {
    name: /Interrupted review.*Interrupted/u,
  });
  expect(activityChip.classList.contains("interrupted")).toBe(true);
  expect(activityChip.classList.contains("error")).toBe(false);
});

it.each([true, false])(
  "spawn receipt displays canonical running or unavailable state, never fabricated completion (available=%s)",
  (available) => {
    const value = snapshot();
    if (!available) value.runtime.capabilities = {};
    const inspect = vi.fn();
    const view = render(
      createElement(
        Providers,
        null,
        createElement(Transcript, {
          snapshot: value,
          liveMessages: [],
          liveRunning: false,
          livePhase: "idle",
          liveRetry: null,
          thinkingStarts: {},
          thinkingDurations: {},
          scrollToBottom: 0,
          onResend: async () => true,
          onInspectSubagent: inspect,
        }),
      ),
    );
    const card = view.container.querySelector(".activity-card.subagent");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain(
      i18n.t(available ? "subagentState_running" : "subagentStateUnavailable"),
    );
    expect(card?.querySelector('[aria-label="completed"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Package review/ }));
    expect(inspect).toHaveBeenCalledWith("sa-1");
  },
);

it("does not borrow a current Session child's status for the same ID in historical conversation", () => {
  const value = snapshot();
  value.currentSessionId = "different-active-parent";
  const inspect = vi.fn();
  const view = render(
    createElement(
      Providers,
      null,
      createElement(Transcript, {
        snapshot: value,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
        onInspectSubagent: inspect,
      }),
    ),
  );
  const card = view.container.querySelector(".activity-card.subagent");
  expect(card?.textContent).toContain(i18n.t("subagentStateUnavailable"));
  expect(card?.querySelector(".subagent-state.running")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Package review/ }));
  expect(inspect).toHaveBeenCalledWith("sa-1");
});

it("keeps a recently updated child inside the bounded saved list", () => {
  const messages = Array.from({ length: 33 }, (_, index) => ({
    role: "toolResult",
    toolName: "subagent_spawn",
    content: "Started",
    details: { id: `sa-${index}`, title: `Task ${index}` },
  }));
  const records = recordedSubagents([
    ...messages,
    {
      role: "toolResult",
      toolName: "subagent_wait",
      content: "Latest result",
      details: { results: [{ id: "sa-0", status: "done" }] },
    },
  ]);
  expect(records).toHaveLength(32);
  expect(records.at(-1)).toMatchObject({
    id: "sa-0",
    title: "Task 0",
    result: "Latest result",
  });
  expect(records.some((record) => record.id === "sa-1")).toBe(false);
});

it("keeps the overview entry reachable for saved children after the live manager is gone", () => {
  const value = snapshot();
  value.runtime.capabilities = {};
  const inspect = vi.fn();
  render(
    createElement(
      Providers,
      null,
      createElement(ActivityBar, {
        snapshot: value,
        onInspectSubagent: inspect,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("subagentList", { count: 1, running: 0 }),
    }),
  );
  expect(inspect).toHaveBeenCalledWith();
});
