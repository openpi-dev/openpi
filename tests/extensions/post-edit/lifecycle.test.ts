import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import postEdit from "../../../extensions/post-edit/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (source: string) =>
  `exec ${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(source)}`;

async function formatterGate() {
  const connected = deferred<Socket>();
  const server = createServer((socket) => connected.resolve(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  // The foreground process cannot write or exit until the test releases it.
  const command = nodeCommand(`
    const fs = require('node:fs');
    const socket = require('node:net').connect(${address.port}, '127.0.0.1');
    socket.once('data', () => {
      fs.writeFileSync('target.txt', 'formatted\\n');
      socket.end();
    });
  `);
  return {
    command,
    connected: connected.promise,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withSession(
  command: string,
  run: (h: {
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    cwd: string;
    notices: string[];
    enqueue: (call?: ToolCall) => void;
    observeNextPrompt: () => Promise<void>;
    observeNextStart: () => Promise<void>;
    observeNextTool: () => Promise<void>;
    modelEntries: () => number;
    toolAdmissions: () => number;
  }) => Promise<void>,
  omitAgentStartFence = false,
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-post-edit-lifecycle-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false }, retry: { enabled: false } },
    { projectTrusted: false },
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = {
    id: "fixture",
    name: "Fixture",
    api: "openai-completions" as const,
    provider: "post-edit-test",
    baseUrl: "http://invalid.invalid",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1000,
  };
  const responses: Array<ToolCall | undefined> = [];
  let entries = 0;
  let admissions = 0;
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "synthetic-test-only",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple(_model, _context, options) {
      entries++;
      const call = responses.shift();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: call ? [call] : [{ type: "text", text: "done" }],
        stopReason: call ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      if (options?.signal?.aborted) {
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            ...message,
            content: [],
            stopReason: "aborted",
            errorMessage: "Fixture aborted",
          },
        });
        return stream;
      }
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    },
  });
  let beforePrompt = deferred<void>();
  let beforeStart = deferred<void>();
  let beforeTool = deferred<void>();
  const executions: Promise<ExecResult>[] = [];
  const observe: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", () => beforePrompt.resolve());
    pi.on("agent_start", () => beforeStart.resolve());
    pi.on("tool_call", () => beforeTool.resolve());
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      observe,
      (pi) =>
        postEdit(
          {
            ...pi,
            // Only the dedicated backstop tests omit this registration;
            // all other hooks and every tool execute through real Pi.
            on: ((event: string, handler: unknown) => {
              if (!(omitAgentStartFence && event === "agent_start")) {
                Reflect.apply(pi.on, pi, [event, handler]);
              }
            }) as ExtensionAPI["on"],
            exec(...args) {
              // Observe the real process only so teardown can join it, including
              // when a regression makes an ordering assertion fail early.
              const execution = pi.exec(...args);
              executions.push(execution);
              return execution;
            },
          },
          () => command,
        ),
      (pi) => {
        pi.on("tool_call", () => {
          admissions++;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const notices: string[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message) => {
        notices.push(message);
      },
    },
  });
  try {
    await run({
      session,
      cwd,
      notices,
      enqueue: (call) => responses.push(call),
      observeNextPrompt: () => {
        beforePrompt = deferred<void>();
        return beforePrompt.promise;
      },
      observeNextStart: () => {
        beforeStart = deferred<void>();
        return beforeStart.promise;
      },
      observeNextTool: () => {
        beforeTool = deferred<void>();
        return beforeTool.promise;
      },
      modelEntries: () => entries,
      toolAdmissions: () => admissions,
    });
  } finally {
    await Promise.all(executions);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
}

const write = (content: string): ToolCall => ({
  type: "toolCall",
  id: "write-fixture",
  name: "write",
  arguments: { path: "target.txt", content },
});

test("real Pi waits for a foreground formatter before the next prompt reaches its model", {
  timeout: 15_000,
}, async () => {
  const gate = await formatterGate();
  try {
    await withSession(gate.command, async (h) => {
      h.enqueue(write("initial\n"));
      await h.session.prompt("write fixture");
      const socket = await gate.connected;
      const entries = h.modelEntries();
      const reachedPreflight = h.observeNextPrompt();
      const next = h.session.prompt("observe formatted fixture");
      try {
        await reachedPreflight;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          h.modelEntries(),
          entries,
          "next prompt must join the formatter before model entry",
        );
      } finally {
        socket.end("release");
        await next;
      }
      assert.equal(
        await readFile(path.join(h.cwd, "target.txt"), "utf8"),
        "formatted\n",
      );
      assert.equal(h.modelEntries(), entries + 1);
    });
  } finally {
    await gate.close();
  }
});

