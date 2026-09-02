import {
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

const HEAD_SHARE = 0.75;
const OMISSION_MARKER = "[... middle omitted ...]";
// Three framing blanks, the omission marker, and the footer.
const STATIC_PROJECTION_OVERHEAD_LINES = 5;

function utf8Prefix(content: string, maxBytes: number) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    const value = bytes.subarray(0, end).toString("utf8");
    if (!value.endsWith("�")) return value;
    end -= 1;
  }
  return "";
}

function boundedHead(content: string, maxBytes: number, maxLines: number) {
  const result = truncateHead(content, { maxBytes, maxLines });
  if (result.content || !result.firstLineExceedsLimit) return result.content;
  return utf8Prefix(content, maxBytes);
}

function compactProjection(
  content: string,
  maxBytes: number,
  maxLines: number,
) {
  const marker =
    maxBytes >= OMISSION_MARKER.length
      ? OMISSION_MARKER
      : ".".repeat(Math.min(3, maxBytes));
  if (!marker || maxLines <= 0) return "";
  if (maxLines === 1) return marker;

  const bodyLineBudget = maxLines - 1;
  const keepTail = bodyLineBudget >= 2;
  const separatorBytes = keepTail ? 2 : 1;
  const bodyByteBudget = maxBytes - marker.length - separatorBytes;
  if (bodyByteBudget <= 0 || (keepTail && bodyByteBudget < 2)) return marker;

  const headLines = keepTail
    ? Math.max(1, Math.floor(bodyLineBudget * HEAD_SHARE))
    : bodyLineBudget;
  const tailLines = keepTail ? Math.max(1, bodyLineBudget - headLines) : 0;
  const headBytes = keepTail
    ? Math.max(1, Math.floor(bodyByteBudget * HEAD_SHARE))
    : bodyByteBudget;
  const tailBytes = keepTail ? Math.max(1, bodyByteBudget - headBytes) : 0;
  const head = boundedHead(content, headBytes, headLines);
  const tail = keepTail
    ? truncateTail(content, {
        maxBytes: tailBytes,
        maxLines: tailLines,
      }).content
    : "";
  return [head, marker, tail].filter(Boolean).join("\n");
}

/** Keep decision context at the start and verdict/evidence at the end. */
export function projectText(
  content: string,
  options: { maxBytes: number; maxLines: number; recovery: string },
) {
  if (options.maxBytes <= 0 || options.maxLines <= 0) return "";

  const probe = truncateHead(content, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
  });
  if (!probe.truncated) return content;

  const recoveryNewlines = options.recovery.split("\n").length - 1;
  const bodyLineBudget =
    options.maxLines - STATIC_PROJECTION_OVERHEAD_LINES - recoveryNewlines;
  if (bodyLineBudget < 2) {
    return compactProjection(content, options.maxBytes, options.maxLines);
  }
  const headLines = Math.max(1, Math.floor(bodyLineBudget * HEAD_SHARE));
  const tailLines = Math.max(1, bodyLineBudget - headLines);

  let bodyBudget = options.maxBytes;
  let projected = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const headBytes = Math.max(1, Math.floor(bodyBudget * HEAD_SHARE));
    const tailBytes = Math.max(1, bodyBudget - headBytes);
    const head = boundedHead(content, headBytes, headLines);
    const tail = truncateTail(content, {
      maxBytes: tailBytes,
      maxLines: tailLines,
    }).content;
    const shown =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const footer = `[Projection bounded: showing ${formatSize(shown)} of ${formatSize(probe.totalBytes)} across the head and tail. ${options.recovery}]`;
    projected = `${head}\n\n${OMISSION_MARKER}\n\n${tail}\n\n${footer}`;
    const overflow = Buffer.byteLength(projected, "utf8") - options.maxBytes;
    if (overflow <= 0 || bodyBudget <= overflow + 2) break;
    bodyBudget -= overflow;
  }
  const projectedProbe = truncateHead(projected, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
  });
  return projectedProbe.truncated
    ? compactProjection(content, options.maxBytes, options.maxLines)
    : projected;
}
