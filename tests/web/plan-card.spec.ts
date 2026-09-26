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
import {
  projectMessage,
  type WebLiveMessage,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const markdown =
  "# Export plan\n\n## Scope\n\n- [ ] Export **Markdown** only\n\n- [x] Review scope\n\n[unsafe](javascript:alert(1))";
const result = (plan = markdown) =>
  projectMessage({
    role: "toolResult",
    toolName: "plan_ready",
    toolCallId: "plan-1",
    isError: false,
    content: [
      {
        type: "text",
        text: `Plan ready for explicit user action. No implementation has started.\n\n${plan}`,
      },
    ],
    details: { status: "ready", plan },
  });
const call: WebLiveMessage = {
  role: "assistant",
  content: "",
  parts: [
    {
      type: "toolCall",
      id: "plan-1",
      name: "plan_ready",
      arguments: JSON.stringify({ plan: "# Unaccepted proposal" }),
    },
  ],
};
const truncation = {
  bytes: 0,
  maxBytes: 4194304,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};
function transcript(
  messages: WebLiveMessage[],
  live: WebLiveMessage[] = [],
  active = true,
) {
  const snapshot: WebSnapshot = {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-19T00:00:00Z",
    cursor: 1,
    currentSessionId: active ? "session" : "other",
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation,
    selectedSession: {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      bytes: 1,
      truncation,
      entries: messages.map((message, index) => ({
        type: "message",
        id: String(index),
        timestamp: "2026-09-19T00:00:00Z",
        message,
      })),
    },
  };
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot,
      liveMessages: live.map((message, index) => ({
        key: `live-${index}`,
        message,
      })),
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
}

it("renders one readable plan from the successful result through live delivery and history refresh", () => {
  const view = render(transcript([call], [result()]));
  expect(
    screen.getAllByRole("region", { name: i18n.t("planCardLabel") }),
  ).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Export plan" })).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Unaccepted proposal" }),
  ).toBeNull();
  expect(screen.getByText("unsafe").closest("a")).toBeNull();
  expect(
    screen
      .getByRole("checkbox", { name: "Export Markdown only" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText(i18n.t("planCardNotApproval"))).toBeTruthy();
  view.rerender(transcript([call, result()], [result()]));
  expect(
    screen.getAllByRole("region", { name: i18n.t("planCardLabel") }),
  ).toHaveLength(1);
  view.rerender(transcript([call, result()], [], false));
  expect(screen.getByRole("heading", { name: "Export plan" })).toBeTruthy();
});

it("keeps the next thinking-only message visible after a completed ask_user with no body text", () => {
  const asked: WebLiveMessage = {
    role: "assistant",
    content: "",
    parts: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: "{}" }],
  };
  const answered: WebLiveMessage = {
    role: "toolResult",
    toolName: "ask_user",
    toolCallId: "ask",
    isError: false,
    content: "User answered: JSON",
  };
  const next: WebLiveMessage = {
    role: "assistant",
    content: "",
    parts: [{ type: "thinking", text: "Investigating the export plan" }],
  };
  render(transcript([asked, answered], [next]));
  expect(
    screen.getByText("Investigating the export plan", { selector: "pre" }),
  ).toBeTruthy();
});

it("does not relocate the answer bubble while plan arguments stream after it", () => {
  const next: WebLiveMessage = {
    role: "assistant",
    content: "Your choice is JSON.",
    parts: [{ type: "text", text: "Your choice is JSON." }],
  };
  const view = render(transcript([], [next]));
  const answer = screen.getByText("Your choice is JSON.").closest("article");
  const stream: WebLiveMessage = {
    ...next,
    parts: [
      ...next.parts!,
      {
        type: "toolCall",
        id: "ready",
        name: "plan_ready",
        arguments: '{"plan":"# Export',
      },
    ],
  };
  view.rerender(transcript([], [stream]));
  expect(screen.getByText("Your choice is JSON.").closest("article")).toBe(
    answer,
  );
  expect(view.container.querySelector("article")).toBe(answer);
});

it("keeps answered tool evidence mounted and open as a snapshot absorbs live messages", () => {
  const asked: WebLiveMessage = {
    role: "assistant",
    timestamp: 100,
    content: "",
    parts: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: "{}" }],
  };
  const answered: WebLiveMessage = {
    role: "toolResult",
    toolName: "ask_user",
    toolCallId: "ask",
    content: "User answered: - export_format: Markdown",
  };
  const feedback: WebLiveMessage = {
    role: "custom",
    timestamp: 110,
    customType: "openpi-web-command-feedback",
    content: "Planning started",
  };
  const next: WebLiveMessage = {
    role: "assistant",
    timestamp: 200,
    content: "Preparing the plan.",
    parts: [{ type: "text", text: "Preparing the plan." }],
  };
  const live = [feedback, answered, next];
  const view = render(transcript([asked], live));
  const evidence = screen
    .getByText(answered.content, { selector: "pre" })
    .closest("details")!;
  fireEvent.click(evidence.querySelector("summary")!);
  expect(evidence.open).toBe(true);
  view.rerender(transcript([asked, answered], live));
  expect(
    screen.getByText(answered.content, { selector: "pre" }).closest("details"),
  ).toBe(evidence);
  expect(evidence.open).toBe(true);
});

