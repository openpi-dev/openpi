// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveToolEvidence } from "../../web/protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const call = {
  type: "toolCall",
  id: "tool-1",
  name: "bash",
  arguments: '{"command":"build"}',
} satisfies Extract<WebMessagePart, { type: "toolCall" }>;

function snapshot({
  tool = call,
  results = [],
  liveTools = [],
  running = false,
  stopReason,
}: {
  tool?: Extract<WebMessagePart, { type: "toolCall" }>;
  results?: WebLiveMessage[];
  liveTools?: LiveToolEvidence[];
  running?: boolean;
  stopReason?: WebLiveMessage["stopReason"];
} = {}) {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-26T10:00:00Z",
    cursor: 0,
    preferences: { theme: "system" },
    currentSessionId: "session",
    workspaces: [],
    sessions: [
      {
        id: "session",
        path: "/session.jsonl",
        cwd: "/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        modified: "2026-09-26T10:00:00Z",
        created: "2026-09-26T10:00:00Z",
        messageCount: results.length + 2,
        firstMessage: "Build it",
      },
    ],
    models: [],
    runtime: {
      status: running ? "running" : "idle",
      capabilities: {},
      liveTools,
    },
    selectedSession: {
      id: "session",
      path: "/session.jsonl",
      cwd: "/workspace",
      bytes: 0,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 2_000_000,
      },
      entries: [
        {
          id: "prompt",
          type: "message",
          timestamp: "2026-09-26T10:00:00Z",
          message: { role: "user", content: "Build it" },
        },
        {
          id: "assistant",
          type: "message",
          timestamp: "2026-09-26T10:00:01Z",
          message: {
            role: "assistant",
            content: "",
            parts: [tool],
            stopReason,
          },
        },
        ...results.map((message, index) => ({
          id: `result-${index}`,
          type: "message" as const,
          timestamp: "2026-09-26T10:00:02Z",
          message,
        })),
      ],
    },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4_000_000,
      bytes: 0,
    },
  } satisfies WebSnapshot;
}

function view(value: WebSnapshot, activityObserved = true) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      activityObserved,
      liveMessages: [],
      liveRunning: value.runtime.status === "running",
      livePhase: value.runtime.status === "running" ? "running" : "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("expands Bash and file evidence from canonical display preferences without changing results or their state", () => {
  for (const [name, preference] of [
    ["bash", "bashToolDisplay"],
    ["write", "fileMutationDisplay"],
    ["edit", "fileMutationDisplay"],
  ] as const) {
    const value: WebSnapshot = snapshot({
      tool: { ...call, name },
      results: [
        {
          role: "toolResult",
          toolName: name,
          toolCallId: call.id,
          content: "canonical output",
          isError: false,
        },
      ],
    });
    const original = JSON.stringify(value.selectedSession?.entries);
    const { container, rerender, unmount } = render(view(value));
    const originalState = container
      .querySelector(".tool-evidence-card")
      ?.getAttribute("data-state");
    expect(
      container.querySelector<HTMLDetailsElement>(".tool-evidence-card")?.open,
    ).toBe(false);
    rerender(
      view({
        ...value,
        preferences: { ...value.preferences, [preference]: "full" },
      }),
    );
    expect(
      container.querySelector<HTMLDetailsElement>(".tool-evidence-card")?.open,
    ).toBe(true);
    expect(container.querySelector(".process-sequence")).toBeNull();
    expect(
      container
        .querySelector(".tool-evidence-card")
        ?.getAttribute("data-state"),
    ).toBe(originalState);
    expect(JSON.stringify(value.selectedSession?.entries)).toBe(original);
    unmount();
  }
});

it("uses the full subagent result only when requested while preserving the exact terminal state", () => {
  const value: WebSnapshot = snapshot();
  value.selectedSession!.entries.push({
    id: "child-result",
    type: "message",
    timestamp: "2026-10-02T00:00:00Z",
    message: {
      role: "custom",
      customType: "subagent-result",
      content: "complete child report",
      details: {
        displayContent: "bounded summary",
        results: [{ id: "child", status: "done" }],
      },
    },
  });
  const { container, rerender } = render(view(value));
  expect(container.textContent).toContain("bounded summary");
  expect(container.textContent).not.toContain("complete child report");
  rerender(
    view({
      ...value,
      preferences: { ...value.preferences, subagentResultDisplay: "full" },
    }),
  );
  expect(
    container.querySelector<HTMLDetailsElement>(".activity-card.subagent")
      ?.open,
  ).toBe(true);
  expect(container.textContent).toContain("complete child report");
});

