import { stripVTControlCharacters } from "node:util";
import type { ProviderUsageReport, QuotaMeter } from "./types.ts";

// Usage values are provider responses. Keep them on one physical line and
// remove both VT sequences and the remaining C0/C1/format controls before
// they reach a terminal or a TUI text widget.
const NON_PRINTING_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu;

function sanitizeExternalText(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return stripVTControlCharacters(value)
    .replace(/[\r\n\t]/g, " ")
    .replace(NON_PRINTING_TEXT_PATTERN, "")
    .trim();
}

export function redactIdentifier(identifier: string | undefined): string {
  const safeIdentifier = sanitizeExternalText(identifier);
  if (!safeIdentifier) return "";

  const atIndex = safeIdentifier.indexOf("@");
  if (atIndex > 0) {
    const user = safeIdentifier.slice(0, atIndex);
    const domain = safeIdentifier.slice(atIndex);
    if (user.length <= 2) {
      return `${user[0]}***${domain}`;
    }
    return `${user.slice(0, 2)}***${domain}`;
  }

  // Preserve the established short-ID form, but never let the prefix and
  // suffix overlap. Seven characters need a hidden character between the
  // visible halves, so four plus four is unsafe here.
  if (safeIdentifier.length <= 6) {
    return `${safeIdentifier.slice(0, 2)}***`;
  }
  const visibleEachSide = Math.min(
    4,
    Math.floor((safeIdentifier.length - 1) / 2),
  );
  return `${safeIdentifier.slice(0, visibleEachSide)}***${safeIdentifier.slice(-visibleEachSide)}`;
}

export function formatResetTime(
  resetsAt: number | undefined,
  now = Date.now(),
): string {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return "";
  const diffMs = resetsAt - now;
  if (diffMs <= 0) return "resets soon";

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "resets in < 1m";
  if (diffHour < 1) return `resets in ${diffMin}m`;
  if (diffDay < 1) {
    const remainMin = diffMin % 60;
    return remainMin > 0
      ? `resets in ${diffHour}h ${remainMin}m`
      : `resets in ${diffHour}h`;
  }
  const remainHour = diffHour % 24;
  return remainHour > 0
    ? `resets in ${diffDay}d ${remainHour}h`
    : `resets in ${diffDay}d`;
}

export function renderProgressBar(
  usedPercent: number | undefined,
  width = 16,
  useColor = true,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return `[${"?".repeat(safeWidth)}]`;
  }

  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.min(safeWidth, Math.round((clamped / 100) * safeWidth));
  const empty = Math.max(0, safeWidth - filled);

  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (!useColor) {
    return `[${bar}]`;
  }

  // ANSI colors
  let color = "\x1b[32m"; // green
  if (clamped >= 100) {
    color = "\x1b[31m";
  } else if (clamped >= 80) {
    color = "\x1b[33m";
  }

  return `[${color}${bar}\x1b[0m]`;
}

function formatUsedPercent(
  usedPercent: number | undefined,
  status: QuotaMeter["status"],
): string {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return "unknown";
  }

  if (usedPercent < 0) return "unknown";
  if (usedPercent >= 100) {
    // A provider may round a nearly exhausted bucket to 100 while retaining
    // a non-zero remainder. Keep that state visibly distinct from exhausted.
    return status === "exhausted"
      ? formatPercentValue(usedPercent)
      : "near limit";
  }

  return formatPercentValue(usedPercent);
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value === 0) return "0%";

  // Keep fractional values near either endpoint visible. A rounded 99.6%
  // must not become a misleading 100%, and a tiny known value must not look
  // like an exact zero.
  const decimals = value < 1 || value > 99 ? 2 : 1;
  const rounded = Number(value.toFixed(decimals));
  if (rounded <= 0) return `<${10 ** -decimals}%`;
  if (rounded >= 100) {
    const truncated = Math.floor(value * 10 ** decimals) / 10 ** decimals;
    return `${truncated}%`;
  }
  return `${rounded}%`;
}

