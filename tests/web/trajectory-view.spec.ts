// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Trajectory } from "../../web/ui/src/features/trajectory/Trajectory.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
function snapshot(count: number): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "now",
    cursor: 0,
    preferences: { theme: "system" },
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4000000,
      bytes: 0,
    },
    selectedSession: {
      id: "s",
      path: "/s.jsonl",
      cwd: "/",
      bytes: 0,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 2000000,
      },
      entries: Array.from({ length: count }, (_, index) => ({
        id: `u${index}`,
        type: "message",
        timestamp: "now",
        message: { role: "user", content: `Prompt ${index}` },
      })),
    },
  };
}
function view(count: number, key = "s") {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Trajectory, {
      key,
      snapshot: snapshot(count),
      running: false,
    }),
  );
}
afterEach(cleanup);

function evidenceView(value: WebSnapshot, running = false) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Trajectory, { snapshot: value, running }),
  );
}

function evidenceSnapshot() {
  const value = snapshot(0);
  value.selectedSession!.entries = [
    {
      id: "u",
      type: "message",
      timestamp: "2026-10-12T00:00:00Z",
      message: { role: "user", content: "Check the project" },
    },
    {
      id: "a",
      type: "message",
      timestamp: "2026-10-12T00:00:01Z",
      message: {
        role: "assistant",
        content: "",
        parts: [
          { type: "thinking", text: "Inspect the existing files." },
          {
            type: "toolCall",
            id: "exact-call",
            name: "bash",
            arguments: '{"command":"pwd"}',
          },
        ],
      },
    },
    {
      id: "r",
      type: "message",
      timestamp: "2026-10-12T00:00:02Z",
      message: {
        role: "toolResult",
        toolCallId: "exact-call",
        toolName: "bash",
        content: "unique-result-from-workspace",
        isError: false,
        details: { exitCode: 0 },
      },
    },
    { id: "change1", type: "model_change", timestamp: "2026-10-12T00:00:03Z" },
    {
      id: "change2",
      type: "thinking_level_change",
      timestamp: "2026-10-12T00:00:04Z",
    },
  ];
  return value;
}

it("retains the selected record while saved history grows and resets on Session remount", () => {
  const rendered = render(view(60));
  const first =
    rendered.container.querySelector<HTMLButtonElement>(".trajectory-record");
  expect(first).toBeTruthy();
  fireEvent.click(first!);
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain("Prompt 10");
  rendered.rerender(view(100));
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain("Prompt 10");
  rendered.rerender(view(5, "different-session"));
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain("Prompt 4");
  expect(screen.queryByText("Prompt 10")).toBeNull();
});

it("inspects exact arguments and results in independent tabs and keeps the chosen tab on append", () => {
  const value = evidenceSnapshot();
  const rendered = render(evidenceView(value));
  const inspector = rendered.container.querySelector(".trajectory-inspector")!;
  expect(inspector.textContent).toContain("pwd");
  expect(inspector.textContent).toContain("unique-result-from-workspace");
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryResultTab") }),
  );
  expect(screen.getByRole("tabpanel").textContent).not.toContain("pwd");
  expect(screen.getByRole("tabpanel").textContent).toContain(
    "unique-result-from-workspace",
  );
  const appended = {
    ...value,
    selectedSession: {
      ...value.selectedSession!,
      entries: [
        ...value.selectedSession!.entries,
        {
          id: "finish",
          type: "message" as const,
          timestamp: "now",
          message: { role: "assistant", content: "Finished" },
        },
      ],
    },
  };
  const call = rendered.container.querySelector<HTMLButtonElement>(
    ".trajectory-record.call",
  )!;
  fireEvent.click(call);
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryResultTab") }),
  );
  rendered.rerender(evidenceView(appended));
  expect(
    screen
      .getByRole("tab", { name: i18n.t("trajectoryResultTab") })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("tabpanel").textContent).toContain(
    "unique-result-from-workspace",
  );
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("trajectoryInputTab") }),
  );
  expect(screen.getByRole("tabpanel").textContent).toContain("pwd");
  expect(screen.getByRole("tabpanel").textContent).not.toContain(
    "unique-result-from-workspace",
  );
});

