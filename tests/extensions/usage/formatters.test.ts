import assert from "node:assert/strict";
import test from "node:test";
import {
  formatResetTime,
  redactIdentifier,
  renderProgressBar,
  renderUsageReport,
} from "../../../extensions/usage/formatters.ts";
import type { ProviderUsageReport } from "../../../extensions/usage/types.ts";

test("redactIdentifier masks emails and identifiers safely", () => {
  assert.equal(redactIdentifier("john.doe@example.com"), "jo***@example.com");
  assert.equal(redactIdentifier("a@example.com"), "a***@example.com");
  assert.equal(redactIdentifier("ab@example.com"), "a***@example.com");
  assert.equal(redactIdentifier("short"), "sh***");
  assert.equal(redactIdentifier("project-123456-dev"), "proj***-dev");
  assert.equal(redactIdentifier(""), "");
  assert.equal(redactIdentifier(undefined), "");
});

test("formatResetTime computes relative reset descriptions", () => {
  const base = 1_000_000_000;
  assert.equal(formatResetTime(base - 1000, base), "resets soon");
  assert.equal(formatResetTime(base + 30_000, base), "resets in < 1m");
  assert.equal(formatResetTime(base + 120_000, base), "resets in 2m");
  assert.equal(
    formatResetTime(base + (2 * 3600 + 15 * 60) * 1000, base),
    "resets in 2h 15m",
  );
  assert.equal(
    formatResetTime(base + (3 * 86400 + 4 * 3600) * 1000, base),
    "resets in 3d 4h",
  );
  assert.equal(formatResetTime(undefined, base), "");
});

test("renderProgressBar renders accurate ASCII and color bars", () => {
  const plain0 = renderProgressBar(0, 10, false);
  assert.equal(plain0, "[░░░░░░░░░░]");

  const plain50 = renderProgressBar(50, 10, false);
  assert.equal(plain50, "[█████░░░░░]");

  const plain100 = renderProgressBar(100, 10, false);
  assert.equal(plain100, "[██████████]");

  const colorOk = renderProgressBar(50, 10, true);
  assert.match(colorOk, /\x1b\[32m/); // green

  const colorWarn = renderProgressBar(85, 10, true);
  assert.match(colorWarn, /\x1b\[33m/); // yellow

  const colorExhaust = renderProgressBar(100, 10, true);
  assert.match(colorExhaust, /\x1b\[31m/); // red
});

test("renderUsageReport generates clean formatted report", () => {
  const reports: ProviderUsageReport[] = [
    {
      providerId: "cursor",
      displayName: "Cursor",
      accountIdentifier: "user@example.com",
      planName: "Pro",
      meters: [
        {
          id: "cursor-auto",
          name: "Cursor Models",
          usedPercent: 42,
          resetsAt: 1_000_000_000 + 3600 * 1000,
          status: "ok",
        },
        {
          id: "cursor-api",
          name: "Other Models",
          usedPercent: 88,
          status: "warning",
        },
      ],
      fetchedAt: 1_000_000_000,
    },
    {
      providerId: "google-antigravity",
      displayName: "Google Antigravity",
      error: "Network timeout",
      meters: [],
      fetchedAt: 1_000_000_000,
    },
  ];

  const output = renderUsageReport(reports, {
    useColor: false,
    redact: true,
    now: 1_000_000_000,
  });
  assert.match(output, /Cursor \(us\*\*\*@example\.com · Pro\)/);
  assert.match(output, /Cursor Models/);
  assert.match(output, /Other Models/);
  assert.match(output, /42%/);
  assert.match(output, /88%/);
  assert.match(output, /resets in 1h/);
  assert.match(output, /Failed to fetch quota: Network timeout/);
});
