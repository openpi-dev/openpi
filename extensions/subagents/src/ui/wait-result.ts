import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeText } from "../../../shared/agent-transcript.ts";

const MAX_STATUS_ROWS = 4;

export interface WaitResultItem {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly outcome?: "completed" | "failed" | "interrupted";
  readonly worktreeBranch?: string;
  readonly elapsed?: string;
  readonly artifactSaveFailed?: boolean;
  readonly fullResultSaved?: boolean;
}

export interface WaitResultDetails {
  readonly results?: readonly WaitResultItem[];
}

function singleLine(value: string) {
  return sanitizeText(value).replace(/\s+/gu, " ").trim();
}

function fixedRows(rows: readonly string[]): Component {
  return {
    render(width) {
      return rows.map((row) => truncateToWidth(row, Math.max(1, width), "…"));
    },
    invalidate() {},
  };
}

function selectStatusRows(results: readonly WaitResultItem[]) {
  const visible = results.slice(0, MAX_STATUS_ROWS);
  if (visible.some((result) => result.status === "error")) {
    return visible;
  }

  const hiddenFailure = results
    .slice(MAX_STATUS_ROWS)
    .find((result) => result.status === "error");
  return hiddenFailure ? [...visible.slice(0, -1), hiddenFailure] : visible;
}

export function buildWaitResultPreview(
  content: string,
  details: WaitResultDetails | undefined,
  theme: Theme,
) {
  const results = details?.results ?? [];
  const uncertain = results.filter(
    (result) => result.outcome === "interrupted",
  ).length;
  const failed = results.filter(
    (result) => result.status === "error" && result.outcome !== "interrupted",
  ).length;
  const artifactFailures = results.filter(
    (result) => result.artifactSaveFailed,
  ).length;
  const exceptions = [
    failed > 0 ? theme.fg("error", `${failed} failed`) : "",
    uncertain > 0 ? theme.fg("warning", `${uncertain} uncertain`) : "",
  ].filter(Boolean);
  const header =
    theme.fg(
      failed > 0 || uncertain > 0 ? "warning" : "success",
      failed > 0 || uncertain > 0 ? "!" : "✓",
    ) +
    ` ${exceptions.length > 0 ? `${exceptions.join(" · ")} · ` : ""}` +
    theme.fg(
      "accent",
      theme.bold(
        `${results.length} subagent${results.length === 1 ? "" : "s"} settled`,
      ),
    ) +
    (artifactFailures > 0
      ? theme.fg(
          "warning",
          ` · ${artifactFailures} artifact${artifactFailures === 1 ? "" : "s"} not saved`,
        )
      : "");
  const lines = [header];
  const statusRows = selectStatusRows(results);

  for (const result of statusRows) {
    const isUncertain = result.outcome === "interrupted";
    const isFailure = result.status === "error" && !isUncertain;
    const icon = theme.fg(
      isFailure ? "error" : isUncertain ? "warning" : "success",
      isFailure ? "x" : isUncertain ? "?" : "✓",
    );
    const id = singleLine(result.id);
    const title = result.title ? singleLine(result.title) : "";
    const status = isUncertain
      ? "uncertain"
      : singleLine(result.status ?? "settled");
    const elapsed = result.elapsed ? singleLine(result.elapsed) : "";
    const notices = [
      result.artifactSaveFailed ? "artifact not saved" : "",
      result.worktreeBranch
        ? `worktree handoff · ${singleLine(result.worktreeBranch)}`
        : "",
      result.fullResultSaved ? "full result saved" : "",
    ].filter(Boolean);
    const attention = notices.length
      ? theme.fg("warning", `${notices.join(" · ")} · `)
      : "";
    lines.push(
      `  ${icon} ${attention}${theme.fg("accent", id)}${title ? theme.fg("muted", ` · ${title}`) : ""}${theme.fg("dim", ` · ${status}${elapsed ? ` · ${elapsed}` : ""}`)}`,
    );
  }
  if (results.length > statusRows.length) {
    lines.push(
      theme.fg("dim", `  … ${results.length - statusRows.length} more`),
    );
  }

  if (sanitizeText(content).trim()) {
    lines.push(
      theme.fg(
        "dim",
        `Results passed to main agent · ${keyHint("app.tools.expand", "to expand")}`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderWaitResultPreview(
  content: string,
  details: WaitResultDetails | undefined,
  theme: Theme,
) {
  return fixedRows(buildWaitResultPreview(content, details, theme).split("\n"));
}

export function renderWaitResult(
  content: string,
  details: WaitResultDetails | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!expanded) {
    return renderWaitResultPreview(content, details, theme);
  }

  const markdown = new Markdown(
    sanitizeText(content),
    0,
    0,
    getMarkdownTheme(),
  );
  return markdown;
}
