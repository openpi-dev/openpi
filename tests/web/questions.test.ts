import assert from "node:assert/strict";
import test from "node:test";
import {
  WebQuestionBroker,
  type QuestionOwner,
} from "../../web/host/questions.ts";
import {
  parseWebQuestionAnswers,
  validateWebQuestions,
} from "../../web/protocol/questions.ts";
import { questionFixture } from "./question-fixtures.ts";

const owner: QuestionOwner = {
  workspace: "/workspace",
  sessionId: "session",
  commandId: "prompt",
  epoch: 1,
  controllerId: "ea1e029c-363a-47cf-a917-889e5d0ab477",
};
const answers = [
  {
    id: "scope",
    selected: questionFixture[0]!.options[0]!.label,
    note: "Keep tests",
  },
  { id: "validation", custom: "桌面和手机" },
];

test("handoff requires selected status; free-form and rephrase do not resolve it", async () => {
  const broker = new WebQuestionBroker(
    () => owner,
    () => {},
  );
  const outcome = broker.request("handoff", [questionFixture[0]!], undefined, {
    title: "Sign in",
    instructions: "Sign in in your browser",
    completionSignal: "Account visible",
  });
  const pending = broker.read(owner.sessionId, owner.controllerId)!;
  assert.equal(pending.handoff?.title, "Sign in");
  for (const invalid of [
    { id: "scope", custom: "done" },
    { id: "scope", rephrase: true },
  ]) {
    assert.equal(
      broker.answer(
        owner.sessionId,
        pending.requestId,
        owner.controllerId,
        "answer",
        [invalid],
      ).status,
      400,
    );
    assert.ok(broker.read(owner.sessionId, owner.controllerId));
  }
  assert.equal(
    broker.answer(
      owner.sessionId,
      pending.requestId,
      owner.controllerId,
      "answer",
      [answers[0]],
    ).status,
    200,
  );
  assert.deepEqual(await outcome, { kind: "answered", answers: [answers[0]] });
});

test("answers are exact, bounded, sanitized and complete", () => {
  assert.ok(validateWebQuestions(questionFixture));
  assert.deepEqual(parseWebQuestionAnswers(questionFixture, answers), answers);
  for (const input of [
    [],
    [...answers, answers[0]],
    [answers[1], answers[0]],
    [{ ...answers[0], selected: "invented" }, answers[1]],
    [{ ...answers[0], custom: "ambiguous" }, answers[1]],
    [{ ...answers[0], note: "中".repeat(2667) }, answers[1]],
    [{ ...answers[0], extra: true }, answers[1]],
  ]) {
    assert.equal(parseWebQuestionAnswers(questionFixture, input), undefined);
  }
  assert.deepEqual(
    parseWebQuestionAnswers(
      [questionFixture[0]!],
      [{ id: "scope", custom: " \u001b[31m " }],
    ),
    [{ id: "scope", rephrase: true }],
  );
  assert.equal(
    validateWebQuestions([questionFixture[0]!, questionFixture[0]!]),
    false,
  );
});

test("only the initiating controller answers once; reads are copies and invalid answers keep the wait open", async () => {
  let changes = 0;
  const broker = new WebQuestionBroker(
    () => owner,
    () => changes++,
  );
  const outcome = broker.request("tool-1", questionFixture);
  const request = broker.read(owner.sessionId, owner.controllerId)!;
  assert.ok(request);
  request.questions[0]!.question = "mutated client";
  assert.equal(
    broker.read(owner.sessionId, owner.controllerId)!.questions[0]!.question,
    questionFixture[0]!.question,
  );
  assert.equal(broker.read(owner.sessionId, "another-controller"), null);
  assert.equal(
    broker.answer(
      owner.sessionId,
      request.requestId,
      "another-controller",
      "answer",
      answers,
    ).status,
    403,
  );
  assert.equal(
    broker.answer(
      owner.sessionId,
      request.requestId,
      owner.controllerId,
      "answer",
      [],
    ).status,
    400,
  );
  assert.equal(
    broker.answer(
      owner.sessionId,
      request.requestId,
      owner.controllerId,
      "answer",
      answers,
    ).status,
    200,
  );
  assert.deepEqual(await outcome, { kind: "answered", answers });
  assert.deepEqual(
    broker.answer(
      owner.sessionId,
      request.requestId,
      owner.controllerId,
      "dismiss",
      undefined,
    ).body,
    { state: "answered", replayed: true },
  );
  assert.equal(changes, 2);
  assert.equal(broker.read(owner.sessionId, owner.controllerId), null);
});

test("abort, timeout, replacement and shutdown do not invent answers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current: QuestionOwner | undefined = owner;
  const broker = new WebQuestionBroker(
    () => current,
    () => {},
    100,
  );
  const controller = new AbortController();
  const aborted = broker.request("abort", questionFixture, controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { kind: "cancelled" });
  const timeout = broker.request("timeout", questionFixture);
  t.mock.timers.tick(101);
  assert.deepEqual(await timeout, { kind: "expired" });
  const replaced = broker.request("switch", questionFixture);
  current = { ...owner, epoch: 2 };
  broker.reconcile();
  assert.deepEqual(await replaced, { kind: "cancelled" });
  const stopped = broker.request("stop", questionFixture);
  broker.cancel();
  assert.deepEqual(await stopped, { kind: "cancelled" });
  current = undefined;
  assert.deepEqual(await broker.request("none", questionFixture), {
    kind: "unavailable",
  });
});

test("parallel questions fail closed and dismissal is distinct from cancellation", async () => {
  const broker = new WebQuestionBroker(
    () => owner,
    () => {},
  );
  const first = broker.request("first", questionFixture);
  assert.deepEqual(await broker.request("second", questionFixture), {
    kind: "unavailable",
  });
  const request = broker.read(owner.sessionId, owner.controllerId)!;
  broker.answer(
    owner.sessionId,
    request.requestId,
    owner.controllerId,
    "dismiss",
    undefined,
  );
  assert.deepEqual(await first, { kind: "dismissed" });
});
