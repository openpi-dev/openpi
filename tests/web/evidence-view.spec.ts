// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
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
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
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
it("preserves Windows paths through sanitization without allowing unsafe schemes", async () => {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockRejectedValue(new Error("test"));
  render(
    createElement(
      ArtifactProvider,
      { sessionId: "s" },
      createElement(
        Markdown,
        null,
        "[Forward](C:/work/report%20demo.md) [Back](C:\\work\\report.md) [Bad](javascript:alert%281%29)",
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() =>
    expect(resolve).toHaveBeenCalledWith(
      "s",
      "C:/work/report%20demo.md",
      undefined,
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(resolve).toHaveBeenCalledWith(
      "s",
      "C:\\work\\report.md",
      undefined,
      expect.any(AbortSignal),
    ),
  );
  expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
});
it("keeps real relative paths intact even when they resemble encoded Windows links", () => {
  const open = vi.fn();
  render(
    createElement(
      ArtifactContext.Provider,
      { value: { open } },
      createElement(
        Markdown,
        null,
        "[Plain](./__openpi_windows__/report.md) [Encoded](./__openpi_windows__/C%3A%2Fwork%2Freport.md) ![Preview](./__openpi_windows__/image.png)",
      ),
    ),
  );
  for (const [name, path] of [
    ["Plain", "./__openpi_windows__/report.md"],
    ["Encoded", "./__openpi_windows__/C%3A%2Fwork%2Freport.md"],
    ["[image: Preview]", "./__openpi_windows__/image.png"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(open).toHaveBeenLastCalledWith(path, undefined);
  }
});

it("polls metadata with backoff, rereads changes and refreshes, and stops on close", async () => {
  vi.useFakeTimers();
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValue({ handle: "h" });
  const preview = vi
    .spyOn(WebClient.prototype, "artifactPreview")
    .mockResolvedValue({
      identity: "one",
      artifact: {
        handle: "h",
        sessionId: "s",
        path: "/report.md",
        name: "report.md",
        revision: "a".repeat(64),
        bytes: 1,
        preview: "text",
      },
      text: "first",
      truncated: false,
    });
  const metadata = vi
    .spyOn(WebClient.prototype, "artifactMetadata")
    .mockResolvedValue({ identity: "one" });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  try {
    render(
      createElement(
        ArtifactProvider,
        { sessionId: "s" },
        createElement(Markdown, null, "[Report](./report.md)"),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Report" }));
    });
    expect(preview).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(metadata).toHaveBeenCalledTimes(1);
    metadata.mockResolvedValue({ identity: "two" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(preview).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(3);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
