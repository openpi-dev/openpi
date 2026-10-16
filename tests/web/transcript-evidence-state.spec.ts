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
import { projectMessage } from "../../web/protocol/types.ts";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("renders persisted Code Mode children as ordinary tools and preserves script evidence", () => {
  const tool = {
    ...call,
    id: "code",
    name: "codemode",
    arguments: '{"code":"await tools.read({path:\"file.ts\"})"}',
  };
  const result = projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: tool.id,
    isError: false,
    content: "script output",
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "code/1",
          name: "read",
          arguments: { path: "file.ts" },
          status: "ok",
        },
        {
          id: "code/2",
          name: "bash",
          arguments: { command: "bun run check" },
          status: "ok",
        },
        {
          id: "code/3",
          name: "edit",
          arguments: { path: "styles.css" },
          status: "error",
          error: "Missing text",
        },
      ],
    },
  });
  const { container, getByText } = render(
    view(snapshot({ tool, results: [result] })),
  );
  expect(
    [...container.querySelectorAll("details[data-tool]")].map((element) =>
      element.getAttribute("data-tool"),
    ),
  ).toEqual(["read", "bash", "edit"]);
  expect(
    container.querySelector('[data-tool="read"] .lucide-book-open'),
  ).toBeTruthy();
  expect(
    container.querySelector('[data-tool="bash"] .tool-summary')?.textContent,
  ).toContain("bun run check");
  expect(
    container.querySelector('[data-tool="edit"]')?.classList.contains("error"),
  ).toBe(true);
  expect(container.querySelectorAll(".evidence-note")).toHaveLength(3);
  expect(getByText(i18n.t("toolCodemodeDetails"))).toBeTruthy();
  expect(getByText("script output")).toBeTruthy();
  expect(container.querySelector(".evidence-diff")).toBeNull();
});

it("keeps ledger-only model failures inspectable alongside normal Code Mode tools", () => {
  const tool = { ...call, id: "code", name: "codemode" };
  const result = projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: tool.id,
    isError: false,
    content: "script handled model failure",
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "code/1",
          name: "read",
          arguments: { path: "file.ts" },
          status: "ok",
        },
      ],
    },
    details: {
      calls: [
        { id: "code/1", name: "read", status: "ok" },
        {
          id: "code/models.classify/1",
          name: "models.classify",
          status: "error",
          error: "provider failed",
        },
      ],
    },
  });
  const { container, getByText } = render(
    view(snapshot({ tool, results: [result] })),
  );
  expect(container.querySelector('[data-tool="read"]')).toBeTruthy();
  const carrier = container.querySelector('[data-tool="codemode"]');
  expect(carrier).toBeTruthy();
  expect(carrier?.querySelector(".evidence-raw pre")?.textContent).toContain(
    "provider failed",
  );
  expect(getByText(i18n.t("toolNestedIncomplete"))).toBeTruthy();
});

it("renders real nested live results without duplicating the carrier and settles from persisted facts", () => {
  const tool = {
    ...call,
    id: "code",
    name: "codemode",
    arguments: '{"code":"Promise.all"}',
  };
  const nested = {
    ...call,
    id: "code/1",
    name: "read",
    arguments: '{"path":"file.ts"}',
  };
  const liveTools: LiveToolEvidence[] = [
    { call: tool, state: "running" },
    {
      call: nested,
      parentToolCallId: "code",
      state: "running",
      result: { content: "streamed output" },
    },
  ];
  const { container, rerender } = render(
    view(snapshot({ tool, liveTools, running: true })),
  );
  expect(container.querySelector('[data-tool="codemode"]')).toBeNull();
  expect(
    container.querySelector('[data-tool="read"]')?.getAttribute("data-state"),
  ).toBe("running");
  expect(container.textContent).toContain("streamed output");
  const result = projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: tool.id,
    isError: false,
    content: "done",
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: nested.id,
          name: nested.name,
          arguments: { path: "file.ts" },
          status: "ok",
        },
      ],
    },
  });
  rerender(view(snapshot({ tool, results: [result], liveTools })));
  expect(
    container.querySelector('[data-tool="read"]')?.getAttribute("data-state"),
  ).not.toBe("running");
  expect(container.querySelector('[data-tool="codemode"]')).toBeNull();
});