function formatSampleAge(fetchedAt: number, now: number): string {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) {
    return "sample age unknown";
  }

  const ageMs = Math.max(0, now - fetchedAt);
  if (ageMs < 1000) return "sampled just now";

  const ageSeconds = Math.floor(ageMs / 1000);
  if (ageSeconds < 60) return `sampled ${ageSeconds}s ago`;

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `sampled ${ageMinutes}m ago`;

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    const remainMinutes = ageMinutes % 60;
    return remainMinutes > 0
      ? `sampled ${ageHours}h ${remainMinutes}m ago`
      : `sampled ${ageHours}h ago`;
  }

  const ageDays = Math.floor(ageHours / 24);
  const remainHours = ageHours % 24;
  return remainHours > 0
    ? `sampled ${ageDays}d ${remainHours}h ago`
    : `sampled ${ageDays}d ago`;
}

function formatMeterDetails(meter: QuotaMeter): string {
  const details: string[] = [];
  const usedText = sanitizeExternalText(meter.usedText);
  const limitText = sanitizeExternalText(meter.limitText);
  let remainingText = sanitizeExternalText(meter.remainingText);

  if (
    !remainingText &&
    typeof meter.usedPercent === "number" &&
    Number.isFinite(meter.usedPercent) &&
    meter.usedPercent >= 0 &&
    meter.usedPercent <= 100
  ) {
    remainingText = formatPercentValue(100 - meter.usedPercent);
  }

  if (usedText) details.push(`used: ${usedText}`);
  if (limitText) details.push(`limit: ${limitText}`);
  if (remainingText) details.push(`remaining: ${remainingText}`);

  return details.length > 0 ? ` · ${details.join(" · ")}` : "";
}

export interface RenderReportOptions {
  redact?: boolean;
  useColor?: boolean;
  now?: number;
}

export function renderUsageReport(
  reports: ProviderUsageReport[],
  options: RenderReportOptions = {},
): string {
  const { redact = false, useColor = true, now = Date.now() } = options;
  if (reports.length === 0) {
    return "No supported authenticated providers found (cursor, google-antigravity, openai-codex).\nUse '/login <provider>' to authenticate.";
  }

  const lines: string[] = [];
  const divider = "─".repeat(68);
  lines.push(`─── Model Provider Quota & Usage ${"─".repeat(35)}`);
  lines.push("");

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    const accountIdentifier = sanitizeExternalText(report.accountIdentifier);
    const accountStr = accountIdentifier
      ? redact
        ? redactIdentifier(accountIdentifier)
        : accountIdentifier
      : undefined;
    const planName = sanitizeExternalText(report.planName);
    const identityParts = [accountStr, planName].filter(
      (value): value is string => Boolean(value),
    );
    const identityBadge =
      identityParts.length > 0 ? ` (${identityParts.join(" · ")})` : "";
    const displayName =
      sanitizeExternalText(report.displayName) || "Unknown provider";
    const sampleAge = formatSampleAge(report.fetchedAt, now);
    lines.push(`  ${displayName}${identityBadge} · ${sampleAge}`);

    const warning = sanitizeExternalText(report.warning);
    if (warning) {
      lines.push(`  ⚠️ Warning: ${warning}`);
    }

    if (report.error) {
      const error = sanitizeExternalText(report.error) || "unknown error";
      lines.push(`  └─ Failed to fetch quota: ${error}`);
      if (i < reports.length - 1) lines.push("");
      continue;
    }

    if (report.meters.length === 0) {
      lines.push("  └─ Quota unavailable (usage unknown).");
      if (i < reports.length - 1) lines.push("");
      continue;
    }

    for (let m = 0; m < report.meters.length; m++) {
      const meter = report.meters[m];
      const isLast = m === report.meters.length - 1;
      const prefix = isLast ? "  └─" : "  ├─";

      const meterName = sanitizeExternalText(meter.name) || "Unnamed quota";
      const namePad = meterName.padEnd(20, " ");
      const bar = renderProgressBar(meter.usedPercent, 14, useColor);
      const percentText = formatUsedPercent(
        meter.usedPercent,
        meter.status,
      ).padStart(7, " ");

      let statusText = "";
      if (meter.status === "exhausted") statusText = " ⚠️ Exhausted";
      else if (meter.status === "warning") statusText = " ⚠️";
      else if (meter.status === "unknown") statusText = " ? Unknown";

      const resetStr = formatResetTime(meter.resetsAt, now);
      const resetText = resetStr ? ` · ${resetStr}` : "";
      const details = formatMeterDetails(meter);

      lines.push(
        `${prefix} ${namePad} ${bar} ${percentText}${statusText}${details}${resetText}`,
      );
    }

    if (i < reports.length - 1) {
      lines.push("");
    }
  }

  lines.push("");
  lines.push(divider);
  return lines.join("\n");
}
