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
