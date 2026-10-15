// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebGitReviewSnapshot } from "../../web/protocol/types.ts";
import { ReviewPanel } from "../../web/ui/src/features/review/ReviewPanel.tsx";
import {
  WorkbarReadingContext,
  type WorkbarReadingState,
} from "../../web/ui/src/features/workbar/workbar-reading-state.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

const revision = "a".repeat(64);
const snapshot: WebGitReviewSnapshot = {
  repositoryRoot: "/workspace",
  currentBranch: "feature",
  baseBranch: "refs/heads/release",
  comparison: "unstaged",
  revision,
  additions: 2,
  deletions: 2,
  truncated: false,
  files: ["first.txt", "second.txt"].map((path) => ({
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    diff: `@@ -1 +1 @@\n-old ${path}\n+new ${path}\n`,
    diffLoaded: true,
    diffTruncated: false,
  })),
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private callback: (
          entries: { contentRect: { width: number } }[],
        ) => void,
      ) {}
      observe(element: Element) {
        if (element.classList.contains("review-panel"))
          this.callback([{ contentRect: { width: 900 } }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function node(reading: WorkbarReadingState, next = snapshot, baseRef?: string) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      WorkbarReadingContext.Provider,
      { value: reading },
      createElement(ReviewPanel, {
        embedded: true,
        initialFilePath: next.files[0]?.path,
        readingScope: `workspace:${next.comparison}`,
        onClose: () => {},
        review: {
          result: { ok: true, snapshot: next },
          source: next.comparison,
          baseRef,
          loading: false,
          error: null,
          refresh: async () => {},
        },
      }),
    ),
  );
}

function checkbox(path: string) {
  return screen.getByRole<HTMLInputElement>("checkbox", {
    name: i18n.t("gitReviewMarkViewed", { path }),
  });
}

it("requires an explicit viewed decision and checking a different row does not open it", async () => {
  const reading: WorkbarReadingState = {};
  render(node(reading));
  await screen.findByRole("figure");
  expect(checkbox("first.txt").checked).toBe(false);
  fireEvent.click(checkbox("second.txt"));
  expect(checkbox("second.txt").checked).toBe(true);
  expect(screen.getByRole("figure").textContent).toContain("new first.txt");
  expect(reading.review?.viewed).toEqual({ revision, paths: ["second.txt"] });
  fireEvent.click(screen.getByRole("button", { name: "first.txt" }));
  expect(checkbox("first.txt").checked).toBe(false);
  fireEvent.click(checkbox("second.txt"));
  expect(reading.review?.viewed?.paths).toEqual([]);
});

it("lets the operator mark and undo the current diff in a single-column panel", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private callback: (
          entries: { contentRect: { width: number } }[],
        ) => void,
      ) {}
      observe(element: Element) {
        if (element.classList.contains("review-panel"))
          this.callback([{ contentRect: { width: 480 } }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const reading: WorkbarReadingState = {};
  render(node(reading));
  expect(
    screen.queryByRole("checkbox", {
      name: i18n.t("gitReviewMarkViewed", { path: "first.txt" }),
    }),
  ).toBeNull();
  const current = screen.getByRole<HTMLInputElement>("checkbox", {
    name: i18n.t("gitReviewMarkCurrentViewed", { path: "first.txt" }),
  });
  expect(current.checked).toBe(false);
  fireEvent.click(current);
  expect(current.checked).toBe(true);
  expect(reading.review?.viewed?.paths).toEqual(["first.txt"]);
  expect(screen.getByRole("figure").textContent).toContain("new first.txt");
  fireEvent.click(current);
  expect(current.checked).toBe(false);
  expect(reading.review?.viewed?.paths).toEqual([]);
});

it("preserves explicit marks across filters and same-revision refresh but clears after confirming latest", async () => {
  const reading: WorkbarReadingState = {};
  const view = render(node(reading));
  fireEvent.click(checkbox("second.txt"));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "first" },
  });
  expect(
    screen.queryByRole("checkbox", {
      name: i18n.t("gitReviewMarkViewed", { path: "second.txt" }),
    }),
  ).toBeNull();
  view.rerender(node(reading, { ...snapshot }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  expect(checkbox("second.txt").checked).toBe(true);
  view.rerender(node(reading, { ...snapshot, revision: "b".repeat(64) }));
  expect(checkbox("second.txt").checked).toBe(true);
  expect(reading.review?.viewed?.revision).toBe(revision);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("gitReviewShowLatest") }),
  );
  await waitFor(() => expect(checkbox("second.txt").checked).toBe(false));
  expect(reading.review?.viewed).toBeUndefined();
});

it("clears viewed marks on source or explicit base change even when a fixture revision is equal", async () => {
  const reading: WorkbarReadingState = {};
  const view = render(node(reading));
  fireEvent.click(checkbox("second.txt"));
  view.rerender(
    node(reading, { ...snapshot, comparison: "branch" }, "refs/heads/release"),
  );
  await waitFor(() => expect(checkbox("second.txt").checked).toBe(false));
  fireEvent.click(checkbox("second.txt"));
  view.rerender(
    node(reading, { ...snapshot, comparison: "branch" }, "refs/heads/main"),
  );
  await waitFor(() => expect(checkbox("second.txt").checked).toBe(false));
  expect(reading.review?.viewed).toBeUndefined();
});

it("restores only the same displayed revision after the Review component is reacquired", async () => {
  const reading: WorkbarReadingState = {};
  const first = render(node(reading));
  fireEvent.click(checkbox("second.txt"));
  first.unmount();
  const restored = render(node(reading));
  expect(checkbox("second.txt").checked).toBe(true);
  restored.unmount();
  render(node(reading, { ...snapshot, revision: "c".repeat(64) }));
  await waitFor(() => expect(checkbox("second.txt").checked).toBe(false));
  expect(reading.review?.viewed).toBeUndefined();
});

it("remembers at most 200 marks and can unmark at the limit to view another loaded file", async () => {
  const files = Array.from({ length: 201 }, (_, index) => ({
    ...snapshot.files[0]!,
    path: `file-${String(index).padStart(3, "0")}.txt`,
  }));
  const reading: WorkbarReadingState = {
    review: {
      scope: "workspace:unstaged:",
      source: "unstaged",
      selected: null,
      query: "",
      collapsedDirectories: [],
      visibleFiles: 300,
      listScroll: 0,
      previewScroll: 0,
      viewed: { revision, paths: files.map((file) => file.path) },
    },
  };
  render(node(reading, { ...snapshot, files }));
  expect(reading.review?.viewed?.paths).toHaveLength(200);
  expect(checkbox(files[200]!.path).disabled).toBe(true);
  expect(checkbox(files[0]!.path).disabled).toBe(false);
  expect(
    screen.getByText(i18n.t("gitReviewViewedLimit", { count: 200 })),
  ).toBeTruthy();
  fireEvent.click(checkbox(files[0]!.path));
  expect(checkbox(files[200]!.path).disabled).toBe(false);
  fireEvent.click(checkbox(files[200]!.path));
  expect(reading.review?.viewed?.paths).toHaveLength(200);
  expect(reading.review?.viewed?.paths).not.toContain(files[0]!.path);
  expect(reading.review?.viewed?.paths).toContain(files[200]!.path);
});
