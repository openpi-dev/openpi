/** Bounded display evidence only; never replay these arguments into a tool. */
export interface ToolArgumentPreview {
  readonly argsPreview?: string;
  readonly evidenceArguments?: Readonly<Record<string, string | number>>;
  readonly argsTruncated?: boolean;
}

const MAX_ARGUMENT_BYTES = 4 * 1024;
export const TOOL_EVIDENCE_ARGUMENT_KEYS = [
  "path",
  "command",
  "offset",
  "limit",
  "id",
  "target",
  "pattern",
  "query",
  "url",
  "runId",
] as const;

export function boundedToolArgumentText(
  value: string,
  maxBytes = MAX_ARGUMENT_BYTES,
) {
  // Bound allocation before encoding, then cut only at a UTF-8 boundary.
  const bytes = new TextEncoder().encode(value.slice(0, maxBytes));
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  return { text, truncated: text.length < value.length };
}

export function projectToolArguments(input: unknown): ToolArgumentPreview {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const evidenceArguments: Record<string, string | number> = {};
  let remaining = MAX_ARGUMENT_BYTES;
  let argsTruncated = false;
  // Extract from original arguments, even when an earlier large field will
  // consume the JSON preview. Never retain arbitrary nested payloads here.
  for (const key of TOOL_EVIDENCE_ARGUMENT_KEYS) {
    const value: unknown = Object.getOwnPropertyDescriptor(source, key)?.value;
    if (typeof value === "string") {
      const bounded = boundedToolArgumentText(value, remaining);
      evidenceArguments[key] = bounded.text;
      remaining -= new TextEncoder().encode(bounded.text).byteLength;
      argsTruncated ||= bounded.truncated;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      evidenceArguments[key] = value;
    }
  }
  const evidence =
    Object.keys(evidenceArguments).length > 0 ? { evidenceArguments } : {};
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return { ...evidence, argsTruncated: true };
    const preview = boundedToolArgumentText(json);
    return {
      argsPreview: preview.text,
      ...evidence,
      argsTruncated: argsTruncated || preview.truncated,
    };
  } catch {
    return { ...evidence, argsTruncated: true };
  }
}
