// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, Fragment, type ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WebGitReviewSnapshot,
  WebGitReviewSource,
} from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { parseDiffRows } from "../../web/ui/src/features/review/DiffCodePreview.tsx";
import { ReviewPanel } from "../../web/ui/src/features/review/ReviewPanel.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not reload the selected diff for an unchanged snapshot revision", async () => {
  const readFile = vi.fn(async () => snapshot.files[0]);
  const makePanel = (revision: string) =>
    withI18n(
      createElement(ReviewPanel, {
        review: {
          result: {
            ok: true,
            snapshot: {
              ...snapshot,
              revision,
              files: snapshot.files.map((file) => ({
                ...file,
                diff: "",
                diffLoaded: false,
              })),
            },
          },
          loading: false,
          error: null,
          refresh: async () => {},
          readFile,
        },
        initialFilePath: snapshot.files[0]!.path,
        onClose: () => {},
      }),
    );
  const { rerender } = render(makePanel("unchanged"));
  await act(async () => {});
  expect(readFile).toHaveBeenCalledTimes(1);
  rerender(makePanel("unchanged"));
  await act(async () => {});
  expect(readFile).toHaveBeenCalledTimes(1);
  rerender(makePanel("changed"));
  await act(async () => {});
  expect(readFile).toHaveBeenCalledTimes(2);
});

const snapshot: WebGitReviewSnapshot = {
  repositoryRoot: "/workspace",
  currentBranch: "feature/review",
  baseBranch: "main",
  comparison: "branch",
  revision: "a".repeat(64),
  additions: 8,
  deletions: 3,
  truncated: false,
  files: [
    {
      path: "src/features/review/very-long-file-name.tsx",
      status: "modified",
      additions: 1,
      deletions: 1,
      diffTruncated: false,
      diff: [
        "diff --git a/src/features/review/very-long-file-name.tsx b/src/features/review/very-long-file-name.tsx",
        "--- a/src/features/review/very-long-file-name.tsx",
        "+++ b/src/features/review/very-long-file-name.tsx",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    },
    {
      path: "new-file.ts",
      status: "untracked",
      additions: 7,
      deletions: 2,
      diffTruncated: false,
      diff: "@@ -0,0 +1,1 @@\n+export const value = true;",
    },
  ],
};

function withI18n(element: ReactElement) {
  return createElement(I18nextProvider, { i18n }, element);
}

it("does not invent a numbered context row from a trailing diff newline", () => {
  expect(parseDiffRows("@@ -1 +1 @@\n-old\n+new\n")).toEqual([
    { id: 0, kind: "meta", marker: "", code: "@@ -1 +1 @@" },
    { id: 1, kind: "removed", oldLine: 1, marker: "-", code: "old" },
    { id: 2, kind: "added", newLine: 1, marker: "+", code: "new" },
  ]);
});

it("switches from the changed-file list to a separate full-height diff view", async () => {
  const onClose = vi.fn();
  const refresh = vi.fn(async () => {});
  const { container } = render(
    withI18n(
      createElement(ReviewPanel, {
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh,
        },
        onClose,
      }),
    ),
  );
  expect(screen.getByText("feature/review compared with main")).toBeTruthy();
  expect(container.querySelectorAll(".session-review-file")).toHaveLength(2);
  const first = container.querySelector<HTMLButtonElement>(
    ".session-review-file",
  )!;
  fireEvent.click(first);
  expect(container.querySelector(".session-review-list")).toBeNull();
  expect(
    screen.getByRole("region", {
      name: /src\/features\/review\/very-long-file-name\.tsx/u,
    }),
  ).toBeTruthy();
  const diff = screen.getByRole("figure", { name: "Change diff" });
  expect(diff.textContent).toContain("old");
  expect(diff.textContent).toContain("new");
  expect(
    container.querySelectorAll(".review-diff-gutter").length,
  ).toBeGreaterThan(0);
  fireEvent.click(
    screen.getByRole("button", { name: "Back to changed files" }),
  );
  expect(container.querySelectorAll(".session-review-file")).toHaveLength(2);
  const close = screen.getByRole("button", { name: "Close" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>(".session-review-file"),
    ),
  );
  fireEvent.keyDown(close, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("returns to the original row and scroll position before Escape closes its Workbar ancestor", async () => {
  const onClose = vi.fn();
  const { container } = render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "review",
        requestRevision: 0,
        sessionId: "session-a",
        cwd: "/workspace",
        capabilities: {},
        messages: [],
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onBeforeArtifactOpen: () => {},
        onClose,
      }),
    ),
  );
  const body = container.querySelector<HTMLDivElement>(".review-body")!;
  body.scrollTop = 112;
  fireEvent.click(
    container.querySelector<HTMLButtonElement>(".session-review-file")!,
  );
  const preview = screen.getByRole("region", {
    name: /src\/features\/review\/very-long-file-name\.tsx/u,
  });
  fireEvent.keyDown(preview, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("figure", { name: "Change diff" })).toBeNull();
  const row = container.querySelector<HTMLButtonElement>(
    ".session-review-file",
  )!;
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(container.querySelector(".review-body")?.scrollTop).toBe(112);
  fireEvent.keyDown(row, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it.each(["collapsed", "inactive tab", "inert"] as const)(
  "does not restore focus into a $0 Workbar before its return frame",
  async (state) => {
    const node = (visible: boolean, launcherOpen: boolean) =>
      createElement(
        Providers,
        null,
        createElement(
          Fragment,
          null,
          createElement("textarea", { "aria-label": "draft" }),
          createElement(WorkbarPanel, {
            visible,
            requestedTool: launcherOpen ? "launcher" : "review",
            requestRevision: launcherOpen ? 1 : 0,
            sessionId: "session-a",
            cwd: "/workspace",
            capabilities: {},
            messages: [],
            review: {
              result: { ok: true, snapshot },
              loading: false,
              error: null,
              refresh: async () => {},
            },
            conversationCollapsed: false,
            onRestoreConversation: () => {},
            onBeforeArtifactOpen: () => {},
            onClose: () => {},
          }),
        ),
      );
    const { container, rerender } = render(node(true, false));
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".session-review-file")!,
    );
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    fireEvent.keyDown(
      screen.getByRole("region", {
        name: /src\/features\/review\/very-long-file-name\.tsx/u,
      }),
      { key: "Escape" },
    );
    expect(frames).toHaveLength(1);
    if (state === "inert")
      container.querySelector(".workbar-panel")!.setAttribute("inert", "");
    else rerender(node(state !== "collapsed", state === "inactive tab"));
    const input = screen.getByRole("textbox", { name: "draft" });
    input.focus();
    await act(async () => {
      for (const frame of frames) frame(0);
    });
    expect(document.activeElement).toBe(input);
  },
);

