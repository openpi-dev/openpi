// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebGitReviewSnapshot } from "../../web/protocol/types.ts";
import { parseDiffRows } from "../../web/ui/src/features/review/DiffCodePreview.tsx";
import { ReviewPanel } from "../../web/ui/src/features/review/ReviewPanel.tsx";
import { SessionChangesPopover } from "../../web/ui/src/features/review/SessionChangesPopover.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

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

it("shows a Codex-style session change trigger backed by Git files", () => {
  const onOpenReview = vi.fn();
  const { container } = render(
    withI18n(createElement(SessionChangesPopover, { snapshot, onOpenReview })),
  );
  const trigger = screen.getByRole("button", {
    name: /2 files changed/u,
  });
  expect(trigger.textContent).toContain("+8");
  expect(trigger.textContent).toContain("-3");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    top: 280,
  } as DOMRect);
  fireEvent.click(trigger);
  const popover = screen.getByRole("dialog", { name: "Changes" });
  expect(popover.style.maxHeight).toBe("260px");
  const file = screen.getByRole("button", {
    name: /very-long-file-name\.tsx/u,
  });
  fireEvent.click(file);
  expect(onOpenReview).toHaveBeenCalledTimes(1);
  expect(onOpenReview).toHaveBeenCalledWith(
    "src/features/review/very-long-file-name.tsx",
    trigger,
  );
  expect(container.querySelector(".session-changes-popover")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(container.querySelector(".session-changes-popover")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("switches from the changed-file list to a separate full-height diff view", () => {
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
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
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