it("shows one compaction status before an agent turn, freezes on disconnect, and restores persisted completion", () => {
  const value: WebSnapshot = snapshot();
  value.selectedExecution = {
    sessionId: "session",
    sessionPath: "/session.jsonl",
    status: "running",
    liveTools: [],
    liveToolsOmitted: 0,
    compaction: { state: "running", startedAt: 1, elapsedMs: 12_000 },
  };
  const { container, rerender, getByText, queryByText } = render(view(value));
  expect(getByText(i18n.t("compactionRunning"))).toBeTruthy();
  expect(container.querySelectorAll('[data-state="running"]')).toHaveLength(1);
  expect(container.querySelector(".context-compaction-label svg")).toBeTruthy();
  expect(container.querySelector(".conversation-running")).toBeNull();
  expect(container.querySelector('[role="timer"]')?.textContent).toContain(
    "12",
  );
  rerender(view(value, false));
  expect(getByText(i18n.t("compactionUnavailable"))).toBeTruthy();
  expect(container.querySelector('[role="timer"]')).toBeNull();
  expect(container.querySelector(".context-compaction-spinner")).toBeNull();
  rerender(view(value));
  expect(getByText(i18n.t("compactionRunning"))).toBeTruthy();
  value.selectedExecution = {
    ...value.selectedExecution,
    status: "idle",
    compaction: { state: "completed" },
  };
  value.selectedSession = {
    ...value.selectedSession!,
    entries: [
      ...value.selectedSession!.entries,
      {
        type: "compaction",
        id: "native-compaction",
        timestamp: "2026-09-29T00:00:00Z",
      },
    ],
  };
  rerender(view({ ...value }));
  expect(queryByText(i18n.t("compactionRunning"))).toBeNull();
  expect(container.querySelectorAll('[data-state="completed"]')).toHaveLength(
    1,
  );
  delete value.selectedExecution;
  rerender(view({ ...value }));
  expect(getByText(i18n.t("compactionCompleted"))).toBeTruthy();
});

it.each(["failed", "cancelled", "unchanged"] as const)(
  "does not label compaction %s as successful or keep its spinner",
  (state) => {
    const value: WebSnapshot = snapshot();
    value.selectedExecution = {
      sessionId: "session",
      sessionPath: "/session.jsonl",
      status: "idle",
      liveTools: [],
      liveToolsOmitted: 0,
      compaction: { state },
    };
    const { container, rerender } = render(view(value));
    expect(container.querySelector(`[data-state="${state}"]`)).toBeTruthy();
    expect(container.querySelector(".context-compaction-spinner")).toBeNull();
    expect(container.querySelector('[data-state="completed"]')).toBeNull();
    value.selectedExecution.sessionPath = "/another-copy.jsonl";
    rerender(view({ ...value }));
    expect(container.querySelector(".context-compaction")).toBeNull();
  },
);

it("requires a native compaction entry rather than a message claiming compaction completed", () => {
  const value: WebSnapshot = snapshot();
  value.selectedSession = {
    ...value.selectedSession!,
    entries: [
      {
        id: "claim",
        type: "message",
        timestamp: "2026-09-29T00:00:00Z",
        message: {
          role: "custom",
          customType: "openpi-context-compacted",
          content: "Completed",
        },
      },
    ],
  };
  const { container } = render(view(value));
  expect(container.querySelector(".context-compaction")).toBeNull();
});