it("does not let invisible custom messages create moving empty rows around ask_user", () => {
  const ghost: WebLiveMessage = {
    role: "custom",
    timestamp: 100,
    customType: "plan-mode-armed",
    content: "Model instructions",
  };
  const hidden: WebLiveMessage = {
    ...ghost,
    timestamp: 110,
    customType: "openpi-web-command-feedback",
    display: false,
  };
  const answer: WebLiveMessage = {
    role: "toolResult",
    toolName: "ask_user",
    toolCallId: "ask",
    content: "User answered: Markdown",
  };
  const view = render(transcript([], [ghost, hidden, answer]));
  expect(view.container.querySelectorAll("article")).toHaveLength(1);
  view.rerender(transcript([answer], [ghost, hidden, answer]));
  expect(view.container.querySelectorAll("article")).toHaveLength(1);
});

it("keeps native message identity across snapshot refreshes without hiding identical text in a later turn", () => {
  const first = projectMessage({
    role: "assistant",
    timestamp: 100,
    content: [{ type: "text", text: "Understood." }],
  });
  const next = projectMessage({
    role: "assistant",
    timestamp: 200,
    content: [{ type: "text", text: "Understood." }],
  });
  const view = render(transcript([first], [next]));
  expect(screen.getAllByText("Understood.")).toHaveLength(2);
  const bubble = screen.getAllByText("Understood.")[1]!.closest("article");
  view.rerender(transcript([first, next], [next]));
  expect(screen.getAllByText("Understood.")).toHaveLength(2);
  expect(screen.getAllByText("Understood.")[1]!.closest("article")).toBe(
    bubble,
  );
  view.rerender(transcript([first, next]));
  expect(screen.getAllByText("Understood.")[1]!.closest("article")).toBe(
    bubble,
  );
});

it("renders a saved result whose original tool call was omitted from the snapshot", () => {
  render(transcript([result()]));
  expect(screen.getByRole("heading", { name: "Export plan" })).toBeTruthy();
});

it.each([
  undefined,
  { ...result(), isError: true, content: "Plan rejected by the runtime." },
  { ...result(), isError: undefined },
  {
    ...result(),
    details: { status: "cancelled" },
    content: "Plan completion cancelled.",
  },
  { ...result(), details: { status: "ready", plan: " " } },
])(
  "does not turn proposed, failed, partial, cancelled or invalid output into a ready plan (%#)",
  (receipt) => {
    render(transcript([call, ...(receipt ? [receipt] : [])]));
    expect(
      screen.queryByRole("region", { name: i18n.t("planCardLabel") }),
    ).toBeNull();
    if (receipt?.isError)
      expect(screen.getAllByText(receipt.content).length).toBeGreaterThan(0);
  },
);

it("keeps full structured plans when only the duplicate text projection was shortened", () => {
  const plan = `# Long plan\n${"Step. ".repeat(2300)}\nEND OF PLAN`;
  const receipt = result(plan);
  expect(receipt.truncation?.text).toBe(true);
  render(transcript([call, receipt]));
  expect(screen.getByText(/END OF PLAN/)).toBeTruthy();
  expect(screen.queryByText(i18n.t("planCardTruncated"))).toBeNull();
});

it("labels bounded output as a preview when the protocol omitted oversized structured details", () => {
  const receipt = result(`# Large plan\n${"内容".repeat(6000)}`);
  expect(receipt.truncation?.details).toBe(true);
  render(transcript([call, receipt]));
  expect(screen.getByRole("heading", { name: "Large plan" })).toBeTruthy();
  expect(screen.getByText(i18n.t("planCardTruncated"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("planCardReady"))).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("planCardCopyPreview") }),
  ).toBeTruthy();
});

it("collapses without approving and copies the actual plan with explicit copy feedback", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  try {
    const view = render(transcript([call, result()]));
    const toggle = screen.getByRole("button", {
      name: new RegExp(i18n.t("planCardReady")),
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("heading", { name: "Export plan" })).toBeNull();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("planCardCopy") }),
      ),
    );
    expect(writeText).toHaveBeenCalledWith(markdown);
    expect(screen.getByRole("status").textContent).toBe(
      i18n.t("copiedMessage"),
    );
    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "Export plan" })).toBeTruthy();
    expect(
      view.container.querySelector(".plan-card-evidence")?.textContent,
    ).toContain("Plan ready for explicit user action");
  } finally {
    vi.unstubAllGlobals();
  }
});
