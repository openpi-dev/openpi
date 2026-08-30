import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import cron from "../../../extensions/cron/index.ts";
import { CRON_PROMPT_MAX_CHARS } from "../../../extensions/cron/schedule.ts";

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