it("does not carry a failed lazy diff into an inline file preview", async () => {
  const readFile = vi
    .fn()
    .mockRejectedValue(new Error("First diff unavailable"));
  const data = {
    ...snapshot,
    files: snapshot.files.map((file, index) =>
      index === 0 ? { ...file, diff: "", diffLoaded: false } : file,
    ),
  };
  const node = (path: string) =>
    withI18n(
      createElement(ReviewPanel, {
        initialFilePath: path,
        embedded: true,
        review: {
          result: { ok: true, snapshot: data },
          loading: false,
          error: null,
          refresh: async () => {},
          readFile,
        },
        onClose: () => {},
      }),
    );
  const { rerender } = render(node(snapshot.files[0]!.path));
  await screen.findByText("First diff unavailable");
  rerender(node(snapshot.files[1]!.path));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("export const value");
  expect(readFile).toHaveBeenCalledOnce();
});

it.each([
  { source: "staged" as const, revision: snapshot.revision },
  { source: "unstaged" as const, revision: "next-revision" },
])(
  "does not reuse a detail error for source $source and revision $revision",
  async ({ source, revision }) => {
    const readFile = vi
      .fn()
      .mockRejectedValue(new Error("Previous diff unavailable"));
    const node = (
      nextSource: WebGitReviewSource,
      nextRevision: string,
      inline: boolean,
    ) =>
      withI18n(
        createElement(ReviewPanel, {
          initialFilePath: snapshot.files[0]!.path,
          embedded: true,
          review: {
            result: {
              ok: true,
              snapshot: {
                ...snapshot,
                revision: nextRevision,
                comparison: nextSource,
                files: snapshot.files.map((file) => ({
                  ...file,
                  diff: inline ? file.diff : "",
                  diffLoaded: inline,
                })),
              },
            },
            source: nextSource,
            loading: false,
            error: null,
            refresh: async () => {},
            readFile,
          },
          onClose: () => {},
        }),
      );
    const { rerender } = render(node("unstaged", snapshot.revision, false));
    await screen.findByText("Previous diff unavailable");
    rerender(node(source, revision, true));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("figure", { name: "Change diff" }).textContent,
    ).toContain("new");
    expect(readFile).toHaveBeenCalledOnce();
  },
);