it("keeps active native child SSE bodies when the execution snapshot only lists pending top-level calls", () => {
  const tool = { ...call, id: "live-native-code", name: "codemode" };
  const child = { ...call, id: "live-native-code/1", name: "read" };
  const childResult = projectMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: child.id,
    isError: false,
    content: [
      { type: "text", text: "Exact live child body" },
      { type: "image", data: "fixture", mimeType: "image/png" },
    ],
  });
  const liveTools: LiveToolEvidence[] = [
    { call: tool, state: "running" },
    {
      call: child,
      parentToolCallId: tool.id,
      state: "returned",
      result: childResult,
    },
  ];
  const state: WebSnapshot = snapshot({ tool, liveTools, running: true });
  // getSessionExecution reconstructs pending native top-level calls, while
  // Host runtime.liveTools carries the observed nested events and bodies.
  state.selectedExecution = {
    sessionId: "session",
    sessionPath: "/session.jsonl",
    status: "running",
    liveTools: [{ call: tool, state: "running" }],
    liveToolsOmitted: 0,
  };
  const ui = render(view(state));
  expect(ui.container.textContent).toContain("Exact live child body");
  expect(ui.container.textContent).not.toContain(
    i18n.t("toolNestedOutputMissing"),
  );

  const result = projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: tool.id,
    isError: false,
    content: "wrapper",
    nestedCalls: {
      complete: true,
      calls: [{ id: child.id, name: "read", arguments: {}, status: "ok" }],
    },
  });
  const settled: WebSnapshot = snapshot({ tool, results: [result], liveTools });
  settled.selectedExecution = {
    ...state.selectedExecution,
    status: "idle",
    liveTools: [],
  };
  ui.rerender(view(settled));
  expect(ui.container.textContent).toContain("Exact live child body");
  expect(ui.container.textContent).not.toContain(
    i18n.t("toolNestedOutputMissing"),
  );

  // Another current controller (even a copied Session sharing the id) cannot
  // supply its live body to this historical projection.
  ui.rerender(view({ ...settled, currentSessionPath: "/other-copy.jsonl" }));
  expect(ui.container.textContent).not.toContain("Exact live child body");
  expect(ui.container.textContent).toContain(i18n.t("toolNestedOutputMissing"));
  // A fresh Host/reload with no observed body remains truthfully missing.
  ui.rerender(
    view({ ...settled, runtime: { ...settled.runtime, liveTools: [] } }),
  );
  expect(ui.container.textContent).not.toContain("Exact live child body");
  expect(ui.container.textContent).toContain(i18n.t("toolNestedOutputMissing"));
});

it("retains Code Mode wrapper failures and distinguishes cancelled child evidence after refresh", () => {
  const tool = { ...call, id: "code", name: "codemode" };
  const result = projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: tool.id,
    isError: true,
    content: "Script aborted",
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "code/1",
          name: "bash",
          arguments: { command: "long job" },
          status: "error",
        },
      ],
    },
    details: { calls: [{ id: "code/1", name: "bash", status: "cancelled" }] },
  });
  const { container } = render(view(snapshot({ tool, results: [result] })));
  const child = container.querySelector('[data-tool="bash"]');
  expect(child?.classList.contains("warn")).toBe(true);
  expect(child?.querySelector(".tool-action")?.textContent).toBe(
    i18n.t("toolActivity_cancelled", { action: i18n.t("toolAction_command") }),
  );
  expect(
    container
      .querySelector('[data-tool="codemode"]')
      ?.classList.contains("error"),
  ).toBe(true);
  expect(container.textContent).toContain("Script aborted");
});

it.each([false, true])(
  "shows incomplete nested evidence outside the raw disclosure (wrapper failure %s)",
  (isError) => {
    const tool = { ...call, id: "code", name: "codemode" };
    const result = projectMessage({
      role: "toolResult",
      toolName: "codemode",
      toolCallId: tool.id,
      isError,
      content: "partial record",
      nestedCalls: {
        complete: false,
        calls: [
          {
            id: "code/1",
            name: "read",
            arguments: { path: "file.ts" },
            status: "unfinished",
          },
        ],
      },
    });
    const { getByText } = render(view(snapshot({ tool, results: [result] })));
    const notice = getByText(i18n.t("toolNestedIncomplete"));
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.closest(".evidence-raw")).toBeNull();
    expect(notice.closest("[data-tool]")).toBeNull();
  },
);

