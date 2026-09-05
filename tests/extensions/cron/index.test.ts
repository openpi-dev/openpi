import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import cron from "../../../extensions/cron/index.ts";
import {
  CRON_DELIVERY_MAX_BYTES,
  CRON_DELIVERY_MAX_JOBS,
  CRON_MAX_JOBS,
  CRON_PROMPT_MAX_CHARS,
} from "../../../extensions/cron/schedule.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function harness() {
  const handlers = new Map<string, Handler[]>();
  let command: CommandHandler | undefined;
  let tick: (() => void) | undefined;
  let now = 0;
  let idle = true;
  let failNextDelivery = false;
  let stopped = 0;
  let advanceOnDeliveryMs = 0;
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const notifications: string[] = [];
  const ctx = {
    isIdle: () => idle,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand(_name: string, definition: { handler: CommandHandler }) {
      command = definition.handler;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: unknown, options: unknown) {
      if (failNextDelivery) {
        failNextDelivery = false;
        throw new Error("session unavailable");
      }
      messages.push({ message, options });
      now += advanceOnDeliveryMs;
      advanceOnDeliveryMs = 0;
    },
  } as unknown as ExtensionAPI;
  cron(pi, {
    now: () => now,
    startPolling(callback) {
      tick = callback;
      return () => {
        stopped++;
        tick = undefined;
      };
    },
  });

  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const run = async (args: string) => {
    assert.ok(command);
    await command(args, ctx);
  };
  return {
    emit,
    run,
    messages,
    notifications,
    setNow(value: number) {
      now = value;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    failNextDelivery() {
      failNextDelivery = true;
    },
    advanceOnDelivery(value: number) {
      advanceOnDeliveryMs = value;
    },
    poll() {
      assert.ok(tick, "scheduler must be running");
      tick();
    },
    polling: () => tick !== undefined,
    stopped: () => stopped,
  };
}

test("cron fires only while idle and retries a failed one-shot delivery", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("in 30s inspect the deploy");
  h.setNow(30_000);
  h.setIdle(false);
  h.poll();
  assert.equal(h.messages.length, 0);

  h.setIdle(true);
  h.failNextDelivery();
  h.poll();
  assert.equal(h.messages.length, 0);
  await h.run("list");
  assert.match(h.notifications.at(-1) ?? "", /inspect the deploy/);

  h.poll();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0], {
    message: {
      customType: "cron-fire",
      content: "[cron 1 · once]\ninspect the deploy",
      display: true,
      details: { id: 1, prompt: "inspect the deploy", recurring: false },
    },
    options: { deliverAs: "followUp", triggerTurn: true },
  });
  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
  assert.equal(h.stopped(), 1);
});

test("cron batches every job due in one tick into one triggered turn", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("in 30s inspect the deploy");
  await h.run("every 30s check the rollout");

  h.setNow(30_000);
  h.poll();

  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0], {
    message: {
      customType: "cron-fire",
      content:
        "2 scheduled prompts are due:\n\n[cron 1 · once]\ninspect the deploy\n\n[cron 2 · recurring]\ncheck the rollout",
      display: true,
      details: {
        count: 2,
        jobs: [
          { id: 1, prompt: "inspect the deploy", recurring: false },
          { id: 2, prompt: "check the rollout", recurring: true },
        ],
      },
    },
    options: { deliverAs: "followUp", triggerTurn: true },
  });

  await h.run("list");
  assert.doesNotMatch(h.notifications.at(-1) ?? "", /inspect the deploy/);
  assert.match(h.notifications.at(-1) ?? "", /check the rollout/);
});

test("a recurring cron interval starts at successful delivery time", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("every 30s check the rollout");
  h.setNow(30_000);
  h.advanceOnDelivery(5_000);

  h.poll();
  await h.run("list");
  assert.match(h.notifications.at(-1) ?? "", /next in 30s/);
});

test("a failed cron batch leaves every due job pending for one retry", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("in 30s inspect the deploy");
  await h.run("in 30s inspect the logs");
  h.setNow(30_000);

  h.failNextDelivery();
  h.poll();
  assert.equal(h.messages.length, 0);
  await h.run("list");
  assert.match(h.notifications.at(-1) ?? "", /inspect the deploy/);
  assert.match(h.notifications.at(-1) ?? "", /inspect the logs/);

  h.poll();
  assert.equal(h.messages.length, 1);
  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
});

