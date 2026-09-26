import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewFile } from "../../../../protocol/types.ts";

const DIFF_LINE_CAP = 500;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

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
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      pushRow({
        kind: "meta",
        marker: "",
        code: hunk[3]?.trim() || line,
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
    if (line.startsWith("+")) {
      pushRow({
        kind: "added",
        newLine,
        marker: "+",
        code: line.slice(1),
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      pushRow({
        kind: "removed",
        oldLine,
        marker: "-",
        code: line.slice(1),
      });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("\\ No newline")) {
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
  }
  return rows;
}

export function DiffCodePreview({ file }: { file: WebGitReviewFile }) {
  const { t } = useTranslation();
  const rows = useMemo(() => parseDiffRows(file.diff), [file.diff]);
  const visibleRows = rows.slice(0, DIFF_LINE_CAP);
  const hidden = Math.max(0, rows.length - visibleRows.length);
  const digits = String(
    visibleRows.reduce(
      (maximum, row) => Math.max(maximum, row.oldLine ?? 0, row.newLine ?? 0),
      0,
    ),
  ).length;

  return (
    <>
      <figure className="review-file-diff" aria-label={t("changeDiff")}>
        <pre>
          {visibleRows.map((row) => (
            <span
              className="review-diff-line"
              data-kind={row.kind}
              key={row.id}
            >
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
              <span className="review-diff-marker" aria-hidden="true">
                {row.marker}
              </span>
              <span className="review-diff-code">{row.code}</span>
              {"\n"}
            </span>
          ))}
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
