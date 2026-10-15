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
import {
  WorkbarReadingContext,
  type WorkbarReadingState,
} from "../../web/ui/src/features/workbar/workbar-reading-state.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps real branch choices available after a missing base, searches them and restores keyboard focus", async () => {
  const choose = vi.fn();
  render(
    createElement(
      Providers,
      null,
      createElement(ReviewPanel, {
        embedded: true,
        onClose: () => {},
        review: {
          result: {
            ok: false,
            reason: "base_branch_unavailable",
            branches: {
              currentBranch: "feature",
              truncated: false,
              options: [
                { ref: "refs/heads/release", label: "release" },
                { ref: "refs/remotes/origin/release", label: "origin/release" },
              ],
            },
          },
          source: "branch",
          setBaseRef: choose,
          loading: false,
          error: null,
          refresh: async () => {},
        },
      }),
    ),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    i18n.t("gitReviewBaseUnavailable"),
  );
  const trigger = screen.getByRole("button", {
    name: i18n.t("gitReviewBaseBranch"),
  });
  fireEvent.click(trigger);
  const search = await screen.findByRole("searchbox", {
    name: i18n.t("gitReviewSearchBranches"),
  });
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.change(search, { target: { value: "origin" } });
  const option = screen.getByRole("option", { name: /origin\/release/u });
  expect(screen.queryByRole("option", { name: /^release/u })).toBeNull();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(option);
  fireEvent.click(option);
  expect(choose).toHaveBeenCalledWith("refs/remotes/origin/release");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("keeps the branch trigger through loading but clears the previous base's diff", async () => {
  const branches = {
    currentBranch: "feature",
    options: [
      { ref: "refs/heads/release", label: "release" },
      { ref: "refs/heads/main", label: "main" },
    ],
    truncated: false,
  };
  const node = (baseRef: string, loading: boolean) =>
    createElement(
      Providers,
      null,
      createElement(ReviewPanel, {
        embedded: true,
        onClose: () => {},
        review: {
          source: "branch",
          baseRef,
          setBaseRef: () => {},
          loading,
          error: null,
          refresh: async () => {},
          result: loading
            ? null
            : {
                ok: true,
                branches,
                snapshot: {
                  ...snapshot,
                  comparison: "branch",
                  baseBranch: baseRef,
                },
              },
        },
      }),
    );
  const { rerender } = render(node("refs/heads/release", false));
  fireEvent.click(
    screen.getByRole("button", { name: snapshot.files[0]!.path }),
  );
  expect(screen.getByRole("figure").textContent).toContain("new");
  const trigger = screen.getByRole("button", {
    name: i18n.t("gitReviewBaseBranch"),
  });
  trigger.focus();
  rerender(node("refs/heads/main", true));
  expect(screen.queryByRole("figure")).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("gitReviewBaseBranch") }),
  ).toBe(trigger);
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-busy")).toBe("true");
});

function wideReviewContainer() {
  let resize = (_width: number) => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private callback: (
          entries: { contentRect: { width: number } }[],
        ) => void,
      ) {}
      observe(element: Element) {
        if (!element.classList.contains("review-panel")) return;
        resize = (width) => this.callback([{ contentRect: { width } }]);
        resize(900);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return (width: number) => act(() => resize(width));
}

it("starts a newly selected wide diff at the top but keeps the current file's reading position", () => {
  wideReviewContainer();
  const { container } = render(
    withI18n(
      createElement(ReviewPanel, {
        embedded: true,
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh: async () => {},
        },
        onClose: () => {},
      }),
    ),
  );
  const preview = container.querySelector<HTMLElement>(".review-file-preview")!;
  preview.scrollTop = 480;
  fireEvent.scroll(preview);
  fireEvent.click(
    screen.getByRole("button", { name: snapshot.files[0]!.path }),
  );
  expect(preview.scrollTop).toBe(480);
  fireEvent.click(
    screen.getByRole("button", { name: snapshot.files[1]!.path }),
  );
  expect(screen.getByRole("figure").textContent).toContain(
    "export const value",
  );
  expect(container.querySelector(".review-file-preview")).toBe(preview);
  expect(preview.scrollTop).toBe(0);
});