it.each([
  ["bash", "lucide-square-terminal"],
  ["read", "lucide-book-open"],
  ["edit", "lucide-pencil"],
])(
  "matches a completed %s-first summary to its icon without reordering evidence",
  (first, icon) => {
    const tools = [
      first,
      ...["bash", "read", "edit"].filter((name) => name !== first),
    ].map((name) => ({
      ...call,
      id: name,
      name,
      arguments:
        name === "bash" ? call.arguments : '{"path":"/workspace/a.ts"}',
    }));
    const value = snapshot({
      results: tools.map((tool) => ({
        role: "toolResult",
        toolName: tool.name,
        toolCallId: tool.id,
        content: "Exact receipt",
        isError: false,
      })),
    });
    value.selectedSession.entries[1]!.message!.parts = tools;
    const { container } = render(view(value));
    const sequence =
      container.querySelector<HTMLDetailsElement>(".process-sequence")!;
    expect(sequence.open).toBe(false);
    expect(sequence.querySelector(`:scope > summary .${icon}`)).toBeTruthy();
    expect(sequence.querySelector(".process-sequence-title")?.textContent).toBe(
      i18n.t("toolGroup_done", {
        actions: tools
          .map((tool) =>
            i18n.t(
              `toolActionGroup_${tool.name === "bash" ? "command" : tool.name}`,
            ),
          )
          .join(i18n.t("toolGroupSeparator")),
      }),
    );
    expect(
      Array.from(sequence.querySelectorAll(".tool-evidence-card"), (card) =>
        card.getAttribute("data-tool"),
      ),
    ).toEqual(tools.map((tool) => tool.name));
    expect(
      sequence.querySelector(".tool-evidence-card > summary .tool-name"),
    ).toBeNull();
    expect(
      sequence.querySelector(
        '.tool-evidence-card[data-tool="read"] .evidence-content details code',
      )?.textContent,
    ).toBe("read");
  },
);

it("holds rapid active headlines together, updates the same call directly and settles immediately", () => {
  vi.useFakeTimers();
  const reader = {
    ...call,
    id: "reader",
    name: "read",
    arguments: '{"path":"/workspace/a.ts"}',
  };
  const editor = { ...reader, id: "editor", name: "edit" };
  const calls = [call, reader, editor];
  const frame = (active: number | undefined) => {
    const value = snapshot({
      running: active !== undefined,
      liveTools: calls.map((tool, index) => ({
        call: tool,
        state: active === index ? "running" : "returned",
        result: {
          role: "toolResult",
          toolName: tool.name,
          toolCallId: tool.id,
          content: "Exact receipt",
          isError: false,
        },
      })),
    });
    value.selectedSession.entries[1]!.message!.parts = calls;
    return view(value);
  };
  const rendered = render(frame(0));
  const sequence =
    rendered.container.querySelector<HTMLDetailsElement>(".process-sequence")!;
  const title = () =>
    sequence.querySelector(".process-sequence-title")?.textContent;
  expect(sequence.open).toBe(true);
  act(() => vi.advanceTimersByTime(100));
  rendered.rerender(frame(1));
  act(() => vi.advanceTimersByTime(100));
  rendered.rerender(frame(2));
  expect(title()).toBe(
    i18n.t("toolActivity_running", { action: i18n.t("toolAction_command") }),
  );
  expect(
    sequence.querySelector(":scope > summary .lucide-square-terminal"),
  ).toBeTruthy();
  expect(
    sequence
      .querySelector('.tool-evidence-card[data-tool="edit"]')
      ?.getAttribute("data-state"),
  ).toBe("running");
  act(() => vi.advanceTimersByTime(800));
  expect(title()).toBe(
    i18n.t("toolActivity_running", { action: i18n.t("toolAction_edit") }),
  );
  expect(
    sequence.querySelector(":scope > summary .lucide-pencil"),
  ).toBeTruthy();
  editor.arguments = '{"path":"/workspace/b.ts"}';
  rendered.rerender(frame(2));
  expect(sequence.querySelector(".process-sequence-preview")?.textContent).toBe(
    "b.ts",
  );
  rendered.rerender(frame(1));
  rendered.rerender(frame(undefined));
  expect(sequence.open).toBe(false);
  expect(sequence.getAttribute("data-status")).toBe("done");
  expect(title()).not.toContain(
    i18n.t("toolActivity_running", { action: i18n.t("toolAction_edit") }),
  );
  const settled = title();
  act(() => vi.advanceTimersByTime(1000));
  expect(title()).toBe(settled);
});