it("does not display a previous source's cached detail while the next source loads", async () => {
  let finish!: (file: (typeof snapshot.files)[number]) => void;
  const readFile = vi
    .fn()
    .mockResolvedValueOnce({
      ...snapshot.files[0],
      diffLoaded: true,
      diff: "@@ -0,0 +1 @@\n+unstaged version",
    })
    .mockImplementationOnce(
      () =>
        new Promise<(typeof snapshot.files)[number]>((resolve) => {
          finish = resolve;
        }),
    );
  const node = (source: WebGitReviewSource) =>
    withI18n(
      createElement(ReviewPanel, {
        initialFilePath: snapshot.files[0]!.path,
        embedded: true,
        review: {
          result: {
            ok: true,
            snapshot: {
              ...snapshot,
              comparison: source,
              files: snapshot.files.map((file) => ({
                ...file,
                diff: "",
                diffLoaded: false,
              })),
            },
          },
          source,
          loading: false,
          error: null,
          refresh: async () => {},
          readFile,
        },
        onClose: () => {},
      }),
    );
  const { rerender } = render(node("unstaged"));
  expect(
    (await screen.findByRole("figure", { name: "Change diff" })).textContent,
  ).toContain("unstaged version");
  rerender(node("staged"));
  expect(screen.queryByRole("figure", { name: "Change diff" })).toBeNull();
  expect(readFile).toHaveBeenCalledTimes(2);
  await act(async () =>
    finish({
      ...snapshot.files[0]!,
      diffLoaded: true,
      diff: "@@ -0,0 +1 @@\n+staged version",
    }),
  );
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("staged version");
});

it("refreshes the list and preview, retains its diff on failure, and disables duplicate refreshes", async () => {
  const refresh = vi.fn(async () => {});
  const node = (loading: boolean, error: string | null) =>
    withI18n(
      createElement(
        Fragment,
        null,
        createElement("textarea", { "aria-label": "draft" }),
        createElement(ReviewPanel, {
          embedded: true,
          review: {
            result: { ok: true, snapshot },
            loading,
            error,
            refresh,
          },
          onClose: () => {},
        }),
      ),
    );
  const { container, rerender } = render(node(false, null));
  const refreshButton = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("gitReviewRefresh"),
  });
  expect(refreshButton.title).toBe(i18n.t("gitReviewRefresh"));
  fireEvent.click(refreshButton);
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(
    container.querySelector<HTMLButtonElement>(".session-review-file")!,
  );
  fireEvent.click(refreshButton);
  expect(refresh).toHaveBeenCalledTimes(2);
  const input = screen.getByRole("textbox", { name: "draft" });
  input.focus();
  rerender(node(true, null));
  expect(refreshButton.disabled).toBe(true);
  fireEvent.click(refreshButton);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("figure", { name: "Change diff" })).toBeTruthy();
  expect(document.activeElement).toBe(input);
  rerender(node(false, "Refresh unavailable"));
  expect(screen.getByRole("alert").textContent).toContain(
    "Refresh unavailable",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    i18n.t("gitReviewOlderResult"),
  );
  expect(screen.getByRole("figure", { name: "Change diff" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("gitReviewRetry") }),
  );
  expect(refresh).toHaveBeenCalledTimes(3);
  rerender(node(false, null));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(input);
});