it("keeps completed compaction inside the elapsed process fold and leaves the exact final answer visible", () => {
  const value: WebSnapshot = snapshot();
  value.selectedSession!.entries = [
    value.selectedSession!.entries[0]!,
    {
      type: "compaction",
      id: "native-compaction",
      timestamp: "2026-09-26T10:00:01Z",
    },
    {
      type: "message",
      id: "final",
      timestamp: "2026-09-26T10:00:02Z",
      message: {
        role: "assistant",
        content: "Exact final answer",
        stopReason: "stop",
      },
    },
    {
      type: "custom",
      id: "timing",
      timestamp: "2026-09-26T10:00:02Z",
      turnTiming: {
        version: 1,
        sessionId: "session",
        commandId: "run",
        epoch: 1,
        promptEntryId: "prompt",
        resultEntryId: "final",
        startedAt: 0,
        finishedAt: 2000,
        elapsedMs: 2000,
        outcome: "completed",
      },
    },
  ];
  value.selectedExecution = {
    sessionId: "session",
    sessionPath: "/session.jsonl",
    status: "idle",
    liveTools: [],
    liveToolsOmitted: 0,
    compaction: { state: "completed" },
  };
  const { container, getByText } = render(view(value));
  const body = container.querySelector<HTMLElement>(".turn-response-body")!;
  expect(body.hidden).toBe(true);
  expect(
    body.querySelectorAll('.context-compaction[data-state="completed"]'),
  ).toHaveLength(1);
  expect(getByText("Exact final answer").closest("[hidden]")).toBeNull();
  fireEvent.click(container.querySelector(".turn-duration-toggle")!);
  expect(body.hidden).toBe(false);
  expect(container.querySelectorAll(".context-compaction")).toHaveLength(1);
  fireEvent.click(container.querySelector(".turn-duration-toggle")!);
  expect(body.hidden).toBe(true);
  expect(getByText("Exact final answer").closest("[hidden]")).toBeNull();
});

it("shows the actual running tool in a folded group and follows new rows only while the reader stays at the bottom", async () => {
  const value: WebSnapshot = snapshot({ running: true });
  const calls = Array.from({ length: 12 }, (_, index) => ({
    ...call,
    id: `read-${index}`,
    name: "read",
    arguments: JSON.stringify({ path: `/workspace/src/file-${index}.ts` }),
  }));
  value.selectedSession!.entries[1]!.message!.parts = calls;
  value.runtime.liveTools = calls.map((tool, index) => ({
    call: tool,
    state: index === 10 ? "running" : index === 11 ? "unknown" : "returned",
  }));
  const rendered = render(view(value));
  const sequence =
    rendered.container.querySelector<HTMLDetailsElement>(".process-sequence")!;
  const scroller = rendered.container.querySelector<HTMLDivElement>(
    ".process-sequence-scroll",
  )!;
  expect(sequence.open).toBe(true);
  expect(sequence.querySelector("summary")?.textContent).toContain(
    "file-10.ts",
  );
  expect(
    sequence.querySelector(".process-sequence-preview")?.getAttribute("title"),
  ).toBe("/workspace/src/file-10.ts");
  expect(
    sequence
      .querySelector("summary svg")
      ?.classList.contains("lucide-book-open"),
  ).toBe(true);
  let height = 900;
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 360 },
    scrollHeight: { get: () => height },
  });
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  expect(scroller.hasAttribute("data-scroll-above")).toBe(true);
  expect(scroller.hasAttribute("data-scroll-below")).toBe(true);
  height = 1100;
  rendered.rerender(view({ ...value, generatedAt: "2026-09-26T10:00:05Z" }));
  expect(scroller.scrollTop).toBe(100);
  scroller.scrollTop = height - scroller.clientHeight;
  fireEvent.scroll(scroller);
  height = 1200;
  rendered.rerender(view({ ...value, generatedAt: "2026-09-26T10:00:06Z" }));
  expect(scroller.scrollTop).toBe(height);
  await act(async () => {
    sequence.open = false;
    fireEvent(sequence, new Event("toggle"));
  });
  expect(sequence.open).toBe(false);
  expect(sequence.querySelector("summary")?.textContent).toContain(
    "file-10.ts",
  );
  rendered.rerender(view({ ...value, generatedAt: "2026-09-26T10:00:07Z" }));
  expect(sequence.open).toBe(false);
});