it("labels reading, searching, listing, editing, writing, browsing and commands consistently", () => {
  const tools = [
    "read",
    "grep",
    "ls",
    "edit",
    "write",
    "web_search",
    "bash",
  ].map((name) => ({
    ...call,
    id: name,
    name,
    arguments:
      '{"path":"/workspace/a.ts","query":"reference","command":"rg needle ."}',
  }));
  const value = snapshot({
    results: tools.map((tool) => ({
      role: "toolResult",
      toolName: tool.name,
      toolCallId: tool.id,
      content: "Exact receipt",
      isError: false,
    })),
  });
  value.selectedSession.entries[1]!.message!.parts = tools;
  const { container } = render(view(value));
  const tags = Array.from(
    container.querySelectorAll(".process-sequence-body .tool-kind"),
  );
  expect(tags.map((tag) => tag.textContent)).toEqual([
    "read",
    "search",
    "list",
    "edit",
    "write",
    "web",
    "run",
  ]);
  expect(tags.every((tag) => tag.getAttribute("aria-hidden") === "true")).toBe(
    true,
  );
  // A shell command remains a command, even when its contents invoke rg.
  expect(
    tags.at(-1)?.closest("summary")?.querySelector(".tool-action")?.textContent,
  ).toBe(i18n.t("toolActionDone_command"));
  expect(tags.map((tag) => tag.getAttribute("title"))).toEqual(
    tools.map((tool) => tool.name),
  );
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
    expect(
      container.querySelector(".process-sequence:not(.single-process)"),
    ).toBeNull();
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
    container.querySelector<HTMLDetailsElement>(".subagent-result-evidence")
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

it("keeps interleaved reasoning and tools in chronological groups separated by prose without changing native receipts", () => {
  const tools = [
    { ...call, id: "read", name: "read", arguments: '{"path":"a.ts"}' },
    { ...call, id: "write", name: "write", arguments: '{"path":"b.ts"}' },
    { ...call, id: "bash" },
  ];
  const results = tools.map((tool) => ({
    role: "toolResult",
    toolName: tool.name,
    toolCallId: tool.id,
    content: `Exact receipt for ${tool.id}`,
    isError: false,
  }));
  const value: WebSnapshot = snapshot({ running: true, results });
  value.preferences = {
    ...value.preferences,
    expandThinking: true,
    bashToolDisplay: "full",
    fileMutationDisplay: "full",
  };
  value.selectedSession!.entries[1]!.message!.parts = [
    { type: "thinking", text: "Inspect before reading" },
    tools[0]!,
    { type: "thinking", text: "Plan before writing" },
    tools[1]!,
    { type: "text", text: "The files are ready; verify next." },
    { type: "thinking", text: "Check before building" },
    tools[2]!,
  ];
  value.selectedSession!.entries.push({
    id: "current-thinking",
    type: "message",
    timestamp: "2026-09-26T10:00:03Z",
    message: {
      role: "assistant",
      content: "",
      parts: [{ type: "thinking", text: "Review the completed build" }],
    },
  });
  const original = JSON.stringify(value.selectedSession!.entries);
  const { container, getByText } = render(view(value));
  const sequences = Array.from(
    container.querySelectorAll<HTMLDetailsElement>(
      ".process-sequence:not(.single-process)",
    ),
  );
  expect(sequences).toHaveLength(2);
  const stepKinds = (sequence: HTMLElement) =>
    Array.from(
      sequence.querySelectorAll(".process-sequence-body > .process-step"),
      (step) =>
        step.querySelector(".thinking-line")
          ? step.querySelector(".thinking-evidence")?.textContent
          : step
              .querySelector(".tool-evidence-card")
              ?.getAttribute("data-tool"),
    );
  expect(stepKinds(sequences[0]!)).toEqual([
    "Inspect before reading",
    "read",
    "Plan before writing",
    "write",
  ]);
  expect(stepKinds(sequences[1]!)).toEqual([
    "Check before building",
    "bash",
    "Review the completed build",
  ]);
  const prose = getByText("The files are ready; verify next.");
  expect(prose.closest(".process-sequence")).toBeNull();
  expect(
    sequences[0]!.compareDocumentPosition(prose) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    prose.compareDocumentPosition(sequences[1]!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    Array.from(container.querySelectorAll(".thinking-line"), (thinking) =>
      thinking.classList.contains("running") ? "running" : "done",
    ),
  ).toEqual(["done", "done", "done", "running"]);
  expect(sequences[0]!.querySelector("summary")?.textContent).toContain(
    i18n.t("processThinkingCount", { count: 2 }),
  );
  expect(sequences[0]!.querySelector("summary")?.textContent).toContain(
    i18n.t("processToolCount", { count: 2 }),
  );
  expect(
    Array.from(container.querySelectorAll(".tool-evidence-card"), (card) =>
      card.getAttribute("data-state"),
    ),
  ).toEqual(["returned", "returned", "returned"]);
  for (const result of results)
    expect(container.textContent).toContain(result.content);
  expect(JSON.stringify(value.selectedSession!.entries)).toBe(original);
});

it("keeps default thinking folded as it streams and preserves an explicit expansion", async () => {
  const value: WebSnapshot = snapshot({ running: true });
  value.preferences.expandThinking = false;
  value.selectedSession!.entries[1]!.message!.parts = [
    { type: "thinking", text: "Inspecting implementation" },
  ];
  const rendered = render(view(value));
  const disclosure =
    rendered.container.querySelector<HTMLDetailsElement>(".thinking-line")!;
  expect(disclosure.open).toBe(false);
  const updated = structuredClone(value);
  updated.selectedSession!.entries[1]!.message!.parts = [
    {
      type: "thinking",
      text: "Inspecting implementation\n\nCheck the source.",
    },
  ];
  rendered.rerender(view(updated));
  expect(disclosure.open).toBe(false);
  fireEvent.click(disclosure.querySelector("summary")!);
  await waitFor(() => expect(disclosure.open).toBe(true));
  updated.runtime.status = "idle";
  updated.selectedSession!.entries[1]!.message!.stopReason = "stop";
  rendered.rerender(view(updated));
  expect(disclosure.open).toBe(true);
});

it("connects tools only to preceding thinking in the same native assistant message", () => {
  const value: WebSnapshot = snapshot();
  value.selectedSession!.entries[1]!.message!.parts = [
    { type: "thinking", text: "Inspect the source first" },
    call,
    { type: "thinking", text: "Then inspect the settings" },
    { ...call, id: "same-message", name: "read" },
    { type: "text", text: "A separate phase follows." },
    { ...call, id: "after-prose", name: "ls" },
  ];
  value.selectedSession!.entries.push(
    {
      id: "separate-thinking",
      type: "message",
      timestamp: "2026-09-26T10:00:03Z",
      message: {
        role: "assistant",
        content: "",
        parts: [{ type: "thinking", text: "An independent reasoning note" }],
      },
    },
    {
      id: "separate-tool",
      type: "message",
      timestamp: "2026-09-26T10:00:04Z",
      message: {
        role: "assistant",
        content: "",
        parts: [{ ...call, id: "other-message", name: "grep" }],
      },
    },
  );
  const original = JSON.stringify(value.selectedSession!.entries);
  const { container } = render(view(value));
  expect(
    Array.from(container.querySelectorAll(".process-step"), (step) => ({
      text: step.querySelector(".thinking-line .tool-summary")?.textContent,
      tool: step.querySelector("[data-tool]")?.getAttribute("data-tool"),
      connected: step.classList.contains("thought-tool-step"),
    })),
  ).toEqual([
    { text: "Inspect the source first", tool: undefined, connected: false },
    { text: undefined, tool: "bash", connected: true },
    {
      text: "Then inspect the settings",
      tool: undefined,
      connected: false,
    },
    { text: undefined, tool: "read", connected: true },
    { text: undefined, tool: "ls", connected: false },
    {
      text: "An independent reasoning note",
      tool: undefined,
      connected: false,
    },
    { text: undefined, tool: "grep", connected: false },
  ]);
  expect(JSON.stringify(value.selectedSession!.entries)).toBe(original);
});

it("preserves expanded recovered thinking and its DOM when a singleton gains a second process row", async () => {
  const value: WebSnapshot = snapshot();
  const thinking = {
    type: "thinking",
    text: "Thinking preview",
    sourcePartIndex: 3,
    textTruncated: true,
  } satisfies WebMessagePart;
  value.selectedSession!.entries[1]!.message!.parts = [thinking];
  const text = "Complete recovered reasoning, including the final line.";
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "assistant",
    partIndex: 3,
    text,
    nextCursor: null,
    totalChars: text.length,
  });
  const rendered = render(view(value));
  const sequence =
    rendered.container.querySelector<HTMLDetailsElement>(".process-sequence")!;
  const disclosure =
    rendered.container.querySelector<HTMLDetailsElement>(".thinking-line")!;
  expect(sequence.classList.contains("single-process")).toBe(true);
  fireEvent.click(disclosure.querySelector("summary")!);
  await waitFor(() => expect(rendered.container.textContent).toContain(text));
  const body = disclosure.querySelector(".thinking-evidence");
  const result = {
    role: "toolResult",
    toolName: call.name,
    toolCallId: call.id,
    content: "Exact completed build receipt",
    isError: false,
  } satisfies WebLiveMessage;
  const next: WebSnapshot = snapshot({ results: [result] });
  next.selectedSession!.entries[1]!.message!.parts = [thinking, call];
  const original = JSON.stringify(next.selectedSession!.entries);
  rendered.rerender(view(next));
  expect(rendered.container.querySelector(".process-sequence")).toBe(sequence);
  expect(sequence.classList.contains("single-process")).toBe(false);
  expect(rendered.container.querySelector(".thinking-line")).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(disclosure.querySelector(".thinking-evidence")).toBe(body);
  expect(body?.textContent).toContain(text);
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(
    "session",
    "/session.jsonl",
    "assistant",
    0,
    expect.any(AbortSignal),
    "thinking",
    3,
  );
  expect(
    sequence.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
  ).toBe("returned");
  expect(JSON.stringify(next.selectedSession!.entries)).toBe(original);
});

it.each([
  { reader: "middle", position: 180, following: false },
  { reader: "top return", position: 0, following: false },
  { reader: "bottom return", position: 540, following: true },
  { reader: "pending upward input", position: 540, following: false },
])(
  "preserves a singleton reasoning $reader through promotion and live output",
  ({ reader, position, following }) => {
    const text = `${"A complete reasoning line.\n".repeat(60)}Last reasoning line.`;
    const thinking = { type: "thinking", text } satisfies WebMessagePart;
    const stream = (content?: string) => {
      const value: WebSnapshot = snapshot({
        running: true,
        liveTools:
          content === undefined
            ? []
            : [
                {
                  call,
                  state: "running",
                  result: {
                    role: "toolResult",
                    toolName: call.name,
                    toolCallId: call.id,
                    content,
                  },
                },
              ],
      });
      value.preferences.expandThinking = true;
      value.selectedSession!.entries[1]!.message!.parts =
        content === undefined ? [thinking] : [thinking, call];
      return view(value);
    };
    const rendered = render(stream());
    const sequence =
      rendered.container.querySelector<HTMLDetailsElement>(
        ".process-sequence",
      )!;
    const disclosure =
      sequence.querySelector<HTMLDetailsElement>(".thinking-line")!;
    const body = disclosure.querySelector<HTMLElement>(".thinking-evidence")!;
    const scroller = sequence.querySelector<HTMLElement>(
      ".process-sequence-scroll",
    )!;
    let thoughtTop = 0;
    let groupTop = 0;
    let height = 1200;
    Object.defineProperties(body, {
      clientHeight: {
        get: () => (sequence.classList.contains("single-process") ? 360 : 900),
      },
      scrollHeight: { get: () => 900 },
      offsetTop: { get: () => 40 },
      scrollTop: {
        get: () => Math.min(thoughtTop, 900 - body.clientHeight),
        set: (top: number) => {
          thoughtTop = Math.max(0, Math.min(top, 900 - body.clientHeight));
        },
      },
    });
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 360 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => groupTop,
        set: (top: number) => {
          groupTop = Math.max(0, Math.min(top, height - 360));
        },
      },
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 100, 800, 360),
    );
    vi.spyOn(body, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 140 - groupTop, 800, 360),
    );
    expect(disclosure.open).toBe(true);
    body.scrollTop = 540;
    fireEvent.scroll(body);
    fireEvent.wheel(body, { deltaY: -100 });
    if (reader !== "pending upward input") {
      body.scrollTop = 180;
      fireEvent.scroll(body);
    }
    body.scrollTop = position;
    fireEvent.scroll(body);
    rendered.rerender(stream("First native tool delta"));
    expect(rendered.container.querySelector(".process-sequence")).toBe(
      sequence,
    );
    expect(sequence.classList.contains("single-process")).toBe(false);
    expect(sequence.querySelector(".thinking-line")).toBe(disclosure);
    expect(disclosure.querySelector(".thinking-evidence")).toBe(body);
    expect(disclosure.open).toBe(true);
    expect(body.textContent).toContain("Last reasoning line.");
    // The body starts 40px below the group viewport; only a bottom return follows.
    expect(scroller.scrollTop).toBe(following ? height - 360 : 40 + position);
    expect(body.scrollTop).toBe(0);
    height = 1400;
    rendered.rerender(stream("Second native tool delta"));
    expect(scroller.scrollTop).toBe(following ? height - 360 : 40 + position);
    expect(body.scrollTop).toBe(0);
    expect(
      sequence.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
    ).toBe("running");
  },
);

