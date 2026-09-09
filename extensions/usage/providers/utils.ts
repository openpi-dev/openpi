import type { UsageFetchContext, UsageStatus } from "../types.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim()))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function decodeJwtPayload(jwt: string) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return asRecord(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

export function computeUsageStatus(
  usedPercent: number | undefined,
): UsageStatus {
  if (
    usedPercent === undefined ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0
  )
    return "unknown";
  if (usedPercent >= 100) return "exhausted";
  if (usedPercent >= 80) return "warning";
  return "ok";
}

export function parseTimestamp(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined;
    const ms = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

// Only these locally generated errors may appear in a shareable report.
export class UsageRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export function safeUsageError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    return signal.reason instanceof Error &&
      signal.reason.name === "TimeoutError"
      ? "Quota request timed out. Try /usage --refresh."
      : "Quota request cancelled.";
  }
  if (error instanceof UsageRequestError) return `HTTP ${error.status}`;
  if (error instanceof Error && error.name === "TimeoutError")
    return "Quota request timed out. Try /usage --refresh.";
  if (error instanceof SyntaxError)
    return "Provider returned an invalid quota response.";
  return "Unable to retrieve quota. Check authentication and network, then retry.";
}

/** Bound a wait without taking ownership of Pi's credential refresh operation. */
export async function waitForUsage<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Each attempt has its own budget so a slow primary leaves time for fallback. */
export async function fetchUsageJson(
  url: string,
  init: RequestInit,
  ctx: UsageFetchContext,
) {
  const timeout = AbortSignal.timeout(4000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  signal.throwIfAborted();
  try {
    const response = await ctx.fetch(url, {
      ...init,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UsageRequestError(response.status);
    }
    const payload: unknown = await response.json();
    const record = asRecord(payload);
    if (!record) throw new SyntaxError();
    return record;
  } catch (error) {
    // Body reads can reject with AbortError even when the attempt timed out.
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}