it("renders complete available thinking without the tool-output byte or line limits", async () => {
  const value: WebSnapshot = snapshot();
  const text = `${"完整思考中的一行内容。\n".repeat(420)}思考正文的最后一句`;
  value.selectedSession!.entries[1]!.message!.parts = [
    { type: "thinking", text },
  ];
  const rendered = render(view(value));
  expect(rendered.container.querySelector(".thinking-evidence")).toBeNull();
  await act(async () => {
    fireEvent.click(
      rendered.container.querySelector(".thinking-line > summary")!,
    );
  });
  await waitFor(() =>
    expect(
      rendered.container.querySelector(".thinking-evidence")?.textContent,
    ).toContain("思考正文的最后一句"),
  );
});

it("recovers a truncated saved thinking part on expansion and retains its complete text across folding", async () => {
  const value: WebSnapshot = snapshot();
  value.selectedSession!.entries[1]!.message!.parts = [
    {
      type: "thinking",
      text: "Thinking preview",
      sourcePartIndex: 3,
      textTruncated: true,
    },
  ];
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "assistant",
    partIndex: 3,
    text: "Complete provider thinking, including its last line.",
    nextCursor: null,
    totalChars: 52,
  });
  const rendered = render(view(value));
  expect(read).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(
      rendered.container.querySelector(".thinking-line > summary")!,
    );
  });
  await waitFor(() =>
    expect(
      rendered.container.querySelector(".thinking-evidence")?.textContent,
    ).toContain("including its last line."),
  );
  expect(read).toHaveBeenCalledWith(
    "session",
    "/session.jsonl",
    "assistant",
    0,
    expect.any(AbortSignal),
    "thinking",
    3,
  );
  await act(async () => {
    fireEvent.click(
      rendered.container.querySelector(".thinking-line > summary")!,
    );
  });
  await waitFor(() =>
    expect(rendered.container.querySelector(".thinking-evidence")).toBeNull(),
  );
  await act(async () => {
    fireEvent.click(
      rendered.container.querySelector(".thinking-line > summary")!,
    );
  });
  await waitFor(() =>
    expect(
      rendered.container.querySelector(".thinking-evidence")?.textContent,
    ).toContain("including its last line."),
  );
  expect(read).toHaveBeenCalledOnce();
});

it.each([undefined, "aborted", "error"] as const)(
  "keeps an unpaired historical tool neutral after %s instead of inventing execution or completion",
  (stopReason) => {
    const { container } = render(view(snapshot({ stopReason })));
    expect(container.querySelector(".process-sequence")).toBeNull();
    expect(
      container.querySelector(".process-step")?.getAttribute("data-status"),
    ).toBe("unknown");
    expect(
      container
        .querySelector(".tool-evidence-card")
        ?.getAttribute("data-state"),
    ).toBe("unknown");
    expect(container.querySelector(".process-step.running")).toBeNull();
    expect(container.querySelector(".status-mark.done")).toBeNull();
  },
);

it("uses the exact live tool state while partial output has no terminal receipt", () => {
  const partial = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: "Building packages",
  } satisfies WebLiveMessage;
  const rendered = render(
    view(
      snapshot({
        running: true,
        liveTools: [{ call, result: partial, state: "running" }],
      }),
    ),
  );
  expect(rendered.container.querySelector(".process-sequence")).toBeNull();
  expect(
    rendered.container
      .querySelector(".process-step")
      ?.getAttribute("data-status"),
  ).toBe("running");
  expect(
    rendered.container
      .querySelector(".tool-evidence-card")
      ?.getAttribute("data-state"),
  ).toBe("running");
  expect(
    rendered.container.querySelector<HTMLDetailsElement>(".tool-evidence-card")
      ?.open,
  ).toBe(false);

  rendered.rerender(
    view(
      snapshot({ liveTools: [{ call, result: partial, state: "unknown" }] }),
    ),
  );
  expect(rendered.container.querySelector(".process-sequence")).toBeNull();
  expect(
    rendered.container
      .querySelector(".process-step")
      ?.getAttribute("data-status"),
  ).toBe("unknown");
  expect(
    rendered.container
      .querySelector(".tool-evidence-card")
      ?.getAttribute("data-state"),
  ).toBe("unknown");
  expect(rendered.container.querySelector(".status-mark.done")).toBeNull();

  const result = { ...partial, content: "Built packages", isError: false };
  rendered.rerender(
    view(
      snapshot({
        results: [result],
        liveTools: [{ call, result, state: "returned" }],
      }),
    ),
  );
  expect(rendered.container.querySelector(".process-sequence")).toBeNull();
  expect(
    rendered.container
      .querySelector(".process-step")
      ?.getAttribute("data-status"),
  ).toBe("done");
  expect(
    rendered.container
      .querySelector(".tool-evidence-card")
      ?.getAttribute("data-state"),
  ).toBe("returned");
});

