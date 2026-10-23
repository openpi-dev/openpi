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
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const split = viewMode === "split" && !file.binary;
  const [selection, setSelection] = useState<{
    file: WebGitReviewFile;
    id: number;
    side?: "old" | "new";
  } | null>(null);
  const selected = selection?.file === file ? selection.id : undefined;
  const referenceFor = (row: DiffRow, pane?: "old" | "new") => {
    const side = pane ?? (row.newLine !== undefined ? "new" : "old");
    const line = side === "new" ? row.newLine : row.oldLine;
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
  const paneRows = {
    old: selectableRows.filter((row) => referenceFor(row, "old")),
    new: selectableRows.filter((row) => referenceFor(row, "new")),
  };
  const hidden = Math.max(0, rows.length - visibleRows.length);
  const digits = String(
    visibleRows.reduce(
      (maximum, row) => Math.max(maximum, row.oldLine ?? 0, row.newLine ?? 0),
      0,
    ),
  ).length;

  const pairs: { old?: DiffRow; new?: DiffRow }[] = [];
  for (let index = 0; index < visibleRows.length; ) {
    const row = visibleRows[index]!;
    if (row.kind === "meta" || row.kind === "context") {
      pairs.push({ old: row, new: row });
      index += 1;
      continue;
    }
    const removed: DiffRow[] = [],
      added: DiffRow[] = [];
    while (
      visibleRows[index]?.kind === "removed" ||
      visibleRows[index]?.kind === "added"
    ) {
      const changed = visibleRows[index++]!;
      (changed.kind === "removed" ? removed : added).push(changed);
    }
    for (let at = 0; at < Math.max(removed.length, added.length); at += 1)
      pairs.push({ old: removed[at], new: added[at] });
  }
  const renderRow = (row: DiffRow | undefined, pane?: "old" | "new") => {
    if (!row)
      return (
        <span className="review-diff-line" data-kind="empty" aria-hidden="true">
          {"\u00a0"}
        </span>
      );
    const reference = referenceFor(row, pane);
    const navigable = pane ? paneRows[pane] : selectableRows;
    const focusedRow = !pane || selection?.side === pane ? selected : undefined;
    const isSelected =
      selected === row.id && (!pane || selection?.side === pane);
    const gutters = (
      <>
        {pane !== "new" && (
          <span
            className="review-diff-gutter"
            style={{ width: `${digits + 1}ch` }}
            aria-hidden="true"
          >
            {row.oldLine ?? ""}
          </span>
        )}
        {pane !== "old" && (
          <span
            className="review-diff-gutter"
            style={{ width: `${digits + 1}ch` }}
            aria-hidden="true"
          >
            {row.newLine ?? ""}
          </span>
        )}
      </>
    );
    return (
      <span
        className="review-diff-line"
        data-kind={row.kind}
        data-selected={isSelected || undefined}
        key={row.id}
      >
        {reference ? (
          <button
            type="button"
            className="review-diff-line-select"
            data-diff-row={row.id}
            data-diff-side={pane ?? "unified"}
            aria-label={t(
              reference.side === "new"
                ? "reviewSelectNewLine"
                : "reviewSelectOldLine",
              { line: reference.line },
            )}
            aria-pressed={isSelected}
            tabIndex={(focusedRow ?? navigable[0]?.id) === row.id ? 0 : -1}
            onClick={() => setSelection({ file, id: row.id, side: pane })}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              const index = navigable.indexOf(row);
              let target: DiffRow | undefined;
              if (event.key === "ArrowDown")
                target = navigable[Math.min(index + 1, navigable.length - 1)];
              else if (event.key === "ArrowUp")
                target = navigable[Math.max(index - 1, 0)];
              else if (event.key === "Home") target = navigable[0];
              else if (event.key === "End") target = navigable.at(-1);
              else return;
              event.preventDefault();
              event.stopPropagation();
              if (!target) return;
              setSelection({ file, id: target.id, side: pane });
              figure.current
                ?.querySelector<HTMLButtonElement>(
                  `[data-diff-row="${target.id}"][data-diff-side="${pane ?? "unified"}"]`,
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
        {reference && isSelected && (
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
  };

  return (
    <>
      <figure
        ref={figure}
        className="review-file-diff"
        data-view={split ? "split" : "unified"}
        aria-label={t("changeDiff")}
      >
        <figcaption className="review-diff-toolbar">
          <span>{t("changeDiff")}</span>
          {!file.binary && (
            <fieldset aria-label={t("diffViewMode")}>
              {(["unified", "split"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={viewMode === mode}
                  onClick={() => {
                    setSelection(null);
                    setViewMode(mode);
                  }}
                >
                  {t(mode === "unified" ? "diffUnified" : "diffSplit")}
                </button>
              ))}
            </fieldset>
          )}
        </figcaption>
        {!split ? (
          <pre>{visibleRows.map((row) => renderRow(row))}</pre>
        ) : (
          <div className="review-diff-split">
            <div className="review-diff-pair review-diff-column-headings">
              <span>{t("diffBefore")}</span>
              <span>{t("diffAfter")}</span>
            </div>
            {pairs.map((pair, index) => (
              <div
                className="review-diff-pair"
                key={pair.old?.id ?? pair.new?.id ?? index}
              >
                {renderRow(pair.old, "old")}
                {renderRow(pair.new, "new")}
              </div>
            ))}
          </div>
        )}
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
