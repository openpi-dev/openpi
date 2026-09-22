import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { persistWorkflowJson } from "../../../extensions/workflows/artifacts.ts";
import type { WorkflowDetails } from "../../../extensions/workflows/model.ts";

test("recovery preserves successful batch receipts when a later send fails", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "openpi-completion-recovery-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { default: workflows } = await import(
      "../../../extensions/workflows/index.ts"
    );
    const sessionId = "completion-recovery-session";
    const runIds = Array.from(
      { length: 400 },
      (_, index) => `wf_${index.toString(16).padStart(8, "0")}`,
    );
    for (const runId of runIds) {
      const runDir = join(agentDir, "workflows", runId);
      mkdirSync(runDir, { recursive: true });
      persistWorkflowJson(runDir, {
        runId,
        sessionId,
        background: true,
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        agents: [],
        phases: [],
        result: "completed fixture work",
        delivery: {
          id: `workflow:${runId}`,
          ownerSessionId: sessionId,
          ownerEpoch: 0,
          state: "pending",
          attempts: 0,
          updatedAt: 2,
        },
      });
    }

    const handlers = new Map<string, () => unknown>();
    const accepted: string[][] = [];
    let calls = 0;
    let idle = false;
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: true,
      isIdle: () => idle,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus() {}, setWidget() {} },
    } as unknown as ExtensionContext;
    const pi = {
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools() {},
      on(
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) {
        handlers.set(event, () => handler({}, ctx));
      },
      sendMessage(message: { content: string }) {
        calls++;
        if (calls === 2) throw new Error("second batch transport unavailable");
        const facts = JSON.parse(message.content.split("\n")[1]!) as Array<{
          deliveryId: string;
        }>;
        accepted.push(facts.map((entry) => entry.deliveryId));
      },
    } as unknown as ExtensionAPI;
    workflows(pi);
    await handlers.get("session_start")?.();
    idle = true;
    await handlers.get("agent_settled")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(calls >= 2, "recovery must reach a split transport batch");
    assert.ok(accepted.length >= 1, "the first batch was accepted");
    const firstAccepted = new Set(accepted.flat());
    const readDelivery = (runId: string) =>
      (
        JSON.parse(
          readFileSync(
            join(agentDir, "workflows", runId, "workflow.json"),
            "utf8",
          ),
        ) as WorkflowDetails
      ).delivery!;
    for (const runId of runIds) {
      const receipt = readDelivery(runId);
      assert.equal(
        receipt.state,
        firstAccepted.has(receipt.id) ? "delivered" : "pending",
        `receipt for ${receipt.id}`,
      );
    }

    await handlers.get("agent_settled")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const deliveredIds = accepted.flat();
    assert.equal(deliveredIds.length, runIds.length);
    assert.equal(new Set(deliveredIds).size, runIds.length);
    for (const runId of runIds) {
      const receipt = readDelivery(runId);
      assert.equal(receipt.state, "delivered");
      assert.equal(receipt.attempts, firstAccepted.has(receipt.id) ? 1 : 2);
    }
    await handlers.get("session_shutdown")?.();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
