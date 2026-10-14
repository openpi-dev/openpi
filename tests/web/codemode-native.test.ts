import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectMessage } from "../../web/protocol/types.ts";
import { codemodeChildren } from "../../web/ui/src/features/transcript/codemode-tools.ts";

test("real Pi Code Mode sandbox emits child evidence and persists the bounded native ledger", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-code-web-"));
  const cancelledChildFinished = Promise.withResolvers<void>();
  let cancellationStarted = false;
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  try {
    const agentDir = path.join(cwd, "agent");
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "known.txt"), "native file output\n");
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createCodemodeExtension({ models: false })],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const sessionManager = SessionManager.create(
      cwd,
      path.join(cwd, "sessions"),
    );
    session = (
      await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager,
      })
    ).session;
    await session.bindExtensions({ mode: "print" });
    session.setActiveToolsByName(["read", "bash", "codemode"]);
    assert.ok(
      session.agent.state.tools.some((tool) => tool.name === "codemode"),
    );
    let requested = false;
    let cancelRun = false;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "synthetic",
        model: "synthetic",
        content: requested
          ? [{ type: "text", text: "done" }]
          : cancelRun
            ? [
                {
                  type: "toolCall",
                  id: "code-cancel",
                  name: "codemode",
                  arguments: { code: "await tools.bash({command:'sleep 2'});" },
                },
              ]
            : [
                {
                  type: "toolCall",
                  id: "code-ok",
                  name: "codemode",
                  arguments: {
                    code: "text(await Promise.allSettled([tools.read({path:'known.txt'}), tools.read({path:'missing.txt'})]));",
                  },
                },
                {
                  type: "toolCall",
                  id: "code-fail",
                  name: "codemode",
                  arguments: {
                    code: "await tools.read({path:'known.txt'}); throw new Error('script failure');",
                  },
                },
                {
                  type: "toolCall",
                  id: "code-empty",
                  name: "codemode",
                  arguments: { code: "throw new Error('before any tool');" },
                },
              ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: requested ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      requested = true;
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end();
      return stream;
    };
    const nested: { type: string; parent: string; id: string }[] = [];
    session.subscribe((event) => {
      if (
        "parentToolCallId" in event &&
        typeof event.parentToolCallId === "string" &&
        "toolCallId" in event
      )
        nested.push({
          type: event.type,
          parent: event.parentToolCallId,
          id: event.toolCallId,
        });
      if (
        event.type === "tool_execution_start" &&
        "parentToolCallId" in event &&
        event.parentToolCallId === "code-cancel"
      ) {
        cancellationStarted = true;
        setTimeout(() => session?.agent.abort(), 20);
      }
      if (
        event.type === "tool_execution_end" &&
        "parentToolCallId" in event &&
        event.parentToolCallId === "code-cancel"
      )
        cancelledChildFinished.resolve();
    });
    await session.agent.prompt("Execute the local fixture tools.");
    assert.ok(
      session.agent.state.messages.some(
        (message) => message.role === "toolResult",
      ),
    );
    const file = sessionManager.getSessionFile();
    assert.ok(file);
    const reloaded = SessionManager.open(file).getBranch();
    const results = reloaded.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [projectMessage(entry.message)]
        : [],
    );
    assert.equal(results.length, 3);
    assert.deepEqual(
      results[0]?.nestedCalls?.calls.map((item) => [
        item.call.name,
        item.status,
      ]),
      [
        ["read", "ok"],
        ["read", "error"],
      ],
    );
    assert.equal(
      results[0]?.isError,
      false,
      "caught child failure does not invent wrapper failure",
    );
    assert.equal(results[1]?.isError, true);
    assert.equal(
      results[1]?.nestedCalls?.calls[0]?.status,
      "ok",
      "wrapper failure does not undo successful child",
    );
    assert.equal(
      results[2]?.nestedCalls,
      undefined,
      "zero child wrapper remains evidence",
    );
    assert.deepEqual(
      nested
        .filter((item) => item.type === "tool_execution_start")
        .map((item) => item.parent)
        .sort(),
      ["code-fail", "code-ok", "code-ok"],
    );
    assert.ok(
      nested.some(
        (item) => item.type === "tool_execution_end" && item.id === "code-ok/1",
      ),
    );
    requested = false;
    cancelRun = true;
    await session.agent.prompt("Run the cancellation fixture.");
    const cancellationEntry = SessionManager.open(file)
      .getBranch()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "code-cancel",
      );
    assert.ok(cancellationEntry?.type === "message");
    const cancelled = projectMessage(cancellationEntry.message);
    assert.equal(cancelled.isError, true);
    const cancellationCall = projectMessage({
      content: [
        {
          type: "toolCall",
          id: "code-cancel",
          name: "codemode",
          arguments: {},
        },
      ],
    }).parts?.[0];
    assert.ok(cancellationCall?.type === "toolCall");
    const cancellationView = codemodeChildren(cancellationCall, cancelled, []);
    if (cancelled.nestedCalls?.calls[0]?.status === "unfinished") {
      assert.equal(
        cancellationView?.children[0]?.state,
        "unknown",
        "the persisted cancellation ledger can still carry a /? placeholder; never guess the child's identity",
      );
      assert.equal(cancellationView?.incomplete, true);
    } else {
      assert.equal(cancellationView?.children[0]?.state, "cancelled");
    }
  } finally {
    // Code Mode can settle before the cancelled native shell releases its cwd.
    // Keep the subscriber alive until that child's terminal event is observed.
    await session?.abort();
    try {
      if (cancellationStarted) {
        const timeout = setTimeout(() => {
          cancelledChildFinished.reject(
            new Error("Cancelled child did not settle"),
          );
        }, 10_000);
        try {
          await cancelledChildFinished.promise;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
