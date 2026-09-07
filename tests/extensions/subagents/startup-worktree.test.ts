import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Cause, Effect } from "effect";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentSession,
} from "@earendil-works/pi-coding-agent";
import subagents from "../../../extensions/subagents/index.ts";
import { SpawnError } from "../../../extensions/subagents/src/domain.ts";
import { makePiBackend } from "../../../extensions/subagents/src/backends/pi.ts";
import {
  __setSubagentTestBackends,
  createSubagentRuntime,
  runTool,
  SubagentToolInterruptedError,
} from "../../../extensions/subagents/src/runtime.ts";
import { createPiAgentSessionHarness } from "../../support/pi-agent-session-harness.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const interrupted of [true, false]) {
  test(`isolated startup ${interrupted ? "interruption preserves a pending hook cwd" : "known failure reclaims the empty checkout"}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openpi-startup-worktree-"));
    const cwd = path.join(root, "repo");
    mkdirSync(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "-q"]);
    git(["config", "user.email", "fixture@example.com"]);
    git(["config", "user.name", "fixture"]);
    writeFileSync(path.join(cwd, "file.txt"), "fixture");
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const entered = deferred();
    const release = deferred();
    const resumed = deferred();
    let childCwd = "";
    const model = {
      provider: "fixture",
      id: "model",
      name: "fixture",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 100,
    };
    __setSubagentTestBackends([
      makePiBackend({
        sessionFactory: async (options) => {
          assert.ok(options?.cwd);
          childCwd = options.cwd;
          const harness = createPiAgentSessionHarness({
            model: model as AgentSession["model"],
            activeTools: ["read"],
            bind: async () => {
              entered.resolve();
              await release.promise;
              try {
                writeFileSync(
                  path.join(childCwd, "late-hook.txt"),
                  "late evidence",
                );
              } finally {
                resumed.resolve();
              }
            },
          });
          return { session: harness.session };
        },
        shutdownTimeoutMs: 30,
      }),
    ]);
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    let spawn: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const pi = {
      events: { on() {}, emit() {} },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, handler);
      },
      registerTool(tool: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) {
        if (tool.name === "subagent_spawn") spawn = tool.execute;
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      getActiveTools: () => ["read"],
      setActiveTools() {},
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
      model,
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "model" ? model : undefined,
        getAll: () => [model],
      },
    } as unknown as ExtensionContext;
    subagents(pi);
    const abort = new AbortController();
    try {
      assert.ok(spawn);
      const result = spawn(
        "spawn",
        {
          prompt: "probe",
          name: "probe",
          isolation: "worktree",
          ...(interrupted ? {} : { model: "fixture/missing" }),
        },
        abort.signal,
        undefined,
        ctx,
      ).catch((error: unknown) => error);
      if (interrupted) {
        await entered.promise;
        abort.abort();
      }
      const error = await result;
      assert.ok(error instanceof Error);
      if (interrupted) {
        assert.ok(
          existsSync(childCwd),
          "startup hook still owns its working directory",
        );
        assert.ok(
          error.message.includes(childCwd),
          "failure identifies preserved checkout",
        );
        const branch = execFileSync("git", ["branch", "--show-current"], {
          cwd: childCwd,
          encoding: "utf8",
        }).trim();
        assert.ok(
          error.message.includes(branch),
          "failure identifies preserved branch",
        );
        release.resolve();
        await resumed.promise;
        assert.equal(
          readFileSync(path.join(childCwd, "late-hook.txt"), "utf8"),
          "late evidence",
        );
        assert.equal(
          (git(["worktree", "list", "--porcelain"]).match(/^worktree /gm) ?? [])
            .length,
          2,
        );
      } else {
        assert.match(error.message, /model/i);
        assert.equal(
          (git(["worktree", "list", "--porcelain"]).match(/^worktree /gm) ?? [])
            .length,
          1,
        );
      }
    } finally {
      release.resolve();
      if (childCwd) await resumed.promise;
      await hooks.get("session_shutdown")?.({}, ctx);
      __setSubagentTestBackends(undefined);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runTool preserves canonical runtime interruption without a caller signal", async () => {
  const runtime = createSubagentRuntime();
  try {
    await assert.rejects(
      runTool(runtime, Effect.interrupt, {
        interruptMessage: "spawn interrupted",
      }),
      (error: unknown) =>
        error instanceof SubagentToolInterruptedError &&
        error.message === "spawn interrupted",
    );
    await assert.rejects(
      runTool(
        runtime,
        Effect.failCause(
          Cause.combine(
            Cause.interrupt(1),
            Cause.die(new Error("startup cleanup failed")),
          ),
        ),
      ),
      (error: unknown) =>
        error instanceof SubagentToolInterruptedError &&
        error.message.includes("startup cleanup failed"),
    );
    await assert.rejects(
      runTool(
        runtime,
        Effect.fail(new SpawnError({ message: "known failure" })),
      ),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof SubagentToolInterruptedError) &&
        error.message === "known failure",
    );
  } finally {
    await runtime.dispose();
  }
});