test("cron shutdown clears jobs and stops future delivery", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.run("every 30s keep watching");
  await h.emit("session_shutdown");
  assert.equal(h.stopped(), 1);

  h.setNow(60_000);
  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
  assert.equal(h.messages.length, 0);
});

test("cron does not create a job when the prompt exceeds the limit", async () => {
  const h = harness();
  await h.emit("session_start");
  const oversized = "x".repeat(CRON_PROMPT_MAX_CHARS + 1);

  for (const schedule of ["in 30s", "every 30s"]) {
    await h.run(`${schedule} ${oversized}`);
    assert.match(h.notifications.at(-1) ?? "", /Maximum is 2000 characters/);
  }

  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
  assert.equal(h.messages.length, 0);
});

test("cron rejects an absolute due time that is not safely representable", async () => {
  const h = harness();
  await h.emit("session_start");
  h.setNow(Number.MAX_SAFE_INTEGER - 29_999);

  await h.run("in 30s never fire");

  assert.match(h.notifications.at(-1) ?? "", /too far in the future/i);
  assert.equal(h.polling(), false);
  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
});

test("cron rejects jobs beyond the per-session limit", async () => {
  const h = harness();
  await h.emit("session_start");

  for (let index = 1; index <= CRON_MAX_JOBS; index++) {
    await h.run(`in 30s job ${index}`);
  }
  await h.run("in 30s one too many");

  assert.match(
    h.notifications.at(-1) ?? "",
    new RegExp(`at most ${CRON_MAX_JOBS}`, "i"),
  );
  h.setNow(30_000);
  while (h.polling()) h.poll();
  const delivered = h.messages.flatMap((entry) => {
    const details = (entry.message as { details: unknown }).details;
    return "jobs" in (details as object)
      ? (details as { jobs: Array<{ id: number }> }).jobs
      : [details as { id: number }];
  });
  assert.equal(delivered.length, CRON_MAX_JOBS);
  assert.deepEqual(
    delivered.map((job) => job.id),
    Array.from({ length: CRON_MAX_JOBS }, (_, index) => index + 1),
  );
});

test("cron bounds each due batch by job count and keeps the rest pending", async () => {
  const h = harness();
  await h.emit("session_start");

  for (let index = 1; index <= CRON_DELIVERY_MAX_JOBS + 1; index++) {
    await h.run(`in 30s job ${index}`);
  }
  h.setNow(30_000);
  h.poll();

  const firstDetails = (
    h.messages[0]?.message as {
      details: { count: number; jobs: Array<{ id: number }> };
    }
  ).details;
  assert.equal(firstDetails.count, CRON_DELIVERY_MAX_JOBS);
  assert.deepEqual(
    firstDetails.jobs.map((job) => job.id),
    Array.from({ length: CRON_DELIVERY_MAX_JOBS }, (_, index) => index + 1),
  );
  await h.run("list");
  assert.match(h.notifications.at(-1) ?? "", /17\. once/);

  h.poll();
  assert.deepEqual(
    (h.messages[1]?.message as { details: { id: number } }).details,
    {
      id: CRON_DELIVERY_MAX_JOBS + 1,
      prompt: `job ${CRON_DELIVERY_MAX_JOBS + 1}`,
      recurring: false,
    },
  );
});

test("cron bounds model-visible due batches by UTF-8 bytes", async () => {
  const h = harness();
  await h.emit("session_start");
  const prompt = "界".repeat(CRON_PROMPT_MAX_CHARS);

  for (let index = 0; index < CRON_DELIVERY_MAX_JOBS; index++) {
    await h.run(`in 30s ${prompt}`);
  }
  h.setNow(30_000);
  h.poll();

  const first = h.messages[0]?.message as {
    content: string;
    details: { count: number };
  };
  assert.ok(
    Buffer.byteLength(first.content, "utf8") <= CRON_DELIVERY_MAX_BYTES,
  );
  assert.ok(first.details.count < CRON_DELIVERY_MAX_JOBS);
  await h.run("list");
  assert.notEqual(
    h.notifications.at(-1),
    "No scheduled prompts in this session.",
  );

  while (h.polling()) h.poll();
  for (const entry of h.messages) {
    const content = (entry.message as { content: string }).content;
    assert.ok(Buffer.byteLength(content, "utf8") <= CRON_DELIVERY_MAX_BYTES);
  }
});
