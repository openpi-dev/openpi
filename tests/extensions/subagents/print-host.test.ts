import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNonInteractiveSpawnContinuation,
  buildPrintHostPendingFollowUp,
  canDeliverLaterFromHost,
  printHostNeedsFollowUp,
} from "../../../extensions/subagents/src/print-host.ts";

test("only the interactive TUI can deliver a later parent turn", () => {
  assert.equal(canDeliverLaterFromHost({ hasUI: true, mode: "tui" }), true);
  assert.equal(canDeliverLaterFromHost({ hasUI: true, mode: "rpc" }), false);
  assert.equal(canDeliverLaterFromHost({ hasUI: false, mode: "tui" }), false);
  assert.equal(canDeliverLaterFromHost({}), false);
});

test("print hosts with running direct children need a follow-up barrier", () => {
  assert.equal(printHostNeedsFollowUp(false, 1), true);
  assert.equal(printHostNeedsFollowUp(true, 1), false);
  assert.equal(printHostNeedsFollowUp(false, 0), false);
});

test("print-host pending follow-up names the ids and forbids ending the turn", () => {
  const text = buildPrintHostPendingFollowUp(["sa-1", "sa-2"]);
  assert.match(text, /sa-1/);
  assert.match(text, /sa-2/);
  assert.match(text, /MUST call subagent_wait/);
  assert.match(text, /no automatic re-invoke/i);
});

test("non-interactive spawn continuation requires wait and does not release the turn", () => {
  const text = buildNonInteractiveSpawnContinuation("sa-9");
  assert.match(text, /subagent_wait\(ids: \["sa-9"\]\)/);
  assert.match(text, /MUST call subagent_wait/);
  assert.doesNotMatch(text, /end your turn/i);
  assert.doesNotMatch(text, /automatically re-invoked/i);
});
