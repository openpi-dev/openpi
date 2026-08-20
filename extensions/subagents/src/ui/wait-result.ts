import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { sanitizeText } from "./transcript.ts";

const MAX_STATUS_ROWS = 4;

export interface WaitResultItem {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
}

export interface WaitResultDetails {
  readonly results?: readonly WaitResultItem[];
}

export function buildWaitResultPreview(
  content: string,
  details: WaitResultDetails | undefined,
  theme: Theme,
) {
  const results = details?.results ?? [];
  const failed = results.filter((result) => result.status === "error").length;
  const header =
    theme.fg(failed > 0 ? "warning" : "success", "■") +
    ` ${theme.fg("accent", theme.bold(`${results.length} subagent${results.length === 1 ? "" : "s"} settled`))}` +
    (failed > 0 ? theme.fg("error", ` · ${failed} failed`) : "");
  const lines = [header];

  for (const result of results.slice(0, MAX_STATUS_ROWS)) {
    const isFailure = result.status === "error";
    const icon = theme.fg(
      isFailure ? "error" : "success",
      isFailure ? "x" : "✓",
    );
    lines.push(
      `  ${icon} ${theme.fg("accent", result.id)}${result.title ? theme.fg("muted", ` · ${result.title}`) : ""}${theme.fg("dim", ` · ${result.status ?? "settled"}`)}`,
    );
  }
  if (results.length > MAX_STATUS_ROWS) {
    lines.push(theme.fg("dim", `  … ${results.length - MAX_STATUS_ROWS} more`));
  }

  if (content.trim()) {
    lines.push(
      theme.fg(
        "dim",
        `Results passed to main agent · ${keyHint("app.tools.expand", "to expand")}`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderWaitResult(
  content: string,
  details: WaitResultDetails | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!expanded) {
    return new Text(buildWaitResultPreview(content, details, theme), 0, 0);
  }

  const markdown = new Markdown(
    sanitizeText(content),
    0,
    0,
    getMarkdownTheme(),
  );
  return markdown;
}
