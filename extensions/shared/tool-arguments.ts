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
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(0, end),
  );
  return { text, truncated: text.length < value.length };
}

function argumentJsonPreview(input: unknown) {
  let text = "";
  let remaining = MAX_ARGUMENT_BYTES;
  let remainingProperties = MAX_ARGUMENT_BYTES;
  const ancestors = new Set<object>();
  const append = (value: string) => {
    const bounded = boundedToolArgumentText(value, remaining);
    text += bounded.text;
    remaining -= new TextEncoder().encode(bounded.text).byteLength;
    return !bounded.truncated;
  };
  const appendString = (value: string) => {
    // Bound the source before escaping it. Escapes can only increase its size.
    const prefix = value.slice(0, remaining);
    return append(JSON.stringify(prefix)) && prefix.length === value.length;
  };
  const omitted = (value: unknown) =>
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol";
  const visit = (value: unknown, depth: number): boolean => {
    if (remaining === 0 || depth > 16) return false;
    if (typeof value === "string") return appendString(value);
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return append(JSON.stringify(value));
    if (typeof value !== "object" || ancestors.has(value)) return false;
    ancestors.add(value);
    const array = Array.isArray(value);
    if (!append(array ? "[" : "{")) return false;
    if (array) {
      for (let index = 0; index < value.length; index++) {
        if (remaining === 0 || (index > 0 && !append(","))) return false;
        const item: unknown = Object.getOwnPropertyDescriptor(
          value,
          index,
        )?.value;
        if (!visit(omitted(item) ? null : item, depth + 1)) return false;
      }
    } else {
      let first = true;
      for (const key in value) {
        if (remainingProperties-- === 0) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        if (!("value" in descriptor)) return false;
        const item: unknown = descriptor.value;
        if (omitted(item)) continue;
        if (
          (!first && !append(",")) ||
          !appendString(key) ||
          !append(":") ||
          !visit(item, depth + 1)
        )
          return false;
        first = false;
      }
    }
    ancestors.delete(value);
    return append(array ? "]" : "}");
  };
  const complete = visit(input, 0);
  return { ...(text ? { argsPreview: text } : {}), argsTruncated: !complete };
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
      argsTruncated ||= bounded.truncated;
      // A path may become an artifact link. A clipped prefix is not that file.
      if (bounded.truncated && (key === "path" || !bounded.text)) continue;
      evidenceArguments[key] = bounded.text;
      remaining -= new TextEncoder().encode(bounded.text).byteLength;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      evidenceArguments[key] = value;
    }
  }
  const evidence =
    Object.keys(evidenceArguments).length > 0 ? { evidenceArguments } : {};
  try {
    const preview = argumentJsonPreview(input);
    return {
      ...preview,
      ...evidence,
      argsTruncated: argsTruncated || preview.argsTruncated,
    };
  } catch {
    return { ...evidence, argsTruncated: true };
  }
}
