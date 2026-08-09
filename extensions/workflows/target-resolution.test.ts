import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-targets-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: workflows } = await import("./index.ts");
const { resolveWorkflowRunTarget } = await import("./model.ts");

type CapturedTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionContext,
  ) => unknown;
};

test("run target resolution prefers exact ids and bounds ambiguous or missing errors", () => {
  const candidates = Array.from(
    { length: 20 },
    (_, index) => `wf_${index.toString(16).padStart(2, "0")}a`,
  );
  assert.deepEqual(resolveWorkflowRunTarget("WF_00A", candidates), {
    ok: true,
    runId: "wf_00a",
  });
  assert.deepEqual(resolveWorkflowRunTarget("01a", candidates), {
    ok: true,
    runId: "wf_01a",
  });

  const ambiguous = resolveWorkflowRunTarget("a", candidates);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /ambiguous/i);
  assert.match(ambiguous.error, /\+12 more/);
  assert.ok(ambiguous.error.length < 1_000);

  const missing = resolveWorkflowRunTarget("ffff", candidates);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No workflow run matching/);
  assert.match(missing.error, /\+12 more/);
  assert.ok(missing.error.length < 1_000);
});

test("an ambiguous short suffix cannot stop or inspect either active run", async () => {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, Array<() => unknown>>();
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    on(event: string, handler: () => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getThinkingLevel: () => "off",
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => false,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "target-resolution-session",
      getEntries: () => [],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      setWidget() {},
    },
  } as unknown as ExtensionContext;
  workflows(pi);

  const workflow = tools.get("workflow");
  const stop = tools.get("workflow_stop");
  const status = tools.get("workflow_status");
  assert.ok(workflow && stop && status);

  const runIds: string[] = [];
  try {
    // Seventeen live IDs guarantee that two share a one-hex-character suffix.
    for (let index = 0; index < 17; index++) {
      const result = (await workflow.execute(
        `workflow-${index}`,
        {
          script:
            'export const meta = { name: "pending", phases: [] };\nawait new Promise(() => {});',
          background: true,
        },
        undefined,
        undefined,
        ctx,
      )) as { details?: { runId?: unknown } };
      const runId = result.details?.runId;
      assert.equal(typeof runId, "string");
      if (typeof runId === "string") runIds.push(runId);
    }

    const bySuffix = new Map<string, string[]>();
    for (const runId of runIds) {
      const suffix = runId.at(-1)!;
      bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), runId]);
    }
    const collision = [...bySuffix].find(([, ids]) => ids.length > 1);
    assert.ok(collision);
    const [suffix, matchingIds] = collision;

    await assert.rejects(
      Promise.resolve().then(() => stop.execute("stop", { runId: suffix })),
      /ambiguous/i,
    );
    await assert.rejects(
      Promise.resolve().then(() => status.execute("status", { runId: suffix })),
      /ambiguous/i,
    );

    for (const runId of matchingIds) {
      const inspected = (await status.execute("status-exact", { runId })) as {
        details?: { runs?: Array<{ runId?: unknown; status?: unknown }> };
      };
      assert.deepEqual(inspected.details?.runs?.[0], {
        runId,
        name: "pending",
        status: "running",
        done: 0,
        failed: 0,
        total: 0,
      });
    }
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler();
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
});
