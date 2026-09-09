import type { ProviderUsageReport, QuotaMeter } from "./types.ts";

export function redactIdentifier(identifier: string | undefined): string {
  if (!identifier) return "";
  const atIndex = identifier.indexOf("@");
  if (atIndex > 0) {
    const user = identifier.slice(0, atIndex);
    const domain = identifier.slice(atIndex);
    if (user.length <= 2) {
      return `${user[0]}***${domain}`;
    }
    return `${user.slice(0, 2)}***${domain}`;
  }
  if (identifier.length <= 6) {
    return `${identifier.slice(0, 2)}***`;
  }
  return `${identifier.slice(0, 4)}***${identifier.slice(-4)}`;
}

export function formatResetTime(
  resetsAt: number | undefined,
  now = Date.now(),
): string {
  if (resetsAt === undefined || Number.isNaN(resetsAt)) return "";
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
  usedPercent: number,
  width = 16,
  useColor = true,
): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.min(width, Math.round((clamped / 100) * width));
  const empty = Math.max(0, width - filled);

  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (!useColor) {
    return `[${bar}]`;
  }

  // ANSI colors
  let color = "\x1b[32m"; // green
  if (clamped >= 100) {
    color = "\x1b[31m"; // red
  } else if (clamped >= 80) {
    color = "\x1b[33m"; // yellow
  }

  return `[${color}${bar}\x1b[0m]`;
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
    return "No authenticated providers configured for quota inspection.";
  }

  const lines: string[] = [];
  const divider = "─".repeat(68);
  lines.push(`─── Model Provider Quota & Usage ${"─".repeat(35)}`);
  lines.push("");

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    const accountStr = report.accountIdentifier
      ? redact
        ? redactIdentifier(report.accountIdentifier)
        : report.accountIdentifier
      : undefined;

    const planBadge = report.planName ? ` · ${report.planName}` : "";
    const accountBadge = accountStr ? ` (${accountStr}${planBadge})` : "";
    lines.push(`  ${report.displayName}${accountBadge}`);

    if (report.error) {
      lines.push(`  └─ Failed to fetch quota: ${report.error}`);
      if (i < reports.length - 1) lines.push("");
      continue;
    }

    if (report.meters.length === 0) {
      lines.push("  └─ No active quota limits found.");
      if (i < reports.length - 1) lines.push("");
      continue;
    }

    for (let m = 0; m < report.meters.length; m++) {
      const meter: QuotaMeter = report.meters[m];
      const isLast = m === report.meters.length - 1;
      const prefix = isLast ? "  └─" : "  ├─";

      const namePad = meter.name.padEnd(20, " ");
      const bar = renderProgressBar(meter.usedPercent, 14, useColor);
      const pctStr = `${Math.round(meter.usedPercent)}%`.padStart(4, " ");

      let statusIcon = "";
      if (meter.status === "exhausted") statusIcon = " ⚠️ Exhausted";
      else if (meter.status === "warning") statusIcon = " ⚠️";

      const resetStr = formatResetTime(meter.resetsAt, now);
      const resetText = resetStr ? ` · ${resetStr}` : "";
      const extraText = meter.usedText ? ` (${meter.usedText})` : "";

      lines.push(
        `${prefix} ${namePad} ${bar} ${pctStr}${statusIcon}${extraText}${resetText}`,
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