it("does not turn a current unmatched call into running without a native tool execution fact", () => {
  const { container } = render(view(snapshot({ running: true })));
  expect(container.querySelector(".process-sequence")).toBeNull();
  expect(
    container.querySelector(".process-step")?.getAttribute("data-status"),
  ).toBe("unknown");
  expect(
    container.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
  ).toBe("unknown");
});

it("keeps generic tools consistent with missing or native running evidence", () => {
  const generic = { ...call, name: "custom_tool" };
  const rendered = render(view(snapshot({ tool: generic })));
  expect(rendered.container.querySelector(".process-sequence")).toBeNull();
  expect(rendered.container.querySelector(".tool-line.running")).toBeNull();
  expect(
    rendered.container
      .querySelector(".process-step")
      ?.getAttribute("data-status"),
  ).toBe("unknown");
  rendered.rerender(
    view(
      snapshot({
        tool: generic,
        running: true,
        liveTools: [{ call: generic, state: "running" }],
      }),
    ),
  );
  expect(rendered.container.querySelector(".tool-line.running")).toBeTruthy();
  expect(
    rendered.container
      .querySelector(".process-step")
      ?.getAttribute("data-status"),
  ).toBe("running");
});

it("keeps family activity status aligned with the exact live tool execution", () => {
  const tool = { ...call, name: "workflow_status" };
  const partial = {
    role: "toolResult",
    toolName: tool.name,
    toolCallId: tool.id,
    content: "Checking the workflow",
  } satisfies WebLiveMessage;
  const { container } = render(
    view(
      snapshot({
        tool,
        running: true,
        liveTools: [{ call: tool, result: partial, state: "running" }],
      }),
    ),
  );
  expect(
    container.querySelector(".process-step")?.getAttribute("data-status"),
  ).toBe("running");
  expect(
    container
      .querySelector(".activity-card .status-mark.running")
      ?.getAttribute("aria-label"),
  ).toBe(i18n.t("toolState_running"));
});

it("does not borrow a later turn's execution state for an earlier unmatched tool", () => {
  const current = { ...call, id: "current-tool" };
  const value = snapshot({
    tool: current,
    running: true,
    liveTools: [{ call: current, state: "running" }],
  });
  value.selectedSession.entries.unshift(
    {
      id: "old-prompt",
      type: "message",
      timestamp: "2026-09-26T09:00:00Z",
      message: { role: "user", content: "Earlier task" },
    },
    {
      id: "old-assistant",
      type: "message",
      timestamp: "2026-09-26T09:00:01Z",
      message: { role: "assistant", content: "", parts: [call] },
    },
  );
  const { container } = render(view(value));
  expect(container.querySelectorAll(".process-sequence")).toHaveLength(0);
  expect(
    Array.from(container.querySelectorAll(".single-tool-step"), (element) =>
      element.getAttribute("data-status"),
    ),
  ).toEqual(["unknown", "running"]);
  expect(
    Array.from(container.querySelectorAll(".process-step"), (element) =>
      element.getAttribute("data-status"),
    ),
  ).toEqual(["unknown", "running"]);
});

it("does not summarize a mixed returned and unmatched sequence as completed", () => {
  const value = snapshot({
    results: [
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: call.id,
        content: "Built",
        isError: false,
      },
    ],
  });
  value.selectedSession.entries[1]!.message!.parts!.push({
    ...call,
    id: "missing-tool",
  });
  const { container } = render(view(value));
  expect(
    container.querySelector(".process-sequence")?.getAttribute("data-status"),
  ).toBe("unknown");
  expect(
    Array.from(container.querySelectorAll(".process-step"), (element) =>
      element.getAttribute("data-status"),
    ),
  ).toEqual(["done", "unknown"]);
  expect(container.querySelector(".status-mark.done")).toBeNull();
});