it("starts a newly selected lazy diff at the top after its exact detail resolves", async () => {
  wideReviewContainer();
  let resolve!: (file: (typeof snapshot.files)[number]) => void;
  const readFile = vi.fn(
    () =>
      new Promise<(typeof snapshot.files)[number]>((done) => {
        resolve = done;
      }),
  );
  const data = {
    ...snapshot,
    files: [
      snapshot.files[0]!,
      { ...snapshot.files[1]!, diff: "", diffLoaded: false },
    ],
  };
  const { container } = render(
    withI18n(
      createElement(ReviewPanel, {
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
    ),
  );
  const preview = container.querySelector<HTMLElement>(".review-file-preview")!;
  preview.scrollTop = 480;
  fireEvent.scroll(preview);
  fireEvent.click(
    screen.getByRole("button", { name: snapshot.files[1]!.path }),
  );
  expect(readFile).toHaveBeenCalledOnce();
  expect(preview.scrollTop).toBe(0);
  await act(async () => resolve({ ...snapshot.files[1]!, diffLoaded: true }));
  expect(screen.getByRole("figure").textContent).toContain(
    "export const value",
  );
  expect(preview.scrollTop).toBe(0);
});

it("replaces the pending scroll of an unread lazy file and preserves the new file on tool return", () => {
  wideReviewContainer();
  const reading: WorkbarReadingState = {
    review: {
      scope: "unstaged:",
      source: "unstaged",
      selected: snapshot.files[0]!.path,
      query: "",
      collapsedDirectories: [],
      visibleFiles: 200,
      listScroll: 90,
      previewScroll: 480,
    },
  };
  const readFile = vi.fn(
    () => new Promise<(typeof snapshot.files)[number]>(() => {}),
  );
  const data = {
    ...snapshot,
    files: [
      { ...snapshot.files[0]!, diff: "", diffLoaded: false },
      snapshot.files[1]!,
    ],
  };
  const node = () =>
    withI18n(
      createElement(
        WorkbarReadingContext.Provider,
        { value: reading },
        createElement(ReviewPanel, {
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
      ),
    );
  const view = render(node());
  expect(readFile).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: snapshot.files[1]!.path }),
  );
  const preview = view.container.querySelector<HTMLElement>(
    ".review-file-preview",
  )!;
  expect(preview.scrollTop).toBe(0);
  expect(reading.review?.previewScroll).toBe(0);
  preview.scrollTop = 135;
  fireEvent.scroll(preview);
  view.unmount();
  const returned = render(node());
  expect(
    returned.container.querySelector<HTMLElement>(".review-file-preview")!
      .scrollTop,
  ).toBe(135);
  expect(screen.getByRole("figure").textContent).toContain(
    "export const value",
  );
});

it("keeps a compact directory tree beside the diff, restores collapsed groups after search, and adapts to panel width", async () => {
  const resize = wideReviewContainer();
  const { container } = render(
    withI18n(
      createElement(ReviewPanel, {
        embedded: true,
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh: async () => {},
        },
        onClose: () => {},
      }),
    ),
  );
  const first = screen.getByRole("button", {
    name: snapshot.files[0]!.path,
  });
  expect(first.getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("figure").textContent).toContain("new");
  const directory = screen.getByRole("button", {
    name: "src/features/review",
  });
  fireEvent.click(directory);
  expect(
    screen.queryByRole("button", {
      name: snapshot.files[0]!.path,
    }),
  ).toBeNull();
  expect(screen.getByRole("figure")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "very-long" },
  });
  expect(
    screen.getByRole("button", { name: snapshot.files[0]!.path }),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  expect(directory.getAttribute("aria-expanded")).toBe("false");
  const second = screen.getByRole("button", {
    name: "z-new-file.ts",
  });
  second.focus();
  fireEvent.click(second);
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("figure").textContent).toContain(
    "export const value",
  );
  resize(480);
  expect(container.querySelector(".review-navigation")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Back to changed files" }),
  );
  expect(
    screen
      .getByRole("button", { name: "src/features/review" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  resize(900);
  expect(container.querySelector(".review-navigation")).toBeTruthy();
  expect(screen.getByRole("figure")).toBeTruthy();
});

it("adds newly loaded pages to the pinned tree without refetching or replacing the selected diff", async () => {
  wideReviewContainer();
  const readFile = vi.fn(async () => snapshot.files[0]);
  const node = (count: number) =>
    withI18n(
      createElement(ReviewPanel, {
        embedded: true,
        review: {
          result: {
            ok: true,
            snapshot: {
              ...snapshot,
              files: snapshot.files
                .slice(0, count)
                .map((file) => ({ ...file, diffLoaded: false, diff: "" })),
            },
          },
          loading: false,
          error: null,
          refresh: async () => {},
          readFile,
        },
        onClose: () => {},
      }),
    );
  const { rerender } = render(node(1));
  await screen.findByRole("figure");
  rerender(node(2));
  expect(screen.getByRole("button", { name: "z-new-file.ts" })).toBeTruthy();
  expect(screen.getByRole("figure").textContent).toContain("new");
  expect(readFile).toHaveBeenCalledOnce();
});

it("distinguishes a complete count from partial evidence and searches only loaded paths", () => {
  const data = {
    ...snapshot,
    files: [10, 2, 1].map((n) => ({
      ...snapshot.files[0]!,
      path: `models/${n}.stp`,
    })),
  };
  const loadMore = vi.fn(async () => {});
  const node = (truncated: boolean, totalFiles?: number, nextOffset?: number) =>
    withI18n(
      createElement(ReviewPanel, {
        review: {
          result: {
            ok: true,
            snapshot: { ...data, truncated, totalFiles, nextOffset },
          },
          loading: false,
          error: null,
          refresh: async () => {},
          loadMore,
        },
        onClose: () => {},
      }),
    );
  const { container, rerender } = render(node(false, 205, 3));
  expect(screen.getByText("205 files changed")).toBeTruthy();
  expect(screen.getByText("3 files loaded")).toBeTruthy();
  expect(
    [...container.querySelectorAll("[data-review-file]")].map((e) =>
      e.getAttribute("data-review-file"),
    ),
  ).toEqual(["models/1.stp", "models/2.stp", "models/10.stp"]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "201" } });
  expect(screen.getByText("No matches in the loaded files.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load the next files" }));
  expect(loadMore).toHaveBeenCalledOnce();
  rerender(node(true));
  expect(screen.queryByText("3 files changed")).toBeNull();
  expect(screen.getByText("3 files loaded")).toBeTruthy();
  rerender(node(true, undefined, 3));
  expect(screen.getAllByText("3 files loaded")).toHaveLength(1);
  expect(screen.getByText(i18n.t("gitReviewTruncated"))).toBeTruthy();
});

