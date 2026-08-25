import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import workspaceCleanupGuard from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface ConfirmOptions {
  signal?: AbortSignal;
}

interface HarnessOptions {
  cwd: string;
  signal?: AbortSignal;
  confirm?: (
    title: string,
    message: string,
    options?: ConfirmOptions,
  ) => Promise<boolean>;
}

function harness(options: HarnessOptions) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: options.cwd,
    signal: options.signal,
    ui: {
      confirm: options.confirm ?? (async () => false),
    },
  } as unknown as ExtensionContext;
  workspaceCleanupGuard(pi);

  return {
    async emit(event: string, value: unknown) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(value, ctx);
      }
      return result;
    },
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "openpi-workspace-cleanup-guard-"),
  );
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function bashCall(id: string, command: string) {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName: "bash",
    input: { command },
  };
}

function writeCall(id: string, target: string) {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName: "write",
    input: { path: target, content: "scratch" },
  };
}

function toolResult(id: string, toolName: "bash" | "write", isError = false) {
  return {
    type: "tool_result",
    toolCallId: id,
    toolName,
    content: [],
    isError,
  };
}

test("confirmed deletion of a pre-existing file proceeds", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "obsolete.txt"), "old");
    const confirmations: Array<{
      title: string;
      message: string;
      signal: AbortSignal | undefined;
    }> = [];
    const controller = new AbortController();
    const h = harness({
      cwd: workspace,
      signal: controller.signal,
      confirm: async (title, message, options) => {
        confirmations.push({ title, message, signal: options?.signal });
        return true;
      },
    });

    assert.equal(
      await h.emit("tool_call", bashCall("remove", "rm obsolete.txt")),
      undefined,
    );
    assert.deepEqual(confirmations, [
      {
        title: "Delete pre-existing workspace files?",
        message:
          "The command would delete files that existed before this agent changed them:\n\n- obsolete.txt\n\nAllow this exact deletion?",
        signal: controller.signal,
      },
    ]);
  });
});

test("refused deletion of a pre-existing file is blocked", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "keep.txt");
    await writeFile(target, "keep");
    const h = harness({ cwd: workspace, confirm: async () => false });

    const result = (await h.emit(
      "tool_call",
      bashCall("remove", "rm keep.txt"),
    )) as { block?: boolean; reason?: string } | undefined;

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /keep\.txt/u);
  });
});

test("cancelling the active turn dismisses confirmation and blocks deletion", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const controller = new AbortController();
    const h = harness({
      cwd: workspace,
      signal: controller.signal,
      confirm: async (_title, _message, options) => {
        assert.equal(options?.signal, controller.signal);
        return new Promise<boolean>((resolve) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            resolve(false);
            return;
          }
          signal?.addEventListener("abort", () => resolve(false), {
            once: true,
          });
        });
      },
    });

    const pending = h.emit("tool_call", bashCall("remove", "rm keep.txt"));
    controller.abort(new Error("cancelled fixture"));
    const result = (await pending) as
      | { block?: boolean; reason?: string }
      | undefined;

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /keep\.txt/u);
  });
});

test("confirmation errors fail closed and do not corrupt a retry", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let attempts = 0;
    const h = harness({
      cwd: workspace,
      confirm: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("confirmation unavailable");
        return false;
      },
    });

    await assert.rejects(
      h.emit("tool_call", bashCall("first-remove", "rm keep.txt")),
      /confirmation unavailable/u,
    );
    const retry = (await h.emit(
      "tool_call",
      bashCall("retry-remove", "rm keep.txt"),
    )) as { block?: boolean } | undefined;

    assert.equal(retry?.block, true);
    assert.equal(attempts, 2);
  });
});

test("a file created through Write can be cleaned up without confirmation", async () => {
  await withWorkspace(async (workspace) => {
    let confirmations = 0;
    const h = harness({
      cwd: workspace,
      confirm: async () => {
        confirmations += 1;
        return false;
      },
    });

    await h.emit("tool_call", writeCall("create", "scratch.txt"));
    await writeFile(path.join(workspace, "scratch.txt"), "scratch");
    await h.emit("tool_result", toolResult("create", "write"));

    assert.equal(
      await h.emit("tool_call", bashCall("remove", "rm -f scratch.txt")),
      undefined,
    );
    assert.equal(confirmations, 0);
  });
});

test("settlement clears provenance from the completed agent run", async () => {
  await withWorkspace(async (workspace) => {
    const h = harness({ cwd: workspace, confirm: async () => false });

    await h.emit("tool_call", writeCall("create", "scratch.txt"));
    await writeFile(path.join(workspace, "scratch.txt"), "scratch");
    await h.emit("tool_result", toolResult("create", "write"));
    await h.emit("agent_settled", { type: "agent_settled" });

    const result = (await h.emit(
      "tool_call",
      bashCall("remove", "rm -f scratch.txt"),
    )) as { block?: boolean } | undefined;
    assert.equal(result?.block, true);
  });
});