it("retains an earlier phase's exact running tool status while only the current phase opens and follows", () => {
  const second = { ...call, id: "current-tool" };
  const value: WebSnapshot = snapshot({
    running: true,
    liveTools: [
      { call, state: "running" },
      { call: second, state: "running" },
    ],
  });
  value.selectedSession!.entries[1]!.message!.parts = [
    { type: "thinking", text: "Start the first task" },
    call,
    { type: "text", text: "Start the next task while the first is running." },
    { type: "thinking", text: "Start the second task" },
    second,
  ];
  const original = JSON.stringify(value.selectedSession!.entries);
  const rendered = render(view(value));
  const sequences = Array.from(
    rendered.container.querySelectorAll<HTMLDetailsElement>(
      ".process-sequence:not(.single-process)",
    ),
  );
  expect(sequences).toHaveLength(2);
  expect(sequences[0]!.open).toBe(false);
  expect(sequences[1]!.open).toBe(true);
  expect(sequences[0]!.getAttribute("data-status")).toBe("running");
  expect(
    sequences[0]!
      .querySelector("summary > .status-mark")
      ?.getAttribute("aria-label"),
  ).toBe(i18n.t("toolState_running"));
  const scrollers = sequences.map(
    (sequence) =>
      sequence.querySelector<HTMLElement>(".process-sequence-scroll")!,
  );
  let height = 900;
  for (const scroller of scrollers)
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 360 },
      scrollHeight: { get: () => height },
    });
  scrollers[0]!.scrollTop = 100;
  height = 1100;
  rendered.rerender(view({ ...value, generatedAt: "2026-09-26T10:00:05Z" }));
  expect(scrollers[0]!.scrollTop).toBe(100);
  expect(scrollers[1]!.scrollTop).toBe(height);
  expect(
    Array.from(
      rendered.container.querySelectorAll(".tool-evidence-card"),
      (card) => card.getAttribute("data-state"),
    ),
  ).toEqual(["running", "running"]);
  expect(JSON.stringify(value.selectedSession!.entries)).toBe(original);
});

