import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import cron from "./index.ts";

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
  const messages: unknown[] = [];
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
    sendMessage(message: unknown) {
      if (failNextDelivery) {
        failNextDelivery = false;
        throw new Error("session unavailable");
      }
      messages.push(message);
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
  await h.run("list");
  assert.equal(h.notifications.at(-1), "No scheduled prompts in this session.");
  assert.equal(h.stopped(), 1);
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
