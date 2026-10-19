/**
 * Output shaping for the read-only git tools: standard pi truncation
 * (2000 lines / 50KB) with complete output persisted to a temp file up to the
 * documented 10 MiB capture limit.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

/** Maximum complete output retained in a temporary artifact (10 MiB). */
export const COMPLETE_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

export interface FormattedOutput {
  readonly text: string;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface CapturedOutput {
  readonly preview: string;
  readonly lineCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly captureLimitExceeded: boolean;
  readonly captureLimitBytes: number;
  readonly fullOutputPath?: string;
}

function truncationNotice(options: {
  content: string;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
  fullOutputPath: string;
}) {
  return (
    `${options.content}\n\n[Output truncated: ${options.outputLines} of ${options.totalLines} lines ` +
    `(${formatSize(options.outputBytes)} of ${formatSize(options.totalBytes)}). ` +
    `Full output saved to: ${options.fullOutputPath}]`
  );
}

/** Format output already captured by a bounded-memory streaming process. */
export function formatCapturedOutput(captured: CapturedOutput) {
  const trimmed = captured.preview.replace(/\n+$/, "");
  const truncation = truncateHead(trimmed, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const content = truncation.content;
  const outputLines = content === "" ? 0 : content.split("\n").length;
  const outputBytes = Buffer.byteLength(content);

  if (captured.captureLimitExceeded) {
    return {
      text:
        `${content}\n\n[Output truncated: output exceeded the ${formatSize(captured.captureLimitBytes)} complete-output capture limit. ` +
        "The process was stopped and its partial temporary artifact was removed.]",
      lineCount: captured.lineCount,
      truncated: true,
    } satisfies FormattedOutput;
  }

  if (!captured.truncated || !captured.fullOutputPath) {
    return {
      text: trimmed,
      lineCount: captured.lineCount,
      truncated: false,
    } satisfies FormattedOutput;
  }

  return {
    text: truncationNotice({
      content,
      outputLines,
      totalLines: captured.lineCount,
      outputBytes,
      totalBytes: captured.totalBytes,
      fullOutputPath: captured.fullOutputPath,
    }),
    lineCount: captured.lineCount,
    truncated: true,
    fullOutputPath: captured.fullOutputPath,
  } satisfies FormattedOutput;
}
