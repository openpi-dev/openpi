// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebGitReviewFile } from "../../web/protocol/types.ts";
import {
  DiffCodePreview,
  parseDiffRows,
} from "../../web/ui/src/features/review/DiffCodePreview.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);
const file: WebGitReviewFile = {
  path: "src/example.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  diffTruncated: false,
  diff: "@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+extra\n tail\n",
};

it("references exact new and deleted old line numbers from the hunk, preserving the code text", () => {
  const reference = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, { file, onReferenceLine: reference }),
    ),
  );
  const old = screen.getByRole("button", {
    name: i18n.t("reviewSelectOldLine", { line: 11 }),
  });
  fireEvent.click(old);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenLastCalledWith({
    filePath: "src/example.ts",
    side: "old",
    line: 11,
    code: "old",
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("reviewSelectNewLine", { line: 12 }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenLastCalledWith({
    filePath: "src/example.ts",
    side: "new",
    line: 12,
    code: "extra",
  });
});

it("uses one keyboard entry point for selectable lines and lets arrow keys reach the next reference", () => {
  const reference = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, { file, onReferenceLine: reference }),
    ),
  );
  const first = screen.getByRole("button", {
    name: i18n.t("reviewSelectNewLine", { line: 10 }),
  });
  first.focus();
  expect(
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".review-diff-line-select",
      ),
    ].filter((button) => button.tabIndex === 0),
  ).toHaveLength(1);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const old = screen.getByRole("button", {
    name: i18n.t("reviewSelectOldLine", { line: 11 }),
  });
  expect(document.activeElement).toBe(old);
  expect(old.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenCalledExactlyOnceWith({
    filePath: "src/example.ts",
    side: "old",
    line: 11,
    code: "old",
  });
});

it("references a renamed file's original path for deleted lines and its new path for added lines", () => {
  const reference = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, {
        file: { ...file, status: "renamed", previousPath: "src/old-name.ts" },
        onReferenceLine: reference,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("reviewSelectOldLine", { line: 11 }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenLastCalledWith({
    filePath: "src/old-name.ts",
    side: "old",
    line: 11,
    code: "old",
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("reviewSelectNewLine", { line: 11 }),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenLastCalledWith({
    filePath: "src/example.ts",
    side: "new",
    line: 11,
    code: "new",
  });
});

it("quotes a user-selected substring only when it belongs to this numbered code row", () => {
  const reference = vi.fn();
  const { container } = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, { file, onReferenceLine: reference }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("reviewSelectNewLine", { line: 12 }),
    }),
  );
  const text = container.querySelector("[data-selected] .review-diff-code")!
    .firstChild!;
  const range = document.createRange();
  range.setStart(text, 1);
  range.setEnd(text, 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reviewQuoteLine") }),
  );
  expect(reference).toHaveBeenCalledExactlyOnceWith({
    filePath: "src/example.ts",
    side: "new",
    line: 12,
    code: "xtr",
  });
});

it("does not invent actionable line numbers for malformed hunk tails, binary files or a truncated final line", () => {
  const diff =
    "@@ -5 +5 @@\n-old\n+new\nnot hunk content\n+not another new line";
  expect(
    parseDiffRows(diff).filter((row) => row.oldLine || row.newLine),
  ).toEqual([
    { id: 1, kind: "removed", oldLine: 5, marker: "-", code: "old" },
    { id: 2, kind: "added", newLine: 5, marker: "+", code: "new" },
  ]);
  const reference = vi.fn();
  const { rerender } = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, {
        file: { ...file, binary: true },
        onReferenceLine: reference,
      }),
    ),
  );
  expect(screen.queryByRole("button")).toBeNull();
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(DiffCodePreview, {
        file: { ...file, diff: "@@ -0,0 +1 @@\n+partial", diffTruncated: true },
        onReferenceLine: reference,
      }),
    ),
  );
  expect(screen.queryByRole("button")).toBeNull();
});