it.each(["wheel", "ArrowUp", "PageUp", "Home", "Shift+Space"])(
  "pauses the inner process stream on %s before scroll delivery and resumes only on a downward bottom return",
  (input) => {
    const second = { ...call, id: "tool-2" };
    const stream = (content: string) => {
      const value: WebSnapshot = snapshot({
        running: true,
        liveTools: [
          { call, state: "returned" },
          {
            call: second,
            state: "running",
            result: {
              role: "toolResult",
              toolName: second.name,
              toolCallId: second.id,
              content,
            },
          },
        ],
      });
      value.preferences.bashToolDisplay = "full";
      value.selectedSession!.entries[1]!.message!.parts = [call, second];
      return view(value);
    };
    const rendered = render(stream("First live output"));
    const scroller = rendered.container.querySelector<HTMLElement>(
      ".process-sequence-scroll",
    )!;
    let height = 900;
    let top = 0;
    const setTop = vi.fn((value: number) => {
      top = Math.max(0, Math.min(value, height - 360));
    });
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 360 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: setTop },
    });
    rendered.rerender(stream("Second live output"));
    expect(scroller.scrollTop).toBe(540);
    setTop.mockClear();
    if (input === "wheel") fireEvent.wheel(scroller, { deltaY: -7 });
    else
      fireEvent.keyDown(scroller, {
        key: input === "Shift+Space" ? " " : input,
        shiftKey: input === "Shift+Space",
      });
    rendered.rerender(stream("Third live output"));
    expect(rendered.container.textContent).toContain("Third live output");
    expect(setTop).not.toHaveBeenCalled();
    scroller.scrollTop = 533;
    fireEvent.scroll(scroller);
    setTop.mockClear();
    height = 910;
    rendered.rerender(stream("Fourth live output"));
    expect(scroller.scrollTop).toBe(533);
    expect(setTop).not.toHaveBeenCalled();
    fireEvent.scroll(scroller);
    rendered.rerender(stream("Fifth live output"));
    expect(scroller.scrollTop).toBe(533);
    expect(setTop).not.toHaveBeenCalled();
    expect(scroller.hasAttribute("data-scroll-below")).toBe(true);
    scroller.scrollTop = height - scroller.clientHeight;
    fireEvent.scroll(scroller);
    height = 1000;
    rendered.rerender(stream("Sixth live output"));
    expect(scroller.scrollTop).toBe(640);
    expect(scroller.hasAttribute("data-scroll-below")).toBe(false);
    expect(
      rendered.container
        .querySelectorAll(".tool-evidence-card")[1]
        ?.getAttribute("data-state"),
    ).toBe("running");
  },
);

