import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDeliveredJobs,
  advanceJob,
  CRON_PROMPT_MAX_CHARS,
  type CronJob,
  dueJobs,
  formatInterval,
  MIN_INTERVAL_MS,
  parseCronCommand,
  parseDuration,
} from "../../../extensions/cron/schedule.ts";

test("parses duration units and rejects nonsense", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("0m"), undefined);
  assert.equal(parseDuration("5"), undefined);
  assert.equal(parseDuration("* * * * *"), undefined);
});

test("rejects durations that overflow after unit conversion", () => {
  const overflowingHours = `${"1"}${"0".repeat(305)}h`;

  assert.equal(parseDuration(overflowingHours), undefined);
  for (const schedule of ["in", "every"]) {
    const parsed = parseCronCommand(
      `${schedule} ${overflowingHours} never fire`,
    );
    assert.equal(parsed.action, "help");
    assert.equal(parsed.intervalMs, undefined);
  }
});

test("parses recurring, one-shot, and management commands", () => {
  const every = parseCronCommand("every 5m check the deploy");
  assert.equal(every.action, "add");
  assert.equal(every.intervalMs, 300_000);
  assert.equal(every.oneShot, false);
  assert.equal(every.prompt, "check the deploy");

  const once = parseCronCommand("in 30s remind me to push");
  assert.equal(once.action, "add");
  assert.equal(once.oneShot, true);

  assert.equal(parseCronCommand("list").action, "list");
  assert.deepEqual(parseCronCommand("remove 2"), { action: "remove", id: 2 });
  assert.equal(parseCronCommand("").action, "help");
});

test("rejects an interval finer than the poll can honor", () => {
  const parsed = parseCronCommand("every 5s do a thing");
  assert.equal(parsed.action, "help");
  assert.match(parsed.error ?? "", /Minimum interval/);
  assert.ok(MIN_INTERVAL_MS >= 30_000);
});

test("accepts the prompt limit unchanged and rejects oversized prompts", () => {
  const maximum = "x".repeat(CRON_PROMPT_MAX_CHARS);

  for (const schedule of ["in 30s", "every 30s"]) {
    const accepted = parseCronCommand(`${schedule} ${maximum}`);
    assert.equal(accepted.action, "add");
    assert.equal(accepted.prompt, maximum);

    const rejected = parseCronCommand(`${schedule} ${maximum}x`);
    assert.equal(rejected.action, "help");
    assert.match(rejected.error ?? "", /Maximum is 2000 characters/);
    assert.equal(rejected.prompt, undefined);
  }
});

test("selects only jobs that are due", () => {
  const jobs: CronJob[] = [
    { id: 1, prompt: "a", nextRunAt: 100 },
    { id: 2, prompt: "b", nextRunAt: 300 },
  ];
  assert.deepEqual(
    dueJobs(jobs, 200).map((j) => j.id),
    [1],
  );
});

test("a recurring job reschedules from now, so a busy gap cannot burst", () => {
  const job: CronJob = {
    id: 1,
    prompt: "poll",
    intervalMs: 60_000,
    nextRunAt: 1_000,
  };
  // Fired late (at 500_000) after a long busy period.
  const next = advanceJob(job, 500_000);
  assert.equal(next?.nextRunAt, 560_000);
  // Exactly one future run is scheduled — no backlog of missed slots.
  assert.deepEqual(dueJobs([next!], 500_001), []);
});

test("a one-shot job drops out after firing", () => {
  assert.equal(advanceJob({ id: 1, prompt: "x", nextRunAt: 0 }, 10), undefined);
});

test("a failed delivery remains due instead of losing the prompt", () => {
  const jobs: CronJob[] = [
    { id: 1, prompt: "one shot", nextRunAt: 0 },
    { id: 2, prompt: "recurring", intervalMs: 30_000, nextRunAt: 0 },
  ];
  assert.deepEqual(advanceDeliveredJobs(jobs, new Set(), 10), jobs);
  assert.deepEqual(advanceDeliveredJobs(jobs, new Set([1, 2]), 10), [
    { id: 2, prompt: "recurring", intervalMs: 30_000, nextRunAt: 30_010 },
  ]);
});

test("formats intervals back to their friendliest unit", () => {
  assert.equal(formatInterval(7_200_000), "2h");
  assert.equal(formatInterval(300_000), "5m");
  assert.equal(formatInterval(45_000), "45s");
});
