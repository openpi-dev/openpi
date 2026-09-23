// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement, Fragment, type ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebGitReviewSnapshot } from "../../web/protocol/types.ts";
import { parseDiffRows } from "../../web/ui/src/features/review/DiffCodePreview.tsx";
import { ReviewPanel } from "../../web/ui/src/features/review/ReviewPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

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
