// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { ToolEvidence } from "../../web/ui/src/features/transcript/ToolEvidence.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import * as clipboard from "../../web/ui/src/lib/clipboard.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();

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
  ).toContain("9+new");
  expect(
    screen.getByRole("figure", { name: "Test evidence" }).textContent,
  ).toContain("1 failed");
  expect(
    container.querySelector('[data-tool="bash"][data-state="cancelled"]'),
  ).toBeTruthy();
  expect(
    screen.getByText(i18n.t("toolState_cancelled"), {
      selector: ".evidence-status",
    }),
  ).toBeTruthy();
  expect(container.querySelectorAll(".diff-added").length).toBe(1);
  expect(screen.getAllByText(i18n.t("toolRawEvidence"))).toHaveLength(4);
});

it("shows confirmed created-file counts in both disclosures and copies the exact patch", async () => {
  const diff =
    "--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+const value = 1;\n+++value;\n+export { value };\n";
  const copy = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const open = vi.fn();
  const { container } = render(
    createElement(
      ArtifactContext.Provider,
      {
        value: { open },
      },
      createElement(ToolEvidence, {
        call: {
          type: "toolCall",
          id: "write-created",
          name: "write",
          arguments: '{"path":"new.ts"}',
        },
        result: {
          content: "Successfully wrote",
          isError: false,
          details: { change: "created", diff },
        },
        defaultOpen: true,
      }),
    ),
  );
  const summary = container.querySelector(".tool-evidence-card > summary")!;
  expect(summary.textContent).toContain("File created");
  expect(summary.textContent).toContain("new.ts+3−0");
  expect(summary.querySelector("button, a")).toBeNull();
  const figure = screen.getByRole("figure", { name: "Change diff" });
  expect(figure.querySelector("figcaption")?.textContent).toContain(
    "new.ts+3−0",
  );
  expect(
    [...figure.querySelectorAll(".diff-added .evidence-line-number")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["1", "2", "3"]);
  expect(figure.textContent).toContain("++value;");
  fireEvent.click(screen.getByRole("button", { name: "new.ts" }));
  expect(open).toHaveBeenCalledWith("new.ts");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(diff));
  expect(
    screen.getByRole("button", { name: i18n.t("copiedCode") }),
  ).toBeTruthy();
});

it("keeps native edit line numbers separate from code and counts every changed line", () => {
  const { container } = render(
    createElement(ToolEvidence, {
      call: {
        type: "toolCall",
        name: "edit",
        arguments: '{"path":"counter.ts"}',
      },
      result: {
        content: "Edited",
        isError: false,
        details: {
          diff: "  40 before\n- 41 old\n+ 41 new\n+ 42 ++counter\n  42 after\n    ...",
        },
      },
      defaultOpen: true,
    }),
  );
  expect(container.querySelector("summary")?.textContent).toContain("+2−1");
  const rows = [...container.querySelectorAll(".evidence-diff-row")];
  expect(
    rows.map((row) => row.querySelector(".evidence-line-number")?.textContent),
  ).toEqual(["40", "41", "41", "42", "42", ""]);
  expect(rows[3]?.textContent).toContain("++counter");
  expect(rows.at(-1)?.textContent).toContain("...");
});

it("labels truncated diff counts as partial and exposes copy failures without losing the patch", async () => {
  vi.spyOn(clipboard, "copyText").mockResolvedValue(false);
  const diff =
    "--- a/large.ts\n+++ b/large.ts\n@@ -0,0 +1,400 @@\n" +
    "+new\n".repeat(400);
  const { container } = render(
    createElement(ToolEvidence, {
      call: {
        type: "toolCall",
        name: "write",
        arguments: '{"path":"large.ts"}',
      },
      result: {
        content: "Written",
        isError: false,
        details: { diff, change: "created" },
      },
      defaultOpen: true,
    }),
  );
  expect(
    container.querySelector("summary .evidence-summary-meta")?.textContent,
  ).toContain(i18n.t("gitReviewPartialLabel"));
  expect(container.querySelectorAll(".diff-added").length).toBeLessThan(400);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      i18n.t("copyCodeFailed"),
    ),
  );
  expect(screen.getByRole("figure", { name: "Change diff" })).toBeTruthy();
});

