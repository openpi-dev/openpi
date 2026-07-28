import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import sessionGoal, {
  admitGoalInput,
  goalConditionRequiredMessage,
  parseGoalCommand,
  statusText,
} from "./index.ts";
import { createGoalSnapshot, type GoalInput } from "./state.ts";

test("goal command recognizes controls and treats other text as objective", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand(" pause "), { action: "pause" });
  assert.deepEqual(parseGoalCommand("resume"), { action: "resume" });
  assert.deepEqual(parseGoalCommand("clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("ship release"), {
    action: "set",
    objective: "ship release",
  });
});

test("cancelled TUI condition is not mislabeled as a non-TUI error", () => {
  assert.equal(
    goalConditionRequiredMessage("tui"),
    "Goal not set: a finite, observable success condition is required.",
  );
  assert.match(goalConditionRequiredMessage("print"), /outside TUI mode/);
  assert.doesNotMatch(goalConditionRequiredMessage("tui"), /outside TUI mode/);
});

test("goal admission rejects duplicated and non-verifiable contracts before persistence", async () => {
  const ctx = {} as ExtensionContext;
  const signal = new AbortController().signal;
  let reviews = 0;
  const vet = async () => {
    reviews++;
    return { verifiable: false, reason: "manual stop is not a finite state" };
  };

  await assert.rejects(
    admitGoalInput(
      { objective: "Keep searching", condition: " Keep   searching " },
      ctx,
      signal,
      vet,
    ),
    /must be distinct/,
  );
  assert.equal(reviews, 0);
  await assert.rejects(
    admitGoalInput(
      { objective: "Research tools", condition: "Run until I stop it" },
      ctx,
      signal,
      vet,
    ),
    /manual stop is not a finite state/,
  );
  await assert.rejects(
    admitGoalInput(
      { objective: "Ship", condition: "Tests pass" },
      ctx,
      signal,
      async () => {
        throw new Error("judge unavailable");
      },
    ),
    /could not be verified: judge unavailable/,
  );
});

test("concurrent goal_set admissions persist and kick off only one goal", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  type CapturedTool = {
    name: string;
    execute: (
      id: string,
      params: GoalInput,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<unknown>;
  };

  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, Handler[]>();
  const entries: { customType: string; data: unknown }[] = [];
  const messages: unknown[] = [];
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const reviews: ((value: { verifiable: boolean; reason: string }) => void)[] =
    [];
  sessionGoal(pi, {
    vet: async () =>
      await new Promise((resolve) => {
        reviews.push(resolve);
      }),
  });

  const ctx = {
    mode: "tui",
    hasUI: false,
    isIdle: () => false,
    signal: undefined,
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, ctx);
  }
  const tool = tools.get("goal_set");
  assert.ok(tool);
  const first = tool.execute(
    "first",
    { objective: "Ship one", condition: "Focused tests pass" },
    undefined,
    undefined,
    ctx,
  );
  const second = tool.execute(
    "second",
    { objective: "Ship two", condition: "Build passes" },
    undefined,
    undefined,
    ctx,
  );
  await Promise.resolve();
  assert.equal(reviews.length, 2);

  reviews[0]!({ verifiable: true, reason: "observable" });
  await first;
  reviews[1]!({ verifiable: true, reason: "observable" });
  await assert.rejects(second, /unfinished session goal already exists/);
  assert.equal(
    entries.filter((entry) => entry.customType === "session-goal").length,
    1,
  );
  assert.equal(messages.length, 1);
});

test("status explains parent versus evaluator token semantics", () => {
  const goal = createGoalSnapshot(
    {
      objective: "Ship",
      condition: "Tests pass",
      tokenBudget: 1_000,
    },
    0,
    1,
    "goal_index_1",
  );
  const text = statusText({ ...goal, parentTokens: 100, evaluatorTokens: 20 });
  assert.match(text, /100\/1000 parent \+ 20 evaluator/);
  assert.match(text, /do not consume the optional parent-run budget/);
  assert.equal(statusText(undefined), "No session goal is set.");
});
