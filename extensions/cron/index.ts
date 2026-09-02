/**
 * cron: user-scheduled prompts for this session.
 *
 * `/cron every 5m <prompt>` or `/cron in 30s <prompt>` queues a prompt that
 * fires on a timer. Jobs live only in this session (in memory, cleared on
 * shutdown) — deliberately no persisted config and no model tool: this is a
 * user affordance, not something the agent schedules for itself.
 *
 * A job fires only when the session is idle, delivered the same way every
 * other background completion is (followUp + triggerTurn), so it can never
 * interrupt a streaming turn.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  advanceDeliveredJobs,
  CRON_DELIVERY_MAX_BYTES,
  CRON_DELIVERY_MAX_JOBS,
  CRON_MAX_JOBS,
  type CronJob,
  dueJobs,
  formatInterval,
  parseCronCommand,
} from "./schedule.ts";

/** How often the scheduler looks for due jobs. */
const POLL_MS = 30_000;

interface CronRuntime {
  now(): number;
  startPolling(tick: () => void): () => void;
}

const SYSTEM_RUNTIME: CronRuntime = {
  now: Date.now,
  startPolling(tick) {
    const timer = setInterval(tick, POLL_MS);
    // Never hold the process open for a scheduled prompt.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

function deliveryMessage(due: readonly CronJob[]) {
  const jobs = due.map((job) => ({
    id: job.id,
    prompt: job.prompt,
    recurring: job.intervalMs !== undefined,
  }));
  return due.length === 1
    ? {
        customType: "cron-fire",
        content: `[cron ${jobs[0]!.id} · ${jobs[0]!.recurring ? "recurring" : "once"}]\n${jobs[0]!.prompt}`,
        display: true,
        details: jobs[0]!,
      }
    : {
        customType: "cron-fire",
        content: `${due.length} scheduled prompts are due:\n\n${jobs
          .map(
            (job) =>
              `[cron ${job.id} · ${job.recurring ? "recurring" : "once"}]\n${job.prompt}`,
          )
          .join("\n\n")}`,
        display: true,
        details: { count: jobs.length, jobs },
      };
}

function dueDeliveryBatch(due: readonly CronJob[]) {
  const selected: CronJob[] = [];
  for (const job of due.slice(0, CRON_DELIVERY_MAX_JOBS)) {
    const candidate = [...selected, job];
    const message = deliveryMessage(candidate);
    if (
      new TextEncoder().encode(message.content).byteLength >
      CRON_DELIVERY_MAX_BYTES
    ) {
      break;
    }
    selected.push(job);
  }
  return selected;
}

export default function cron(
  pi: ExtensionAPI,
  runtime: CronRuntime = SYSTEM_RUNTIME,
) {
  let jobs: CronJob[] = [];
  let nextId = 1;
  let stopPolling: (() => void) | undefined;
  let context: ExtensionContext | undefined;

  const stopTicker = () => {
    stopPolling?.();
    stopPolling = undefined;
  };

  const fire = (due: readonly CronJob[]) => {
    if (due.length === 0) return true;
    try {
      const message = deliveryMessage(due);
      pi.sendMessage<
        | { id: number; prompt: string; recurring: boolean }
        | {
            count: number;
            jobs: Array<{ id: number; prompt: string; recurring: boolean }>;
          }
      >(message, {
        deliverAs: "followUp",
        triggerTurn: true,
      });
      return true;
    } catch {
      // Session may be shutting down; leave the whole batch due for the next
      // tick. A partial advance would silently lose prompts.
      return false;
    }
  };

  const tick = () => {
    const ctx = context;
    if (!ctx || jobs.length === 0) return;
    // Only fire into an idle session: a followUp during a live turn would
    // queue behind it anyway, and firing on a timer mid-stream is surprising.
    if (!ctx.isIdle()) return;
    const now = runtime.now();
    const due = dueJobs(jobs, now);
    if (due.length === 0) return;
    const batch = dueDeliveryBatch(due);
    if (batch.length === 0) return;
    const deliveredIds = new Set<number>();
    if (fire(batch)) {
      for (const job of batch) deliveredIds.add(job.id);
    }
    jobs = advanceDeliveredJobs(jobs, deliveredIds, runtime.now());
    if (jobs.length === 0) stopTicker();
  };

  const startTicker = () => {
    if (stopPolling) return;
    stopPolling = runtime.startPolling(tick);
  };

  pi.registerCommand("cron", {
    description:
      "Schedule a prompt for this session (`/cron every 5m <prompt>`, `/cron in 30s <prompt>`, `/cron list`, `/cron remove <id>`)",
    handler: async (rawArgs, ctx) => {
      const parsed = parseCronCommand(rawArgs);

      if (parsed.action === "help") {
        ctx.ui.notify(
          parsed.error ??
            "Usage: /cron every <5m> <prompt> · /cron in <30s> <prompt> · /cron list · /cron remove <id>\nJobs live in this session only and fire when the session is idle.",
          parsed.error ? "warning" : "info",
        );
        return;
      }

      if (parsed.action === "list") {
        if (jobs.length === 0) {
          ctx.ui.notify("No scheduled prompts in this session.", "info");
          return;
        }
        const now = runtime.now();
        const lines = jobs.map((job) => {
          const inSeconds = Math.max(
            0,
            Math.round((job.nextRunAt - now) / 1000),
          );
          const when = job.intervalMs
            ? `every ${formatInterval(job.intervalMs)}`
            : "once";
          return `${job.id}. ${when} · next in ${inSeconds}s · ${job.prompt}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (parsed.action === "remove") {
        const before = jobs.length;
        jobs = jobs.filter((job) => job.id !== parsed.id);
        if (jobs.length === 0) stopTicker();
        ctx.ui.notify(
          jobs.length === before
            ? `No scheduled prompt with id ${parsed.id}.`
            : `Removed scheduled prompt ${parsed.id}.`,
          jobs.length === before ? "warning" : "info",
        );
        return;
      }

      if (jobs.length >= CRON_MAX_JOBS) {
        ctx.ui.notify(
          `A session can have at most ${CRON_MAX_JOBS} scheduled prompts. Remove one before adding another.`,
          "warning",
        );
        return;
      }

      const intervalMs = parsed.intervalMs!;
      const now = runtime.now();
      const nextRunAt = now + intervalMs;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(nextRunAt)) {
        ctx.ui.notify(
          "Scheduled time is too far in the future. Use a shorter duration.",
          "warning",
        );
        return;
      }
      const job: CronJob = {
        id: nextId++,
        prompt: parsed.prompt!,
        ...(parsed.oneShot ? {} : { intervalMs }),
        nextRunAt,
      };
      jobs.push(job);
      startTicker();
      ctx.ui.notify(
        parsed.oneShot
          ? `Scheduled prompt ${job.id} once in ${formatInterval(intervalMs)}.`
          : `Scheduled prompt ${job.id} every ${formatInterval(intervalMs)}.`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });

  pi.on("session_shutdown", () => {
    stopTicker();
    jobs = [];
    context = undefined;
  });
}
