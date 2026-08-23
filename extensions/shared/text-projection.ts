import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

const HEAD_SHARE = 0.75;

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

function utf8Suffix(content: string, maxBytes: number) {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length) {
    const value = bytes.subarray(start).toString("utf8");
    if (!value.startsWith("�")) return value;
    start += 1;
  }
  return "";
}

/** Keep decision context at the start and verdict/evidence at the end. */
export function projectText(
  content: string,
  options: { maxBytes: number; maxLines: number; recovery: string },
) {
  const probe = truncateHead(content, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
  });
  if (!probe.truncated) return content;

  let bodyBudget = options.maxBytes;
  let projected = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const headBytes = Math.max(1, Math.floor(bodyBudget * HEAD_SHARE));
    const tailBytes = Math.max(1, bodyBudget - headBytes);
    const head = utf8Prefix(content, headBytes);
    const tail = utf8Suffix(content, tailBytes);
    const shown =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const footer = `[Projection bounded: showing ${formatSize(shown)} of ${formatSize(probe.totalBytes)} across the head and tail. ${options.recovery}]`;
    projected = `${head}\n\n[... middle omitted ...]\n\n${tail}\n\n${footer}`;
    const overflow = Buffer.byteLength(projected, "utf8") - options.maxBytes;
    if (overflow <= 0 || bodyBudget <= overflow + 2) break;
    bodyBudget -= overflow;
  }
  return projected;
}
