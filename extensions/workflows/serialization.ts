import * as fs from "node:fs";
import * as path from "node:path";

export interface SerializationOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Normalize arbitrary values to inert JSON data. Cycles, bigint, non-finite
 * numbers, deep trees, throwing properties, and very large strings are all
 * represented explicitly instead of making artifact persistence fail.
 */
export function toSerializable(
  value: unknown,
  options: SerializationOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const seen = new WeakMap<object, string>();
  let nodes = 0;

  const visit = (
    current: unknown,
    depth: number,
    location: string,
  ): unknown => {
    nodes++;
    if (nodes > maxNodes) return "[truncated: node limit]";
    if (depth > maxDepth) return "[truncated: depth limit]";
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (byteLength(current) <= maxStringBytes) return current;
      return `${truncateUtf8(current, maxStringBytes)}\n[truncated: string limit]`;
    }
    if (typeof current === "number") {
      return Number.isFinite(current)
        ? current
        : `[number: ${String(current)}]`;
    }
    if (typeof current === "bigint") return `${current.toString()}n`;
    if (typeof current === "undefined") return "[undefined]";
    if (typeof current === "symbol")
      return `[symbol: ${current.description ?? ""}]`;
    if (typeof current === "function")
      return `[function: ${current.name || "anonymous"}]`;
    if (typeof current !== "object") return String(current);

    const prior = seen.get(current);
    if (prior) return `[circular: ${prior}]`;
    seen.set(current, location);

    if (Array.isArray(current)) {
      return current.map((item, index) =>
        visit(item, depth + 1, `${location}[${index}]`),
      );
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime())
        ? "[date: invalid]"
        : current.toISOString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        ...(current.stack
          ? { stack: truncateUtf8(current.stack, 16 * 1024) }
          : {}),
      };
    }

    const result: Record<string, unknown> = Object.create(null);
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch (error) {
      return `[unreadable object: ${error instanceof Error ? error.message : String(error)}]`;
    }
    for (const key of keys) {
      try {
        result[key] = visit(
          (current as Record<string, unknown>)[key],
          depth + 1,
          `${location}.${key}`,
        );
      } catch (error) {
        result[key] =
          `[unreadable property: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    return result;
  };

  return visit(value, 0, "$root");
}

/** Serialize to valid JSON no larger than the requested cap. */
export function safeStringify(
  value: unknown,
  options: SerializationOptions = {},
) {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const normalized = toSerializable(value, options);
  const serialized = JSON.stringify(normalized, null, 2) ?? "null";
  if (byteLength(serialized) <= maxBytes) return serialized;

  let previewBytes = Math.max(32, Math.floor(maxBytes / 3));
  while (previewBytes > 0) {
    const fallback = JSON.stringify(
      {
        truncated: true,
        reason: `serialized value exceeded ${maxBytes} bytes`,
        preview: truncateUtf8(serialized, previewBytes),
      },
      null,
      2,
    );
    if (byteLength(fallback) <= maxBytes) return fallback;
    previewBytes = Math.floor(previewBytes / 2);
  }
  return JSON.stringify({ truncated: true });
}

/** Durable same-directory replace: readers see either the old or new file. */
export function writeFileAtomic(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original write error is more useful.
    }
    throw error;
  }
}