for (const name of ["write", "edit", "bash", "read"] as const) {
  test(`real Pi native ${name} backstop joins formatter with agent_start fence omitted`, {
    timeout: 15_000,
  }, async () => {
    const gate = await formatterGate();
    try {
      await withSession(
        gate.command,
        async (h) => {
          h.enqueue(write("initial\n"));
          await h.session.prompt("write fixture");
          const socket = await gate.connected;
          h.enqueue(
            name === "write"
              ? write("next\n")
              : {
                  type: "toolCall",
                  id: "next-fixture",
                  name,
                  arguments:
                    name === "read"
                      ? { path: "target.txt" }
                      : name === "edit"
                        ? {
                            path: "target.txt",
                            edits: [{ oldText: "formatted", newText: "next" }],
                          }
                        : { command: "printf 'next\\n' > target.txt" },
                },
          );
          // The harness explicitly omits only post-edit's agent_start handler.
          // Direct agent.prompt bypasses preflight, retaining native tool dispatch.
          const reachedTool = h.observeNextTool();
          const admissions = h.toolAdmissions();
          const next = h.session.agent.prompt("access fixture");
          try {
            await reachedTool;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(
              h.toolAdmissions(),
              admissions,
              "native tool must not pass the post-edit fence before release",
            );
            assert.equal(
              await readFile(path.join(h.cwd, "target.txt"), "utf8"),
              "initial\n",
            );
          } finally {
            socket.end("release");
            await next;
          }
          assert.equal(
            await readFile(path.join(h.cwd, "target.txt"), "utf8"),
            name === "read" ? "formatted\n" : "next\n",
          );
          if (name === "read") {
            const result = h.session.messages.find(
              (message) =>
                message.role === "toolResult" &&
                message.toolCallId === "next-fixture",
            );
            assert.ok(result?.role === "toolResult");
            assert.equal(result.isError, false);
            assert.deepEqual(result.content, [
              { type: "text", text: "formatted\n" },
            ]);
          }
        },
        true,
      );
    } finally {
      await gate.close();
    }
  });
}

for (const abort of [false, true]) {
  test(`real custom-message turn ${abort ? "can abort its formatter wait" : "joins formatter before model entry"}`, {
    timeout: 15_000,
  }, async () => {
    const gate = await formatterGate();
    try {
      await withSession(gate.command, async (h) => {
        h.enqueue(write("initial\n"));
        await h.session.prompt("write fixture");
        const socket = await gate.connected;
        const entries = h.modelEntries();
        const admissions = h.toolAdmissions();
        if (abort) h.enqueue(write("must not be written\n"));
        const started = h.observeNextStart();
        const next = h.session.sendCustomMessage(
          { customType: "fixture", content: "continue", display: false },
          { triggerTurn: true },
        );
        let cancellation: Promise<void> | undefined;
        try {
          await started;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (abort) {
            let aborted = false;
            cancellation = h.session.abort().then(() => {
              aborted = true;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(
              aborted,
              true,
              "session.abort must finish before formatter release",
            );
            assert.equal(
              h.toolAdmissions(),
              admissions,
              "canceled turn must not admit its write",
            );
            assert.equal(
              await readFile(path.join(h.cwd, "target.txt"), "utf8"),
              "initial\n",
            );
          } else {
            assert.equal(
              h.modelEntries(),
              entries,
              "custom-message turn must wait before model entry",
            );
          }
        } finally {
          socket.end("release");
          await next;
          await cancellation;
        }
      });
    } finally {
      await gate.close();
    }
  });
}

test("real failing formatter warns and releases the next prompt", {
  timeout: 15_000,
}, async () => {
  await withSession(
    nodeCommand("process.stderr.write('fixture failure'); process.exit(23)"),
    async (h) => {
      h.enqueue(write("initial\n"));
      await h.session.prompt("write fixture");
      await h.session.prompt("continue after formatter failure");
      assert.ok(
        h.notices.some(
          (notice) => /exit 23/.test(notice) && /fixture failure/.test(notice),
        ),
      );
      assert.equal(
        await readFile(path.join(h.cwd, "target.txt"), "utf8"),
        "initial\n",
      );
    },
  );
});
