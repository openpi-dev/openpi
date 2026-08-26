import * as fs from "node:fs";
import * as path from "node:path";

export interface SerializationOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

export type CompleteJsonLimit = "bytes" | "depth" | "nodes" | "string";

export type CompleteJsonEncoding =
  | {
      readonly ok: true;
      readonly json: string;
      readonly bytes: number;
      readonly nodes: number;
    }
  | {
      readonly ok: false;
      readonly limit: CompleteJsonLimit;
      readonly path: string;
      readonly maximum: number;
      readonly observedAtLeast: number;
      readonly nodes: number;
    };

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function boundedPath(parent: string, child: string) {
  const childPreview =
    child.length <= 128 ? child : `${child.slice(0, 128)}...[key truncated]`;
  const path = `${parent}.${childPreview}`;
  return byteLength(path) <= 256
    ? path
    : `${truncateUtf8(path, 240)}...[path truncated]`;
}

function configuredBudget(name: string, value: number, minimum: number) {
  if (!Number.isSafeInteger(value) || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite integer`);
  }
  if (value < minimum) {
    throw new RangeError(`${name} must be at least ${minimum}`);
  }
  return value;
}

/**
 * Encode a complete inert JSON value while bounding work and output during
 * traversal. Unlike `safeStringify`, this interface never returns a truncated
 * value: callers that persist authoritative data can fail closed instead.
 */
export function encodeCompleteJson(
  value: unknown,
  options: Required<SerializationOptions>,
): CompleteJsonEncoding {
  const maxBytes = configuredBudget("maxBytes", options.maxBytes, 1);
  const maxDepth = configuredBudget("maxDepth", options.maxDepth, 0);
  const maxNodes = configuredBudget("maxNodes", options.maxNodes, 1);
  const maxStringBytes = configuredBudget(
    "maxStringBytes",
    options.maxStringBytes,
    0,
  );
  const chunks: string[] = [];
  const seen = new WeakMap<object, string>();
  let bytes = 0;
  let nodes = 0;
  let failure: Exclude<CompleteJsonEncoding, { ok: true }> | undefined;

  const stop = (
    limit: CompleteJsonLimit,
    path: string,
    maximum: number,
    observedAtLeast: number,
  ) => {
    failure ??= {
      ok: false,
      limit,
      path: truncateUtf8(path, 256),
      maximum,
      observedAtLeast,
      nodes,
    };
    return false;
  };

  const append = (text: string, path: string) => {
    const addition = byteLength(text);
    if (bytes + addition > maxBytes) {
      return stop("bytes", path, maxBytes, bytes + addition);
    }
    chunks.push(text);
    bytes += addition;
    return true;
  };

  const encodedString = (text: string, path: string) => {
    const sourceBytes = byteLength(text);
    if (sourceBytes > maxStringBytes) {
      stop("string", path, maxStringBytes, sourceBytes);
      return undefined;
    }
    return JSON.stringify(text);
  };

  const safeErrorText = (error: unknown) => {
    try {
      return error instanceof Error ? error.message : String(error);
    } catch {
      return "unknown error";
    }
  };

  const visit = (current: unknown, depth: number, path: string): boolean => {
    if (failure) return false;
    if (nodes >= maxNodes) {
      return stop("nodes", path, maxNodes, nodes + 1);
    }
    nodes++;
    if (depth > maxDepth) {
      return stop("depth", path, maxDepth, depth);
    }

    if (current === null) return append("null", path);
    if (typeof current === "boolean")
      return append(current ? "true" : "false", path);
    if (typeof current === "string") {
      const encoded = encodedString(current, path);
      return encoded === undefined ? false : append(encoded, path);
    }
    if (typeof current === "number") {
      return append(
        Number.isFinite(current)
          ? JSON.stringify(current)
          : JSON.stringify(`[number: ${String(current)}]`),
        path,
      );
    }
    if (typeof current === "bigint")
      return append(JSON.stringify(`${current.toString()}n`), path);
    if (typeof current === "undefined")
      return append(JSON.stringify("[undefined]"), path);
    if (typeof current === "symbol")
      return append(
        JSON.stringify(`[symbol: ${current.description ?? ""}]`),
        path,
      );
    if (typeof current === "function")
      return append(
        JSON.stringify(`[function: ${current.name || "anonymous"}]`),
        path,
      );
    if (typeof current !== "object")
      return append(JSON.stringify(String(current)), path);

    const prior = seen.get(current);
    if (prior) return append(JSON.stringify(`[circular: ${prior}]`), path);
    seen.set(current, path);

    if (current instanceof Date) {
      try {
        return append(
          JSON.stringify(
            Number.isNaN(current.getTime())
              ? "[date: invalid]"
              : current.toISOString(),
          ),
          path,
        );
      } catch (error) {
        return append(
          JSON.stringify(`[unreadable date: ${safeErrorText(error)}]`),
          path,
        );
      }
    }

    if (current instanceof Error) {
      let name = "Error";
      let message = "";
      let stack: string | undefined;
      try {
        name = current.name;
      } catch {}
      try {
        message = current.message;
      } catch {}
      try {
        stack = current.stack;
      } catch {}
      return visit(
        {
          name,
          message,
          ...(stack ? { stack: truncateUtf8(stack, 16 * 1024) } : {}),
        },
        depth,
        path,
      );
    }

    if (Array.isArray(current)) {
      let length: number;
      try {
        length = current.length;
      } catch (error) {
        return visit(
          `[unreadable array: ${safeErrorText(error)}]`,
          depth + 1,
          path,
        );
      }
      if (!append("[", path)) return false;
      for (let index = 0; index < length; index++) {
        if (nodes >= maxNodes) {
          return stop(
            "nodes",
            boundedPath(path, String(index)),
            maxNodes,
            nodes + 1,
          );
        }
        if (index > 0 && !append(",", path)) return false;
        if (!(index in current)) {
          nodes++;
          if (!append("null", boundedPath(path, String(index)))) return false;
          continue;
        }
        let item: unknown;
        try {
          item = current[index];
        } catch (error) {
          item = `[unreadable property: ${safeErrorText(error)}]`;
        }
        if (!visit(item, depth + 1, boundedPath(path, String(index)))) {
          return false;
        }
      }
      return append("]", path);
    }

    const objectChunkStart = chunks.length;
    const objectByteStart = bytes;
    if (!append("{", path)) return false;
    let count = 0;
    try {
      // JavaScript has no interruptible own-key iterator: a Proxy's ownKeys
      // trap may allocate before iteration begins. Once keys are available,
      // the budgets below stop before reading any further property values.
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (nodes >= maxNodes) {
          return stop("nodes", boundedPath(path, key), maxNodes, nodes + 1);
        }
        const keyBytes = byteLength(key);
        const childPath = boundedPath(path, key);
        if (keyBytes > maxStringBytes) {
          return stop("string", childPath, maxStringBytes, keyBytes);
        }
        const keyJson = JSON.stringify(key);
        if (count > 0 && !append(",", path)) return false;
        if (!append(keyJson, childPath) || !append(":", childPath)) {
          return false;
        }
        let child: unknown;
        try {
          child = (current as Record<string, unknown>)[key];
        } catch (error) {
          child = `[unreadable property: ${safeErrorText(error)}]`;
        }
        if (!visit(child, depth + 1, childPath)) return false;
        count++;
      }
    } catch (error) {
      chunks.length = objectChunkStart;
      bytes = objectByteStart;
      return visit(
        `[unreadable object: ${safeErrorText(error)}]`,
        depth + 1,
        path,
      );
    }
    return append("}", path);
  };

  visit(value, 0, "$root");
  if (failure) return failure;
  return { ok: true, json: chunks.join(""), bytes, nodes };
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
      const result: unknown[] = [];
      const length = current.length;
      for (let index = 0; index < length; index++) {
        if (nodes >= maxNodes) {
          result.push("[truncated: node limit]");
          break;
        }
        if (!(index in current)) {
          nodes++;
          result.length++;
          continue;
        }
        try {
          result.push(
            visit(current[index], depth + 1, `${location}[${index}]`),
          );
        } catch (error) {
          result.push(
            `[unreadable property: ${error instanceof Error ? error.message : String(error)}]`,
          );
        }
      }
      return result;
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
    try {
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (nodes >= maxNodes) {
          let marker = "[truncated: node limit]";
          while (Object.prototype.hasOwnProperty.call(result, marker)) {
            marker += ".";
          }
          result[marker] = true;
          break;
        }
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
    } catch (error) {
      return `[unreadable object: ${error instanceof Error ? error.message : String(error)}]`;
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
