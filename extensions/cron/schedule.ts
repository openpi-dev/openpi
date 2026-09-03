/**
 * Pure scheduling logic for `/cron`. Kept free of timers, IO, and session
 * state so the tricky parts — parsing, due-ness, and how a recurring job
 * advances after a missed window — are directly testable.
 */

export interface CronJob {
  readonly id: number;
  /** Prompt delivered to the agent when the job fires. */
  readonly prompt: string;
  /** Milliseconds between runs; undefined for a one-shot job. */
  readonly intervalMs?: number;
  /** Absolute epoch ms of the next run. */
  readonly nextRunAt: number;
}

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

export const MIN_INTERVAL_MS = 30_000;
export const CRON_PROMPT_MAX_CHARS = 2_000;
export const CRON_MAX_JOBS = 64;
export const CRON_DELIVERY_MAX_JOBS = 16;
export const CRON_DELIVERY_MAX_BYTES = 48 * 1024;

/**
 * Parse a duration like `30s`, `5m`, `2h`. Deliberately a small duration
 * grammar rather than crontab syntax: the ~30s poll cannot honor finer cron
 * fields, so accepting them would promise precision that does not exist.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)\s*([smh])$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const durationMs = value * UNITS[match[2].toLowerCase()];
  return Number.isSafeInteger(durationMs) ? durationMs : undefined;
}

export interface ParsedCronCommand {
  action: "add" | "list" | "remove" | "help";
  /** add: every <duration> (recurring) or in <duration> (one-shot). */
  intervalMs?: number;
  oneShot?: boolean;
  prompt?: string;
  id?: number;
  error?: string;
}

/**
 * Parse `/cron` arguments:
 *   every 5m <prompt>   recurring
 *   in 30s <prompt>     one-shot
 *   list | remove <id>  management
 */
export function parseCronCommand(raw: string): ParsedCronCommand {
  const args = raw.trim();
  if (!args || args === "help") return { action: "help" };
  if (args === "list") return { action: "list" };

  const remove = /^remove\s+(\d+)$/i.exec(args);
  if (remove) return { action: "remove", id: Number(remove[1]) };

  const schedule = /^(every|in)\s+(\S+)\s+([\s\S]+)$/i.exec(args);
  if (!schedule) {
    return {
      action: "help",
      error:
        "Usage: /cron every <5m> <prompt> | in <30s> <prompt> | list | remove <id>",
    };
  }
  const intervalMs = parseDuration(schedule[2]);
  if (intervalMs === undefined) {
    return {
      action: "help",
      error: `Could not read "${schedule[2]}" as a duration. Use 30s, 5m, or 2h.`,
    };
  }
  if (intervalMs < MIN_INTERVAL_MS) {
    return {
      action: "help",
      error: `Minimum interval is ${MIN_INTERVAL_MS / 1000}s (the scheduler polls about that often).`,
    };
  }
  const prompt = schedule[3].trim();
  if (!prompt) return { action: "help", error: "Provide a prompt to run." };
  if (prompt.length > CRON_PROMPT_MAX_CHARS) {
    return {
      action: "help",
      error: `Prompt is too long. Maximum is ${CRON_PROMPT_MAX_CHARS} characters.`,
    };
  }
  return {
    action: "add",
    intervalMs,
    oneShot: schedule[1].toLowerCase() === "in",
    prompt,
  };
}

/** Jobs whose next run is at or before `now`. */
export function dueJobs(jobs: readonly CronJob[], now: number) {
  return jobs.filter((job) => job.nextRunAt <= now);
}

/** Advance only jobs whose prompt was successfully queued for delivery. */
export function advanceDeliveredJobs(
  jobs: readonly CronJob[],
  deliveredIds: ReadonlySet<number>,
  now: number,
) {
  return jobs.flatMap((job) => {
    if (!deliveredIds.has(job.id)) return [job];
    const next = advanceJob(job, now);
    return next ? [next] : [];
  });
}

/**
 * Next state for a job that just fired: one-shots drop out, recurring jobs
 * schedule from NOW rather than from the missed slot, so a long busy gap can
 * never produce a burst of catch-up runs.
 */
export function advanceJob(job: CronJob, now: number): CronJob | undefined {
  if (job.intervalMs === undefined) return undefined;
  return { ...job, nextRunAt: now + job.intervalMs };
}

/** Human-readable duration for listings. */
export function formatInterval(ms: number) {
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`;
  if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`;
  return `${Math.round(ms / UNITS.s)}s`;
}
