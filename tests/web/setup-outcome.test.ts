import assert from "node:assert/strict";
import test from "node:test";
import { projectSetupOutcome } from "../../web/protocol/setup-outcome.ts";

const request = (id = "setup-1") => ({
  type: "custom_message",
  id,
  customType: "openpi-setup-request",
});
const message = (message: unknown) => ({ type: "message", message });
const saved = (changed: string[]) =>
  message({
    role: "toolResult",
    toolName: "configure_my_pi_setup",
    isError: false,
    details: { setupReceipt: { changed } },
  });

test("setup projection requires a real save result, never assistant claims or turn completion", () => {
  assert.equal(projectSetupOutcome([], false), undefined);
  const entries = [
    request(),
    message({ role: "assistant", content: "Saved successfully!" }),
  ];
  assert.equal(projectSetupOutcome(entries, true)?.status, "pending");
  assert.equal(projectSetupOutcome(entries, false)?.status, "unconfirmed");
  assert.equal(
    projectSetupOutcome([...entries, saved(["ui.webTheme"])], false)?.status,
    "saved",
  );
  assert.equal(
    projectSetupOutcome([...entries, saved([])], false)?.status,
    "unchanged",
  );
});

test("failure retains recovery evidence; successful retry wins and later cancellation cannot undo a receipt", () => {
  const entries = [
    request(),
    message({
      role: "toolResult",
      toolName: "configure_my_pi_setup",
      isError: true,
      content: [
        {
          type: "text",
          text: "Apply failed; recovery incomplete. Bearer secret",
        },
      ],
    }),
  ];
  const outcome = projectSetupOutcome(entries, false);
  assert.equal(outcome?.status, "failed");
  assert.match(outcome?.error ?? "", /recovery incomplete/);
  assert.doesNotMatch(outcome?.error ?? "", /secret/);
  const aborted = message({ role: "assistant", stopReason: "aborted" });
  assert.equal(
    projectSetupOutcome([...entries, aborted], false)?.status,
    "failed",
  );
  assert.equal(
    projectSetupOutcome([...entries, saved([]), aborted], false)?.status,
    "unchanged",
  );
  assert.equal(
    projectSetupOutcome([request(), aborted], false)?.status,
    "cancelled",
  );
});

test("only the latest setup episode is projected, independent of transcript length and later ordinary errors", () => {
  const entries = [
    request(),
    saved([]),
    message({ role: "user", content: "hello" }),
    request("setup-2"),
  ];
  assert.deepEqual(projectSetupOutcome(entries, true), {
    requestId: "setup-2",
    status: "pending",
  });
  entries.push(
    ...Array.from({ length: 300 }, () =>
      message({ role: "assistant", content: "thinking" }),
    ),
  );
  entries.push(
    message({ role: "user", content: "next task" }),
    message({ role: "assistant", stopReason: "error" }),
  );
  assert.equal(projectSetupOutcome(entries, false)?.status, "unconfirmed");
  assert.equal(
    projectSetupOutcome(
      [
        request(),
        { type: "custom_message", customType: "openpi-setup-closed" },
      ],
      true,
    )?.status,
    "unconfirmed",
  );
});

test("a queued request rejected before delivery replaces a prior successful receipt", () => {
  const entries = [
    request(),
    saved([]),
    {
      type: "custom_message",
      id: "blocked",
      customType: "openpi-setup-closed",
      content: "Exit Plan mode before changing settings.",
      details: { reason: "plan_mode_active" },
    },
  ];
  assert.deepEqual(projectSetupOutcome(entries, false), {
    requestId: "blocked",
    status: "failed",
    error: "Exit Plan mode before changing settings.",
  });
});