it("folds consecutive metadata in place, localizes its title, and retains the native type for inspection", () => {
  const rendered = render(evidenceView(evidenceSnapshot()));
  const fold = rendered.container.querySelector<HTMLDetailsElement>(
    ".trajectory-event-group details",
  )!;
  expect(fold.open).toBe(false);
  expect(fold.textContent).toContain(i18n.t("trajectoryEvent_model_change"));
  fireEvent.click(fold.querySelector("summary")!);
  fireEvent.click(
    screen.getByText(i18n.t("trajectoryEvent_model_change"), { exact: true }),
  );
  expect(fold.open).toBe(true);
  expect(
    rendered.container.querySelector(".trajectory-inspector h2")?.textContent,
  ).toBe(i18n.t("trajectoryEvent_model_change"));
  fireEvent.click(screen.getByText(i18n.t("trajectoryRecordInfo")));
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain("model_change");
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain(i18n.t("trajectoryEventOnly"));
});

it("searches native results and reasoning as well as names, clears without losing identity, and handles no match", () => {
  const rendered = render(evidenceView(evidenceSnapshot()));
  const search = screen.getByRole("searchbox", {
    name: i18n.t("trajectorySearch"),
  });
  fireEvent.change(search, { target: { value: "unique-result" } });
  expect(
    rendered.container.querySelectorAll(".trajectory-record"),
  ).toHaveLength(1);
  expect(screen.getByRole("tabpanel").textContent).toContain("pwd");
  fireEvent.change(search, { target: { value: "Inspect the existing" } });
  expect(
    rendered.container.querySelectorAll(".trajectory-record"),
  ).toHaveLength(1);
  expect(
    rendered.container.querySelector(".trajectory-inspector")?.textContent,
  ).toContain("Inspect the existing files.");
  expect(
    rendered.container.querySelector(".trajectory-group-heading")?.textContent,
  ).toContain("Check the project");
  fireEvent.change(search, { target: { value: "not-in-the-session" } });
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByText(i18n.t("trajectoryNoMatches"))).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  expect(
    rendered.container.querySelectorAll(".trajectory-record"),
  ).toHaveLength(5);
});

it("keeps a missing receipt uncertain even while the Session is active", () => {
  const value = evidenceSnapshot();
  value.selectedSession!.entries = value.selectedSession!.entries.filter(
    (entry) => entry.id !== "r",
  );
  render(evidenceView(value, true));
  expect(screen.getByRole("tabpanel").textContent).toContain(
    i18n.t("trajectoryMissingResult"),
  );
  expect(screen.getByRole("status").textContent).toBe(
    i18n.t("trajectoryRunning"),
  );
  expect(screen.getByRole("tabpanel").textContent).not.toContain(
    i18n.t("trajectory_returned"),
  );
});

it("search preserves native prompt boundaries and also finds arguments outside the compact target", () => {
  const value = evidenceSnapshot();
  value.selectedSession!.entries = [
    ...value.selectedSession!.entries,
    {
      id: "u2",
      type: "message",
      timestamp: "now",
      message: { role: "user", content: "A separate question" },
    },
    {
      id: "a2",
      type: "message",
      timestamp: "now",
      message: {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "toolCall",
            id: "second-call",
            name: "bash",
            arguments: '{"command":"pwd","cwd":"unique-cwd-argument"}',
          },
        ],
      },
    },
  ];
  const rendered = render(evidenceView(value));
  const search = screen.getByRole("searchbox", {
    name: i18n.t("trajectorySearch"),
  });
  fireEvent.change(search, { target: { value: "pwd" } });
  expect(rendered.container.querySelectorAll(".trajectory-group")).toHaveLength(
    2,
  );
  const headings = rendered.container.querySelectorAll<HTMLButtonElement>(
    ".trajectory-group-heading",
  );
  fireEvent.click(headings[0]!);
  fireEvent.click(headings[1]!);
  expect(headings[0]!.textContent).toContain("Check the project");
  expect(headings[1]!.textContent).toContain("A separate question");
  fireEvent.change(search, { target: { value: "unique-cwd-argument" } });
  expect(rendered.container.querySelectorAll(".trajectory-group")).toHaveLength(
    1,
  );
  expect(
    rendered.container.querySelector(".trajectory-group-heading")?.textContent,
  ).toContain("A separate question");
  expect(screen.getByRole("tabpanel").textContent).toContain(
    "unique-cwd-argument",
  );
});
