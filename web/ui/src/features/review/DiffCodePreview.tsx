import { MessageSquarePlus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewFile } from "../../../../protocol/types.ts";

const DIFF_LINE_CAP = 500;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

export interface DiffLineReference {
  filePath: string;
  side: "new" | "old";
  line: number;
  code: string;
}

interface DiffRow {
  id: number;
  kind: "added" | "removed" | "context" | "meta";
  oldLine?: number;
  newLine?: number;
  marker: string;
  code: string;
}

export function parseDiffRows(diff: string) {
  const rows: DiffRow[] = [];
  const pushRow = (row: Omit<DiffRow, "id">) => {
    rows.push({ id: rows.length, ...row });
  };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      pushRow({
        kind: "meta",
        marker: "",
        code: hunk[5]?.trim() || line,
      });
      continue;
    }
    if (!inHunk) {
      if (
        !line ||
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ")
      ) {
        continue;
      }
      pushRow({ kind: "meta", marker: "", code: line });
      continue;
    }
    if (line.startsWith("+") && newRemaining > 0) {
      pushRow({
        kind: "added",
        newLine,
        marker: "+",
        code: line.slice(1),
      });
      newLine += 1;
      newRemaining -= 1;
      continue;
    }
    if (line.startsWith("-") && oldRemaining > 0) {
      pushRow({
        kind: "removed",
        oldLine,
        marker: "-",
        code: line.slice(1),
      });
      oldLine += 1;
      oldRemaining -= 1;
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      pushRow({ kind: "meta", marker: "", code: line });
      continue;
    }
    if (!line.startsWith(" ") || oldRemaining <= 0 || newRemaining <= 0) {
      inHunk = false;
      pushRow({ kind: "meta", marker: "", code: line });
      continue;
    }
    pushRow({
      kind: "context",
      oldLine,
      newLine,
      marker: " ",
      code: line.startsWith(" ") ? line.slice(1) : line,
    });
    oldLine += 1;
    newLine += 1;
    oldRemaining -= 1;
    newRemaining -= 1;
  }
  return rows;
}

export function DiffCodePreview({
  file,
  onReferenceLine,
}: {
  file: WebGitReviewFile;
  onReferenceLine?: (reference: DiffLineReference) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => parseDiffRows(file.diff), [file.diff]);
  const visibleRows = rows.slice(0, DIFF_LINE_CAP);
  const figure = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<{
    file: WebGitReviewFile;
    id: number;
  } | null>(null);
  const selected = selection?.file === file ? selection.id : undefined;
  const referenceFor = (row: DiffRow) => {
    const side = row.newLine !== undefined ? "new" : "old";
    const line = row.newLine ?? row.oldLine;
    if (
      !onReferenceLine ||
      file.binary ||
      !line ||
      line < 1 ||
      !Number.isSafeInteger(line) ||
      (file.diffTruncated &&
        !file.diff.endsWith("\n") &&
        row.id === rows.at(-1)?.id)
    )
      return;
    return {
      filePath: side === "old" ? (file.previousPath ?? file.path) : file.path,
      side,
      line,
      code: row.code,
    } satisfies DiffLineReference;
  };
  const selectableRows = visibleRows.filter((row) => referenceFor(row));
  const hidden = Math.max(0, rows.length - visibleRows.length);
  const digits = String(
    visibleRows.reduce(
      (maximum, row) => Math.max(maximum, row.oldLine ?? 0, row.newLine ?? 0),
      0,
    ),
  ).length;

  return (
    <>
      <figure
        ref={figure}
        className="review-file-diff"
        aria-label={t("changeDiff")}
      >
        <pre>
          {visibleRows.map((row) => {
            const reference = referenceFor(row);
            const gutters = (
              <>
                <span
                  className="review-diff-gutter"
                  style={{ width: `${digits + 1}ch` }}
                  aria-hidden="true"
                >
                  {row.oldLine ?? ""}
                </span>
                <span
                  className="review-diff-gutter"
                  style={{ width: `${digits + 1}ch` }}
                  aria-hidden="true"
                >
                  {row.newLine ?? ""}
                </span>
              </>
            );
            return (
              <span
                className="review-diff-line"
                data-kind={row.kind}
                data-selected={selected === row.id || undefined}
                key={row.id}
              >
                {reference ? (
                  <button
                    type="button"
                    className="review-diff-line-select"
                    data-diff-row={row.id}
                    aria-label={t(
                      reference.side === "new"
                        ? "reviewSelectNewLine"
                        : "reviewSelectOldLine",
                      { line: reference.line },
                    )}
                    aria-pressed={selected === row.id}
                    tabIndex={
                      (selected ?? selectableRows[0]?.id) === row.id ? 0 : -1
                    }
                    onClick={() => setSelection({ file, id: row.id })}
                    onKeyDown={(event) => {
                      const index = selectableRows.indexOf(row);
                      let target: DiffRow | undefined;
                      if (event.key === "ArrowDown")
                        target =
                          selectableRows[
                            Math.min(index + 1, selectableRows.length - 1)
                          ];
                      else if (event.key === "ArrowUp")
                        target = selectableRows[Math.max(index - 1, 0)];
                      else if (event.key === "Home") target = selectableRows[0];
                      else if (event.key === "End")
                        target = selectableRows.at(-1);
                      else return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (!target) return;
                      setSelection({ file, id: target.id });
                      figure.current
                        ?.querySelector<HTMLButtonElement>(
                          `[data-diff-row="${target.id}"]`,
                        )
                        ?.focus({ preventScroll: true });
                    }}
                  >
                    {gutters}
                  </button>
                ) : (
                  gutters
                )}
                <span className="review-diff-marker" aria-hidden="true">
                  {row.marker}
                </span>
                <span className="review-diff-code">{row.code}</span>
                {reference && selected === row.id && (
                  <button
                    type="button"
                    className="review-diff-reference"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      const code = event.currentTarget
                        .closest(".review-diff-line")
                        ?.querySelector(".review-diff-code");
                      const textSelection = window.getSelection();
                      const selectedCode =
                        code?.contains(textSelection?.anchorNode ?? null) &&
                        code.contains(textSelection?.focusNode ?? null)
                          ? textSelection?.toString()
                          : undefined;
                      onReferenceLine?.({
                        ...reference,
                        code: selectedCode || reference.code,
                      });
                    }}
                  >
                    <MessageSquarePlus aria-hidden="true" />
                    {t("reviewQuoteLine")}
                  </button>
                )}
                {"\n"}
              </span>
            );
          })}
        </pre>
      </figure>
      {hidden > 0 && (
        <p className="review-hidden-lines">
          {t("gitReviewHiddenLines", { count: hidden })}
        </p>
      )}
      {file.diffTruncated && (
        <p className="review-hidden-lines">{t("gitReviewDiffTruncated")}</p>
      )}
    </>
  );
}
