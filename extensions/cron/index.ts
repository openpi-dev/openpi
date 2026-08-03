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
  dueJobs,
  formatInterval,
  parseCronCommand,
  type CronJob,
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

  const fire = (job: CronJob) => {
    try {
      pi.sendMessage(
        {
          customType: "cron-fire",
          content: job.prompt,
          display: true,
          details: { id: job.id, recurring: job.intervalMs !== undefined },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch {
      // Session may be shutting down; leave the job due for the next tick.
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
    const deliveredIds = new Set<number>();
    for (const job of due) {
      if (fire(job)) deliveredIds.add(job.id);
    }
    jobs = advanceDeliveredJobs(jobs, deliveredIds, now);
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

      const intervalMs = parsed.intervalMs!;
      const job: CronJob = {
        id: nextId++,
        prompt: parsed.prompt!,
        ...(parsed.oneShot ? {} : { intervalMs }),
        nextRunAt: runtime.now() + intervalMs,
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