it("retains a known process failure in a single tool while the native status-query receipt succeeded", () => {
  const tool = {
    ...call,
    name: "bg_status",
    arguments: '{"id":"background-terminal"}',
  };
  const receipt = {
    role: "toolResult",
    toolName: "bg_status",
    toolCallId: tool.id,
    content: "Background process failed with exit code 2",
    isError: false,
    details: { status: "failed", exitCode: 2 },
  } satisfies WebLiveMessage;
  const { container } = render(view(snapshot({ tool, results: [receipt] })));
  expect(container.querySelector(".process-sequence")).toBeNull();
  expect(
    container.querySelector(".process-step")?.getAttribute("data-status"),
  ).toBe("error");
  expect(
    container.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
  ).toBe("failed");
  expect(
    container.querySelector(".tool-evidence-card > summary .evidence-status")
      ?.textContent,
  ).toBe(i18n.t("toolState_failed"));
  expect(
    container.querySelector(".evidence-content details")?.textContent,
  ).toContain('"isError":false');
});

it.each([false, true])(
  "retains native workflow uncertainty with an unmatched step %s",
  (unmatched) => {
    const tool = {
      ...call,
      name: "workflow_stop",
      arguments: '{"runId":"workflow-run"}',
    };
    const value = snapshot({
      tool,
      results: [
        {
          role: "toolResult",
          toolName: tool.name,
          toolCallId: tool.id,
          content: "Workflow workflow-run is already uncertain.",
          isError: false,
          details: { runId: "workflow-run", status: "uncertain" },
        },
      ],
    });
    if (unmatched)
      value.selectedSession.entries[1]!.message!.parts!.push({
        ...call,
        id: "missing-tool",
      });
    const { container } = render(view(value));
    if (unmatched)
      expect(
        container
          .querySelector(".process-sequence")
          ?.getAttribute("data-status"),
      ).toBe("warn");
    else expect(container.querySelector(".process-sequence")).toBeNull();
    expect(
      container.querySelector(".process-step")?.getAttribute("data-status"),
    ).toBe("warn");
    expect(
      container
        .querySelector(
          unmatched
            ? ".process-sequence > summary .status-mark.warn"
            : ".activity-card .status-mark.warn",
        )
        ?.getAttribute("aria-label"),
    ).toBe(i18n.t("toolState_unknown"));
    expect(container.querySelector(".status-mark.done")).toBeNull();
  },
);

it("keeps known process failure ahead of an unmatched step in the group summary", () => {
  const tool = {
    ...call,
    name: "bg_status",
    arguments: '{"id":"background-terminal"}',
  };
  const value = snapshot({
    tool,
    results: [
      {
        role: "toolResult",
        toolName: "bg_status",
        toolCallId: tool.id,
        content: "Background process failed",
        isError: false,
        details: { status: "failed", exitCode: 2 },
      },
    ],
  });
  value.selectedSession.entries[1]!.message!.parts!.push({
    ...call,
    id: "missing-tool",
  });
  const { container } = render(view(value));
  expect(
    container.querySelector(".process-sequence")?.getAttribute("data-status"),
  ).toBe("error");
  expect(
    Array.from(container.querySelectorAll(".process-step"), (element) =>
      element.getAttribute("data-status"),
    ),
  ).toEqual(["error", "unknown"]);
  expect(container.querySelector(".status-mark.done")).toBeNull();
});

it.each([
  ["Command exited with code 2", "failed"],
  ["Command aborted", "cancelled"],
  ["Command timed out after 10 seconds", "timed_out"],
] as const)(
  "preserves terminal error and interruption evidence for %s",
  (content, state) => {
    const { container } = render(
      view(
        snapshot({
          results: [
            {
              role: "toolResult",
              toolName: "bash",
              toolCallId: call.id,
              content,
              isError: true,
            },
          ],
        }),
      ),
    );
    expect(container.querySelector(".process-sequence")).toBeNull();
    expect(
      container.querySelector(".process-step")?.getAttribute("data-status"),
    ).toBe("error");
    expect(
      container
        .querySelector(".tool-evidence-card")
        ?.getAttribute("data-state"),
    ).toBe(state);
    expect(container.querySelector(".evidence-shell pre")?.textContent).toBe(
      `$ build\n\n${content}`,
    );
    expect(container.querySelector(".process-step.running")).toBeNull();
  },
);