it("follows resize-only process growth at the bottom while preserving an upward reader", () => {
  const resized = new Map<Element, ResizeObserverCallback>();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        resized.set(element, this.callback);
      }
      disconnect = disconnect;
    },
  );
  try {
    const value: WebSnapshot = snapshot({ running: true });
    value.selectedSession!.entries[1]!.message!.parts = [
      call,
      { ...call, id: "tool-2" },
    ];
    const rendered = render(view(value));
    const scroller = rendered.container.querySelector<HTMLElement>(
      ".process-sequence-scroll",
    )!;
    const body = scroller.querySelector<HTMLElement>(".process-sequence-body")!;
    let height = 900;
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 360 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - 360));
        },
      },
    });
    const resize = resized.get(body);
    expect(resize).toBeDefined();
    act(() => resize?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(540);
    height = 1000;
    act(() => resize?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(640);
    fireEvent.wheel(scroller, { deltaY: -10 });
    scroller.scrollTop = 630;
    fireEvent.scroll(scroller);
    height = 1100;
    act(() => resize?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(630);
    expect(scroller.hasAttribute("data-scroll-below")).toBe(true);
    scroller.scrollTop = height - scroller.clientHeight;
    fireEvent.scroll(scroller);
    height = 1200;
    act(() => resize?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(840);
    expect(scroller.hasAttribute("data-scroll-below")).toBe(false);
    rendered.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
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
    expect(
      container.querySelector(".process-sequence:not(.single-process)"),
    ).toBeNull();
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
  expect(
    rendered.container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
  expect(
    rendered.container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
  expect(
    rendered.container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
  expect(
    container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
  expect(
    rendered.container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
  expect(
    container.querySelectorAll(".process-sequence:not(.single-process)"),
  ).toHaveLength(0);
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
    container
      .querySelector(".process-sequence:not(.single-process)")
      ?.getAttribute("data-status"),
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
  expect(
    container.querySelector(".process-sequence:not(.single-process)"),
  ).toBeNull();
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
          .querySelector(".process-sequence:not(.single-process)")
          ?.getAttribute("data-status"),
      ).toBe("warn");
    else
      expect(
        container.querySelector(".process-sequence:not(.single-process)"),
      ).toBeNull();
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
    container
      .querySelector(".process-sequence:not(.single-process)")
      ?.getAttribute("data-status"),
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
    expect(
      container.querySelector(".process-sequence:not(.single-process)"),
    ).toBeNull();
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
