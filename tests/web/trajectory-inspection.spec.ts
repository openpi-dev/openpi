// @vitest-environment jsdom
import {
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
import { Trajectory } from "../../web/ui/src/features/trajectory/Trajectory.tsx";
import { TrajectoryPayload } from "../../web/ui/src/features/trajectory/TrajectoryPayload.tsx";
import {
  trajectoryRangeKeys,
  trajectoryTimeline,
} from "../../web/ui/src/features/trajectory/timeline.ts";
import { trajectoryRecords } from "../../web/ui/src/features/trajectory/trajectory.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

const entries: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [
  {
    id: "u",
    type: "message",
    timestamp: "2026-10-14T00:00:00Z",
    message: { role: "user", content: "Inspect tools" },
  },
  {
    id: "a",
    type: "message",
    timestamp: "2026-10-14T00:00:01Z",
    message: {
      role: "assistant",
      content: "",
      provider: "fixture",
      model: "fixture-model",
      usage: { input: 100, cacheRead: 900, output: 30 },
      parts: [
        {
          type: "toolCall",
          id: "code",
          name: "codemode",
          arguments:
            '{"code":"text(await tools.bash({command: \'git status\'}));"}',
        },
      ],
    },
  },
  {
    id: "r",
    type: "message",
    timestamp: "2026-10-14T00:00:02Z",
    message: {
      role: "toolResult",
      toolName: "codemode",
      toolCallId: "code",
      content: "outer output",
      isError: false,
      nestedCalls: {
        complete: true,
        calls: [
          {
            call: {
              type: "toolCall",
              id: "code/1",
              name: "bash",
              arguments: '{"command":"git status"}',
            },
            status: "ok",
            durationMs: 1234,
          },
        ],
      },
    },
  },
  {
    id: "failed",
    type: "message",
    timestamp: "2026-10-14T00:00:03Z",
    message: {
      role: "assistant",
      content: "",
      stopReason: "error",
      errorMessage: "malformed stream",
    },
  },
];
function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "now",
    cursor: 0,
    preferences: { theme: "light" },
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      bytes: 0,
      maxBytes: 4000000,
    },
    selectedSession: {
      id: "s",
      path: "/s.jsonl",
      cwd: "/",
      bytes: 0,
      entries,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 2000000,
      },
    },
  };
}
function view(value = snapshot()) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Trajectory, { snapshot: value, running: false }),
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retains tool-only responses and native child durations without inventing child output or start time", () => {
  const records = trajectoryRecords(entries);
  expect(records.map((record) => record.key)).toEqual([
    "u",
    "a",
    "a:call:0",
    "a:call:0:nested:code/1",
    "failed",
  ]);
  expect(records[3]).toMatchObject({
    parentKey: "a:call:0",
    durationMs: 1234,
    outcome: "returned",
    missingOutput: true,
  });
  expect(records[3]?.result).toBeUndefined();
  expect(records[3]?.timestamp).toBeUndefined();
  expect(records[2]?.result?.content).toBe("outer output");
  expect(trajectoryRangeKeys(records, { start: 2.5, end: 3.2 })).toEqual(
    new Set(["a:call:0", "a:call:0:nested:code/1"]),
  );
});

it("keeps a successful tool outcome separate from its response's error status", () => {
  const failed = entries.map((entry) =>
    entry.id === "a"
      ? {
          ...entry,
          message: { ...entry.message!, stopReason: "error" as const },
        }
      : entry,
  );
  const spans = trajectoryTimeline(trajectoryRecords(failed));
  expect(spans.find((span) => span.key === "a")?.error).toBe(true);
  expect(spans.find((span) => span.key === "a:call:0")?.error).toBe(false);
  expect(
    spans.find((span) => span.key === "a:call:0:nested:code/1")?.error,
  ).toBe(false);
});

it.each(["cancelled", "timed_out"] as const)(
  "retains a native nested %s state in the inspector",
  (state) => {
    const value = structuredClone(snapshot());
    value.currentSessionPath = value.selectedSession!.path;
    value.selectedSession!.entries[2]!.message!.nestedCalls = undefined;
    value.runtime.liveTools = [
      {
        call: {
          type: "toolCall",
          id: "code/1",
          name: "bash",
          arguments: '{"command":"git status"}',
        },
        parentToolCallId: "code",
        state,
        result: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "code/1",
          content: "terminal evidence",
          isError: true,
          terminalReceipt: { state },
        },
      },
    ];
    expect(
      trajectoryRecords(
        value.selectedSession!.entries,
        value.runtime.liveTools,
      )[3]?.state,
    ).toBe(state);
    const rendered = render(view(value));
    fireEvent.click(
      rendered.container.querySelector(
        'li[data-nested="true"] .trajectory-record',
      )!,
    );
    expect(
      rendered.container.querySelector(
        ".trajectory-inspector > .trajectory-outcome",
      )?.textContent,
    ).toBe(i18n.t(`toolState_${state}`));
  },
);

it("shows a nested success independently of a later model failure and reports recorded timing only", () => {
  const rendered = render(view());
  const child = rendered.container.querySelector<HTMLButtonElement>(
    'li[data-nested="true"] .trajectory-record',
  )!;
  expect(child.textContent).toContain("1.23 s");
  fireEvent.click(child);
  expect(screen.getByRole("tabpanel").textContent).toContain(
    i18n.t("trajectoryNestedOutputMissing"),
  );
  expect(screen.getByRole("tabpanel").textContent).not.toContain(
    "outer output",
  );
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryTimingTab") }),
  );
  expect(screen.getByRole("tabpanel").textContent).toContain("1.23 s");
  expect(screen.getByRole("tabpanel").textContent).toContain(
    i18n.t("trajectoryNotRecorded"),
  );
  expect(
    rendered.container.querySelector('[data-response-error="true"]'),
  ).toBeTruthy();
});

it("opens per-response usage through keyboard overview selection and keeps exact JSON inspectable", () => {
  const rendered = render(view());
  fireEvent.keyDown(
    rendered.container.querySelector('[data-record-key="a"]')!,
    { key: "Enter" },
  );
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryUsageTab") }),
  );
  expect(screen.getByRole("tabpanel").textContent).toContain("fixture-model");
  expect(screen.getByRole("tabpanel").textContent).toContain("900");
  fireEvent.click(rendered.container.querySelector(".trajectory-record.call")!);
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryInputTab") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("trajectoryRawArguments") }),
  );
  expect(screen.getByRole("tabpanel").querySelector("pre")?.textContent).toBe(
    entries[1]!.message!.parts![0]!.type === "toolCall"
      ? entries[1]!.message!.parts![0]!.arguments
      : "",
  );
});

it("copies exact source including whitespace while highlighting and wrapping remain display-only", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const text = "  text('<script>original</script>');\n\n";
  try {
    const rendered = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(TrajectoryPayload, { text, code: true }),
      ),
    );
    await waitFor(() =>
      expect(rendered.container.querySelector("code span")).toBeTruthy(),
    );
    expect(rendered.container.querySelector("pre")?.textContent).toBe(text);
    expect(rendered.container.querySelector("script")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("trajectoryWrap") }),
    );
    expect(
      rendered.container
        .querySelector(".trajectory-payload")
        ?.getAttribute("data-wrap"),
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("trajectoryCopy") }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    rendered.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(TrajectoryPayload, { text: "next", code: false }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: i18n.t("trajectoryCopied") }),
    ).toBeNull();
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