it.each(["failed", "cancelled", "unknown", "running"] as const)(
  "does not present a successful diff for %s evidence",
  (state) => {
    const { container } = render(
      createElement(ToolEvidence, {
        call: {
          type: "toolCall",
          name: "write",
          arguments:
            '{"path":"private.txt","content":"requested new contents"}',
        },
        result: {
          content: "No confirmed change",
          isError: state === "failed" || state === "cancelled",
          ...(state === "unknown"
            ? { forkSnapshotToolResult: true as const }
            : {}),
          details: { change: "created", diff: "+1 requested new contents" },
        },
        liveState: state,
      }),
    );
    expect(container.querySelector(".evidence-summary-meta")).toBeNull();
    expect(container.querySelector(".evidence-diff")).toBeNull();
    expect(container.querySelector("details")?.getAttribute("data-state")).toBe(
      state,
    );
  },
);

it("expands a file summary without nested controls and opens the resolved file through the active artifact context", () => {
  const open = vi.fn();
  const { container } = render(
    createElement(
      ArtifactContext.Provider,
      { value: { open } },
      createElement(ToolEvidence, {
        call: {
          type: "toolCall",
          name: "read",
          arguments: JSON.stringify({ path: "report.md" }),
          evidenceArguments: {
            path: "report.md",
            resolvedPath: "/workspace/report.md",
          },
        },
        result: { content: "report", isError: false },
      }),
    ),
  );

  const summary = container.querySelector(".tool-evidence-card > summary")!;
  expect(summary.textContent).toContain("report.md");
  expect(summary.querySelector("button, a, input, [tabindex]")).toBeNull();
  fireEvent.click(summary);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "/workspace/report.md" }));
  expect(open).toHaveBeenCalledWith("/workspace/report.md");
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
  expect(
    screen.getByRole("complementary", { name: "File preview" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  await waitFor(() => expect(release).toHaveBeenCalledWith("s", "h"));
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("restores the original opener after nested preview navigation and ignores stale copy feedback", async () => {
  vi.spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValueOnce({ handle: "root" })
    .mockResolvedValueOnce({ handle: "nested" });
  vi.spyOn(WebClient.prototype, "artifactPreview")
    .mockResolvedValueOnce({
      artifact: {
        handle: "root",
        sessionId: "s",
        path: "/workspace/root.md",
        name: "root.md",
        revision: "a".repeat(64),
        bytes: 24,
        preview: "text",
      },
      text: "[Nested](./nested.md)",
      truncated: false,
    })
    .mockResolvedValueOnce({
      artifact: {
        handle: "nested",
        sessionId: "s",
        path: "/workspace/nested.md",
        name: "nested.md",
        revision: "b".repeat(64),
        bytes: 7,
        preview: "text",
      },
      text: "# Inner",
      truncated: false,
    });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  let finishCopy: (() => void) | undefined;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      ),
    },
  });
  try {
    render(
      createElement(
        ArtifactProvider,
        { sessionId: "s" },
        createElement(Markdown, null, "[Open](./root.md)"),
      ),
    );
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Nested" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));
    fireEvent.click(screen.getByRole("button", { name: "Nested" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Inner" })).toBeTruthy(),
    );
    await act(async () => finishCopy?.());
    expect(screen.queryByText("File path copied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
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

it("polls metadata with backoff, retains changed text until refresh, and stops on close", async () => {
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
    const opener = screen.getByRole("button", { name: "Report" });
    opener.focus();
    await act(async () => {
      fireEvent.click(opener);
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
    expect(preview).toHaveBeenCalledTimes(1);
    expect(screen.getByText(i18n.t("filesContentChanged"))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));
    });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    });
    act(() => vi.advanceTimersToNextFrame());
    expect(document.activeElement).toBe(opener);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
