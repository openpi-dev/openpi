// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolEvidence } from "../../web/ui/src/features/transcript/ToolEvidence.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders file context, exact diffs, TAP failures, terminal cancellation and sanitized raw evidence", () => {
  const rows = [
    {
      name: "read",
      args: { path: "report.md", offset: 9 },
      result: { content: "line one\nline two", isError: false },
    },
    {
      name: "edit",
      args: { path: "report.md" },
      result: {
        content: "edited",
        isError: false,
        details: { diff: "-9 old\n+9 new" },
      },
    },
    {
      name: "bash",
      args: { command: "node --test" },
      result: {
        content:
          "not ok 1 - broken\n# tests 1\n# pass 0\n# fail 1\nCommand exited with code 1",
        isError: true,
      },
    },
    {
      name: "bash",
      args: { command: "sleep" },
      result: { content: "Command aborted", isError: true },
    },
  ];
  const { container } = render(
    createElement(
      "div",
      null,
      rows.map((row) =>
        createElement(ToolEvidence, {
          key: row.name + JSON.stringify(row.args),
          call: {
            type: "toolCall",
            name: row.name,
            arguments: JSON.stringify(row.args),
          },
          result: row.result,
        }),
      ),
    ),
  );
  for (const summary of container.querySelectorAll("summary"))
    fireEvent.click(summary);
  expect(
    screen.getByRole("figure", { name: "File content" }).textContent,
  ).toContain("9line one");
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("+9 new");
  expect(
    screen.getByRole("figure", { name: "Test evidence" }).textContent,
  ).toContain("1 failed");
  expect(screen.getByText("cancelled")).toBeTruthy();
  expect(container.querySelectorAll(".diff-added").length).toBe(1);
  expect(
    screen.getAllByText("Raw arguments and result (sanitized)"),
  ).toHaveLength(4);
});

it("opens local links using authenticated API and stops preview reads on close", async () => {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValue({ handle: "h" });
  const read = vi
    .spyOn(WebClient.prototype, "artifactPreview")
    .mockResolvedValue({
      artifact: {
        handle: "h",
        sessionId: "s",
        path: "/workspace/report.md",
        name: "report.md",
        revision: "a".repeat(64),
        bytes: 10,
        preview: "text",
      },
      text: "# Actual report",
      truncated: false,
    });
  const release = vi
    .spyOn(WebClient.prototype, "releaseArtifact")
    .mockResolvedValue({});
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "s" },
      createElement(Markdown, null, "[Report](./report.md)"),
    ),
  );
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Report" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Actual report" })).toBeTruthy(),
  );
  expect(resolve).toHaveBeenCalledWith(
    "s",
    "./report.md",
    undefined,
    expect.any(AbortSignal),
  );
  expect(screen.getByRole("dialog", { name: "File preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  await waitFor(() => expect(release).toHaveBeenCalledWith("s", "h"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
