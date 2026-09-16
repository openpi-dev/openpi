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
  assert.equal(redactIdentifier("1234567"), "123***567");
  assert.equal(redactIdentifier("\x1b[31m1234567\x1b[0m"), "123***567");
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

  const unknown = renderProgressBar(undefined, 10, false);
  assert.equal(unknown, "[??????????]");
  assert.doesNotMatch(renderProgressBar(Number.NaN, 10, false), /NaN|0%/);
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

test("renderUsageReport keeps quota precision and exposes report metadata", () => {
  const now = 2_000_000_000;
  const reports: ProviderUsageReport[] = [
    {
      providerId: "partial-provider",
      displayName: "Provider\u001b[31m\nName",
      planName: "Starter",
      meters: [
        {
          id: "near-limit",
          name: "Near\u001b[2m Limit",
          usedPercent: 99.6,
          usedText: "$9.96",
          limitText: "$10.00",
          remainingText: "$0.04",
          status: "warning",
        },
        {
          id: "unknown",
          name: "Unmeasured",
          usedText: "some",
          limitText: "unknown",
          remainingText: "unknown",
          status: "unknown",
        },
        {
          id: "derived-remaining",
          name: "Percent Only",
          usedPercent: 99.6,
          status: "warning",
        },
        {
          id: "over-limit",
          name: "Over Limit",
          usedPercent: 125,
          status: "exhausted",
        },
        {
          id: "rounded-limit",
          name: "Rounded Limit",
          usedPercent: 100,
          remainingText: "0.1%",
          status: "warning",
        },
      ],
      fetchedAt: now - 90_000,
      warning: "Partial\u001b[2m data",
    },
    {
      providerId: "empty-provider",
      displayName: "Empty Provider",
      planName: "Team",
      meters: [],
      fetchedAt: now,
    },
  ];

  const output = renderUsageReport(reports, {
    useColor: false,
    redact: true,
    now,
  });

  assert.match(output, /Provider Name \(Starter\) · sampled 1m ago/);
  assert.match(output, /Warning: Partial data/);
  assert.match(output, /99\.6%/);
  assert.doesNotMatch(output, /NaN/);
  assert.match(output, /used: \$9\.96/);
  assert.match(output, /limit: \$10\.00/);
  assert.match(output, /remaining: \$0\.04/);
  assert.match(output, /Unmeasured.*unknown/);
  assert.match(output, /Percent Only.*remaining: 0\.4%/);
  assert.match(output, /Over Limit.*125%/);
  assert.match(output, /Rounded Limit.*near limit.*remaining: 0\.1%/);
  assert.match(output, /Empty Provider \(Team\)/);
  assert.match(output, /Quota unavailable \(usage unknown\)/);
  assert.doesNotMatch(output, /No active quota limits found/);
  assert.doesNotMatch(output, /\x1b/);
});

test("renderUsageReport guides users when no providers are available", () => {
  const output = renderUsageReport([], { useColor: false });
  assert.match(output, /cursor, google-antigravity, openai-codex/);
  assert.match(output, /\/login <provider>/);
});