it("shows each native file status without inventing zero stats or treating a rename as unchanged", () => {
  wideReviewContainer();
  const statuses = [
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "unknown",
  ] as const;
  const data = {
    ...snapshot,
    additions: 2,
    deletions: 3,
    files: statuses.map((status) => ({
      ...snapshot.files[0]!,
      path: `changes/${status}.ts`,
      previousPath: status === "renamed" ? "changes/before.ts" : undefined,
      status,
      diff:
        status === "renamed"
          ? "diff --git a/changes/before.ts b/changes/renamed.ts\nsimilarity index 100%\nrename from changes/before.ts\nrename to changes/renamed.ts\n"
          : snapshot.files[0]!.diff,
      additions: status === "added" ? 2 : 0,
      deletions: status === "deleted" ? 3 : 0,
    })),
  };
  const original = JSON.stringify(data);
  render(
    withI18n(
      createElement(ReviewPanel, {
        embedded: true,
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
  for (const file of data.files) {
    const row = screen.getByRole("button", { name: file.path });
    expect(row.textContent).toContain(i18n.t(`gitFileStatus_${file.status}`));
    expect(row.getAttribute("aria-description")).toBe(
      i18n.t(`gitFileStatus_${file.status}`),
    );
    expect(row.textContent).not.toContain("+0");
    expect(row.textContent).not.toContain("-0");
    if (file.additions) expect(row.textContent).toContain(`+${file.additions}`);
    if (file.deletions) expect(row.textContent).toContain(`-${file.deletions}`);
  }
  expect(JSON.stringify(data)).toBe(original);
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
  expect(readFile).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Show latest diff" }));
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
      path: "z-new-file.ts",
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
  expect(
    screen
      .getByText("feature/review compared with main")
      .closest(".review-source-picker"),
  ).toBeTruthy();
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
  expect(screen.getAllByText("feature/review compared with main")).toHaveLength(
    1,
  );
  expect(container.querySelector(".review-file-mode")).toBeNull();
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
        sessionPath: "/workspace/session.jsonl",
        cwd: "/workspace",
        capabilities: {},
        review: {
          result: { ok: true, snapshot },
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
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
  "does not steal focus after the returned list becomes $0",
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
            sessionPath: "/workspace/session.jsonl",
            cwd: "/workspace",
            capabilities: {},
            review: {
              result: { ok: true, snapshot },
              loading: false,
              error: null,
              refresh: async () => {},
            },
            conversationCollapsed: false,
            onRestoreConversation: () => {},
            onClose: () => {},
          }),
        ),
      );
    const { container, rerender } = render(node(true, false));
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".session-review-file")!,
    );
    fireEvent.keyDown(
      screen.getByRole("region", {
        name: /src\/features\/review\/very-long-file-name\.tsx/u,
      }),
      { key: "Escape" },
    );
    expect(document.activeElement).toBe(
      container.querySelector(".session-review-file"),
    );
    if (state === "inert")
      container.querySelector(".workbar-panel")!.setAttribute("inert", "");
    else rerender(node(state !== "collapsed", state === "inactive tab"));
    const input = screen.getByRole("textbox", { name: "draft" });
    input.focus();
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
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
    if (source === "unstaged")
      fireEvent.click(screen.getByRole("button", { name: "Show latest diff" }));
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
  expect(screen.getByRole("figure", { name: "Change diff" })).toBeTruthy();
  expect(
    screen.getByText(
      "New changes are available. You are reading the previous version.",
    ),
  ).toBeTruthy();
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
        initialFilePath: "z-new-file.ts",
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
  rerender(node(false, "z-new-file.ts"));
  expect(readFile).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  rerender(node(true, "z-new-file.ts"));
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: /new-file\.ts/u }),
  );
  const signal = readFile.mock.calls[0]![1];
  rerender(node(false, "z-new-file.ts"));
  input.focus();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(snapshot.files[1]!));
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole("figure", { name: "Change diff" })).toBeNull();
  rerender(node(true, "new-file.ts"));
  expect(readFile).toHaveBeenCalledTimes(2);
});
