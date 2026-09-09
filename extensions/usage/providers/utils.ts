import type { UsageStatus } from "../types.ts";

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    const jsonStr = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(jsonStr);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function computeUsageStatus(usedPercent: number): UsageStatus {
  if (usedPercent >= 100) return "exhausted";
  if (usedPercent >= 80) return "warning";
  return "ok";
}

export function parseTimestamp(val: unknown): number | undefined {
  if (typeof val === "number" && !Number.isNaN(val)) {
    // If it's in seconds (10 digits), convert to ms (13 digits)
    return val < 1_000_000_000_000 ? val * 1000 : val;
  }
  if (typeof val === "string") {
    const parsed = Date.parse(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
