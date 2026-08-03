import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeText } from "./output-view.ts";

const STREAM_PREVIEW_LINES = 2;
const STREAM_HEADERS = new Set(["stdout:", "stderr:"]);

interface ParsedTerminalResult {
  summary: string;
  metadata: string[];
  streams: Array<{
    name: "stdout" | "stderr";
    lines: string[];
    truncated: boolean;
  }>;
}

export interface CompactTerminalPreview {
  summary: string;
  metadata: string[];
  streams: Array<{
    name: "stdout" | "stderr";
    lines: string[];
  }>;
  hiddenLines: number;
  unknownEarlierOutput: boolean;
}

function parseTerminalResult(content: string): ParsedTerminalResult {
  const lines = sanitizeText(content).split("\n");
  const summary = lines.shift()?.trim() || "Background terminal result";
  const metadata: string[] = [];
  const streams: ParsedTerminalResult["streams"] = [];
  let current: ParsedTerminalResult["streams"][number] | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (STREAM_HEADERS.has(line)) {
      current = {
        name: line === "stdout:" ? "stdout" : "stderr",
        lines: [],
        truncated: false,
      };
      streams.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) metadata.push(line.trim());
      continue;
    }
    if (/^\[(stdout|stderr) truncated:/.test(line)) {
      current.truncated = true;
      continue;
    }
    if (!line || line === "(empty)") continue;
    current.lines.push(line);
  }

  for (const stream of streams) {
    while (stream.lines.at(-1) === "") stream.lines.pop();
  }
  return { summary, metadata, streams };
}

/** Build a bounded, tail-first preview without changing model-facing output. */
export function buildCompactTerminalPreview(
  content: string,
  maximumPerStream = STREAM_PREVIEW_LINES,
): CompactTerminalPreview {
  const parsed = parseTerminalResult(content);
  let hiddenLines = 0;
  let unknownEarlierOutput = false;
  const streams = parsed.streams
    .filter((stream) => stream.lines.length > 0)
    .map((stream) => {
      const maximum = Math.max(0, maximumPerStream);
      hiddenLines += Math.max(0, stream.lines.length - maximum);
      unknownEarlierOutput ||= stream.truncated;
      return {
        name: stream.name,
        lines: maximum === 0 ? [] : stream.lines.slice(-maximum),
      };
    });

  return {
    summary: parsed.summary,
    metadata: parsed.metadata,
    streams,
    hiddenLines,
    unknownEarlierOutput,
  };
}

function fixedRows(rows: string[]): Component {
  return {
    render(width) {
      return rows.map((row) => truncateToWidth(row, width, "…"));
    },
    invalidate() {},
  };
}

/** Render terminal results compactly by default; expanded mode preserves all text. */
export function renderTerminalResult(
  content: string,
  expanded: boolean,
  theme: Theme,
  summaryOverride?: string,
): Component {
  const sanitized = sanitizeText(content);
  if (expanded) {
    if (!summaryOverride) return new Text(sanitized, 0, 0);
    return new Text(
      [summaryOverride, ...sanitized.split("\n").slice(1)].join("\n"),
      0,
      0,
    );
  }

  const preview = buildCompactTerminalPreview(sanitized);
  const rows = [
    summaryOverride ?? theme.fg("muted", preview.summary),
    ...preview.metadata.map((line) => theme.fg("error", line)),
  ];
  for (const stream of preview.streams) {
    for (const line of stream.lines) {
      rows.push(
        theme.fg("dim", `${stream.name} · `) + theme.fg("toolOutput", line),
      );
    }
  }
  if (preview.hiddenLines > 0 || preview.unknownEarlierOutput) {
    const amount = preview.unknownEarlierOutput
      ? "earlier log output"
      : `${preview.hiddenLines} earlier line${preview.hiddenLines === 1 ? "" : "s"}`;
    rows.push(
      theme.fg(
        "dim",
        `… ${amount} hidden · ${keyHint("app.tools.expand", "to expand")}`,
      ),
    );
  }
  return fixedRows(rows);
}