it("does not steal composer focus when a refreshed snapshot removes the selected file", () => {
  const node = (data: WebGitReviewSnapshot) =>
    withI18n(
      createElement(
        Fragment,
        null,
        createElement("textarea", { "aria-label": "draft" }),
        createElement(ReviewPanel, {
          embedded: true,
          initialFilePath: snapshot.files[0]!.path,
          review: {
            result: { ok: true, snapshot: data },
            loading: false,
            error: null,
            refresh: async () => {},
          },
          onClose: () => {},
        }),
      ),
    );
  const { rerender } = render(node(snapshot));
  const input = screen.getByRole("textbox", { name: "draft" });
  input.focus();
  rerender(
    node({ ...snapshot, revision: "removed", files: [snapshot.files[1]!] }),
  );
  expect(screen.queryByRole("figure", { name: "Change diff" })).toBeNull();
  expect(document.activeElement).toBe(input);
  rerender(node(snapshot));
  expect(screen.getByRole("figure", { name: "Change diff" })).toBeTruthy();
  expect(document.activeElement).toBe(input);
});

it("opens a selected popover file directly in the dedicated preview", () => {
  render(
    withI18n(
      createElement(ReviewPanel, {
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh: vi.fn(async () => {}),
        },
        initialFilePath: "new-file.ts",
        onClose: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("region", { name: /new-file\.ts/u })).toBeTruthy();
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("export const value");
});

it("does not steal composer focus when the selected diff refreshes", () => {
  const node = (data: WebGitReviewSnapshot) =>
    withI18n(
      createElement(
        Fragment,
        null,
        createElement("textarea", { "aria-label": "draft" }),
        createElement(ReviewPanel, {
          review: {
            result: { ok: true, snapshot: data },
            loading: false,
            error: null,
            refresh: vi.fn(async () => {}),
          },
          initialFilePath: "new-file.ts",
          onClose: vi.fn(),
          embedded: true,
        }),
      ),
    );
  const { rerender } = render(node(snapshot));
  const input = screen.getByRole("textbox", { name: "draft" });
  input.focus();
  rerender(
    node({ ...snapshot, files: snapshot.files.map((file) => ({ ...file })) }),
  );
  expect(document.activeElement).toBe(input);
});

it("distinguishes Git read failures from an empty repository state", () => {
  const refresh = vi.fn(async () => {});
  render(
    withI18n(
      createElement(ReviewPanel, {
        review: {
          result: { ok: false, reason: "not_git_repository" },
          loading: false,
          error: null,
          refresh,
        },
        onClose: vi.fn(),
      }),
    ),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "This workspace is not a Git repository.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("keeps hidden diff reads and focus dormant, then cancels a read when hidden again", async () => {
  let finish!: (file: (typeof snapshot.files)[number]) => void;
  const readFile = vi.fn(
    (_path: string, _signal: AbortSignal) =>
      new Promise<(typeof snapshot.files)[number]>((resolve) => {
        finish = resolve;
      }),
  );
  const node = (active: boolean, selectedPath: string) =>
    withI18n(
      createElement(
        Fragment,
        null,
        createElement("textarea", { "aria-label": "draft" }),
        createElement(ReviewPanel, {
          active,
          embedded: true,
          initialFilePath: selectedPath,
          onClose: () => {},
          review: {
            result: {
              ok: true,
              snapshot: {
                ...snapshot,
                files: snapshot.files.map((file) => ({
                  ...file,
                  diff: "",
                  diffLoaded: false,
                })),
              },
            },
            loading: false,
            error: null,
            refresh: async () => {},
            readFile,
          },
        }),
      ),
    );
  const { rerender } = render(node(false, snapshot.files[0]!.path));
  const input = screen.getByRole("textbox", { name: "draft" });
  input.focus();
  rerender(node(false, "new-file.ts"));
  expect(readFile).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  rerender(node(true, "new-file.ts"));
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: /new-file\.ts/u }),
  );
  const signal = readFile.mock.calls[0]![1];
  rerender(node(false, "new-file.ts"));
  input.focus();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(snapshot.files[1]!));
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("figure", { name: "Change diff" })).toBeNull();
  rerender(node(true, "new-file.ts"));
  expect(readFile).toHaveBeenCalledTimes(2);
});
