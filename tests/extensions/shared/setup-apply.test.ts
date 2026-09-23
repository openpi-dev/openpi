import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  applySetupConfiguration,
  onSetupApply,
} from "../../../extensions/shared/setup-apply.ts";

test("real Pi event bus reports synchronous and asynchronous apply errors to the caller", async () => {
  const events = createEventBus();
  const pi = { events } satisfies Pick<ExtensionAPI, "events">;
  let applied = false;
  const stop = onSetupApply(pi, () => {
    throw new Error("sync failure");
  });
  onSetupApply(pi, async () => {
    await Promise.resolve();
    applied = true;
  });
  await assert.rejects(applySetupConfiguration(pi), /consumer failed/);
  assert.equal(applied, true);
  stop();
  await applySetupConfiguration(pi);
  onSetupApply(pi, async () => {
    throw new Error("async failure");
  });
  await assert.rejects(applySetupConfiguration(pi), /consumer failed/);
  events.clear();
  await applySetupConfiguration(pi);
});
