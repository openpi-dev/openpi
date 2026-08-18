import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function harness(
  reasoning = false,
  options: {
    cwd?: string;
    confirm?: (title: string, message: string) => Promise<boolean>;
    executionPolicy?: "experimental" | "product";
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const emissions: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        emissions.push({ channel, data });
      },
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: options.cwd ?? "/workspace",
    model: { reasoning },
    thinkingLevel: "off",
    ui: {
      confirm: options.confirm ?? (async () => false),
    },
  } as unknown as ExtensionContext;
  const { default: executionConvergence } = await import("./index.ts");
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  const productPolicy = options.executionPolicy === "product";
  const installExperimentalProfile =
    !productPolicy && previousAgentRoot === undefined;
  if (productPolicy) {
    delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  } else if (installExperimentalProfile) {
    process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-unit-test-agent";
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
      "full-execution-policy";
  }
  try {
    executionConvergence(pi);
  } finally {
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }

  return {
    emissions,
    async emit(event: string, value: unknown) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler(value, ctx);
      }
      return result;
    },
  };
}

test("ordinary product sessions use Pi-native execution and keep workspace protection", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-product-pi-native-"));
  delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  try {
    await writeFile(path.join(cwd, "go.mod"), "module bookstore\n");
    const h = await harness(false, { cwd, executionPolicy: "product" });
    const messages: unknown[] = [
      {
        role: "user",
        content: [{ type: "text", text: "implement" }],
        timestamp: 1,
      },
    ];
    for (let index = 1; index <= 9; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `product-history-${index}`,
              name: "read",
              arguments: { path: `file-${index}` },
            },
          ],
          timestamp: index * 2,
        },
        {
          role: "toolResult",
          toolCallId: `product-history-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `result-${index}` }],
          isError: false,
          timestamp: index * 2 + 1,
        },
      );
    }

    assert.equal(
      await h.emit("context", { type: "context", messages }),
      undefined,
    );
    const validationInput = { command: "go test ./..." };
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "product-validation",
      toolName: "bash",
      input: validationInput,
    });
    assert.equal((validationInput as { timeout?: number }).timeout, undefined);
    assert.deepEqual(h.emissions, []);

    const deletion = (await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "product-delete-go-mod",
      toolName: "bash",
      input: { command: "rm -f go.mod" },
    })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(deletion?.block, true);
    assert.match(deletion?.reason ?? "", /go\.mod/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("active evidence projection is applied through the Pi context seam", async () => {
  const h = await harness();
  const messages: unknown[] = [
    {
      role: "user",
      content: [{ type: "text", text: "implement" }],
      timestamp: 1,
    },
  ];
  for (let index = 1; index <= 9; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "r".repeat(600),
            thinkingSignature: "reasoning_content",
          },
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "read",
            arguments: { path: `file-${index}` },
          },
        ],
        timestamp: index * 2,
      },
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `result-${index}` }],
        isError: false,
        timestamp: index * 2 + 1,
      },
    );
  }

  const result = (await h.emit("context", {
    type: "context",
    messages,
  })) as { messages?: Array<{ role: string }> } | undefined;

  assert.ok(result?.messages);
  assert.equal(
    result.messages.filter((message) => message.role === "assistant").length,
    3,
  );
  assert.equal(
    result.messages.filter(
      (message) => message.role === "user" || message.role === "custom",
    ).length,
    1,
  );
  const projectionEmission = h.emissions.at(-1) as
    | { channel: string; data: Record<string, unknown> }
    | undefined;
  assert.equal(projectionEmission?.channel, "openpi:execution-convergence");
  assert.deepEqual(
    {
      ...projectionEmission?.data,
      activeEvidenceCharsRemoved: undefined,
    },
    {
      activeEvidenceCharsRemoved: undefined,
      type: "active_evidence_projection",
      projectedActiveEvidenceApplications: 1,
      newActiveEvidenceEpochs: 1,
      closedToolTransactions: 6,
    },
  );
  assert.ok(
    Number(projectionEmission?.data.activeEvidenceCharsRemoved) > 4_000,
  );
});

test("the guarded benchmark legacy profile leaves active evidence untouched", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-benchmark-agent";
  process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE = "legacy";
  try {
    const h = await harness();
    const messages: unknown[] = [
      {
        role: "user",
        content: [{ type: "text", text: "implement" }],
        timestamp: 1,
      },
    ];
    for (let index = 1; index <= 9; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "read",
              arguments: { path: `file-${index}` },
            },
          ],
          timestamp: index * 2,
        },
        {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `result-${index}` }],
          isError: false,
          timestamp: index * 2 + 1,
        },
      );
    }

    const result = await h.emit("context", { type: "context", messages });

    assert.equal(result, undefined);
    assert.deepEqual(h.emissions, []);
  } finally {
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("the guarded no-active-evidence profile preserves workspace protection", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-no-active-evidence-"));
  process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-benchmark-agent";
  process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
    "no-active-evidence";
  try {
    await writeFile(path.join(cwd, "go.mod"), "module bookstore\n");
    const h = await harness(false, { cwd });
    const messages: unknown[] = [
      {
        role: "user",
        content: [{ type: "text", text: "implement" }],
        timestamp: 1,
      },
    ];
    for (let index = 1; index <= 9; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "read",
              arguments: { path: `file-${index}` },
            },
          ],
          timestamp: index * 2,
        },
        {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `result-${index}` }],
          isError: false,
          timestamp: index * 2 + 1,
        },
      );
    }

    const projected = await h.emit("context", { type: "context", messages });
    const deletion = (await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "delete-go-mod",
      toolName: "bash",
      input: { command: "rm -f go.mod" },
    })) as { block?: boolean; reason?: string } | undefined;

    assert.equal(projected, undefined);
    assert.equal(deletion?.block, true);
    assert.match(deletion?.reason ?? "", /go\.mod/u);
    assert.equal(
      h.emissions.some(
        (emission) =>
          (emission.data as { type?: string }).type ===
          "active_evidence_projection",
      ),
      false,
    );
    assert.equal(
      h.emissions.some(
        (emission) =>
          (emission.data as { type?: string }).type ===
          "workspace_cleanup_guard",
      ),
      true,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("the guarded Pi-native profile preserves only workspace protection", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-pi-native-policy-"));
  process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-benchmark-agent";
  process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
    "pi-native-execution";
  try {
    await writeFile(path.join(cwd, "go.mod"), "module bookstore\n");
    const h = await harness(false, { cwd });
    const messages: unknown[] = [
      {
        role: "user",
        content: [{ type: "text", text: "implement" }],
        timestamp: 1,
      },
    ];
    for (let index = 1; index <= 9; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `history-${index}`,
              name: "read",
              arguments: { path: `file-${index}` },
            },
          ],
          timestamp: index * 2,
        },
        {
          role: "toolResult",
          toolCallId: `history-${index}`,
          toolName: "read",
          content: [{ type: "text", text: `result-${index}` }],
          isError: false,
          timestamp: index * 2 + 1,
        },
      );
    }
    messages.push({
      role: "toolResult",
      toolCallId: "long-bash",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(9_000) }],
      isError: false,
      timestamp: 100,
    });

    assert.equal(
      await h.emit("context", { type: "context", messages }),
      undefined,
    );

    const validationInput = { command: "go test ./..." };
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "validation",
      toolName: "bash",
      input: validationInput,
    });
    assert.equal((validationInput as { timeout?: number }).timeout, undefined);
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: "validation",
      toolName: "bash",
      content: [{ type: "text", text: "FAIL validation" }],
      isError: true,
    });

    for (let index = 1; index <= 3; index += 1) {
      const toolCallId = `same-failure-${index}`;
      assert.equal(
        await h.emit("tool_call", {
          type: "tool_call",
          toolCallId,
          toolName: "read",
          input: { path: "missing.txt" },
        }),
        undefined,
      );
      assert.equal(
        await h.emit("tool_result", {
          type: "tool_result",
          toolCallId,
          toolName: "read",
          content: [{ type: "text", text: "File not found" }],
          isError: true,
        }),
        undefined,
      );
    }

    assert.deepEqual(h.emissions, []);
    const deletion = (await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "delete-go-mod",
      toolName: "bash",
      input: { command: "rm -f go.mod" },
    })) as { block?: boolean; reason?: string } | undefined;

    assert.equal(deletion?.block, true);
    assert.match(deletion?.reason ?? "", /go\.mod/u);
    assert.deepEqual(h.emissions.at(-1), {
      channel: "openpi:execution-convergence",
      data: {
        type: "workspace_cleanup_guard",
        blockedPreExistingDeletes: 1,
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("pre-existing cleanup is blocked through the Pi tool seam", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-cleanup-seam-"));
  try {
    await writeFile(path.join(cwd, "go.mod"), "module bookstore\n");
    const h = await harness(false, { cwd });

    const result = (await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "delete-go-mod",
      toolName: "bash",
      input: { command: "rm -f go.mod" },
    })) as { block?: boolean; reason?: string } | undefined;

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /go\.mod/u);
    assert.deepEqual(h.emissions.at(-1), {
      channel: "openpi:execution-convergence",
      data: {
        type: "workspace_cleanup_guard",
        blockedPreExistingDeletes: 1,
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native write provenance reaches the later Bash cleanup seam", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-write-provenance-"));
  try {
    const h = await harness(false, { cwd });
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "write-scratch",
      toolName: "write",
      input: { path: "zz_test.go", content: "package bookstore\n" },
    });
    await writeFile(path.join(cwd, "zz_test.go"), "package bookstore\n");
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: "write-scratch",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote 18 bytes" }],
      isError: false,
    });

    const cleanup = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "remove-scratch",
      toolName: "bash",
      input: { command: "go test ./... && rm -f zz_test.go" },
    });

    assert.equal(cleanup, undefined);
    assert.equal(
      h.emissions.some(
        (entry) =>
          (entry.data as { type?: string }).type === "workspace_cleanup_guard",
      ),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a Bash-created file remains session-owned when a later subcommand fails", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-bash-provenance-"));
  try {
    const h = await harness(false, { cwd });
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "create-then-fail",
      toolName: "bash",
      input: {
        command: "cat > test_main.go <<'EOF'\npackage main\nEOF\ngo run .",
      },
    });
    await writeFile(path.join(cwd, "test_main.go"), "package main\n");
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: "create-then-fail",
      toolName: "bash",
      content: [{ type: "text", text: "go run failed" }],
      isError: true,
    });

    const cleanup = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "remove-scratch",
      toolName: "bash",
      input: { command: "rm -f test_main.go" },
    });

    assert.equal(cleanup, undefined);
    assert.equal(
      h.emissions.some(
        (entry) =>
          (entry.data as { type?: string }).type === "workspace_cleanup_guard",
      ),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a Bash-created directory reaches the later recursive cleanup seam", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-mkdir-provenance-"));
  try {
    const h = await harness(false, { cwd });
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "mkdir-then-fail",
      toolName: "bash",
      input: { command: "mkdir -p testmain && go run ./testmain" },
    });
    await mkdir(path.join(cwd, "testmain"));
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: "mkdir-then-fail",
      toolName: "bash",
      content: [{ type: "text", text: "go run failed" }],
      isError: true,
    });

    const cleanup = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "remove-directory",
      toolName: "bash",
      input: { command: "rm -rf testmain" },
    });

    assert.equal(cleanup, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the guarded benchmark legacy profile leaves cleanup behavior unchanged", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-legacy-cleanup-"));
  process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-benchmark-agent";
  process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE = "legacy";
  try {
    await writeFile(path.join(cwd, "go.mod"), "module bookstore\n");
    const h = await harness(false, { cwd });

    const result = await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "delete-go-mod",
      toolName: "bash",
      input: { command: "rm -f go.mod" },
    });

    assert.equal(result, undefined);
    assert.deepEqual(h.emissions, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("provider reasoning history remains available despite model metadata", async () => {
  const h = await harness();
  const toolCall = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "book_store.go" },
  };
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "long private reasoning",
          thinkingSignature: "reasoning_content",
        },
        toolCall,
      ],
    },
  ];

  const result = await h.emit("context", {
    type: "context",
    messages,
  });

  assert.equal(result, undefined);
  assert.deepEqual(h.emissions, []);
});

test("redacted thinking remains available for provider continuity", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "reasoning_content",
          redacted: true,
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "book_store.go" },
        },
      ],
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("thinking-only assistant messages fail open", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "provider-only response",
          thinkingSignature: "reasoning_content",
        },
      ],
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("exit-zero failure markers feed the exact-failure gate without a synthetic checkpoint", async () => {
  const h = await harness();
  for (let index = 1; index <= 2; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `call-test-${index}`,
      toolName: "bash",
      input: { command: "go test ./... 2>&1 | head" },
    });
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `call-test-${index}`,
      toolName: "bash",
      input: { command: "go test ./... 2>&1 | head" },
      content: [
        {
          type: "text",
          text: "--- FAIL: TestCost (0.00s)\nFAIL\tbookstore\t0.42s",
        },
      ],
      details: { exitCode: 0 },
      isError: false,
    });
  }

  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "implement the task" }],
  });
  const blocked = (await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-test-3",
    toolName: "bash",
    input: { command: "go test ./... 2>&1 | head" },
  })) as { block?: boolean } | undefined;

  assert.equal(result, undefined);
  assert.equal(blocked?.block, true);
});

test("repeated rewrites remain observe-only without semantic evidence", async () => {
  const h = await harness();
  for (let index = 1; index <= 3; index++) {
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `call-write-${index}`,
      toolName: "write",
      input: { path: "book_store.go", content: `revision ${index}` },
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    });
  }

  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "implement the task" }],
  });

  assert.equal(result, undefined);
  assert.deepEqual(h.emissions, []);
});

test("post-mutation evidence calls do not invent a model-facing checkpoint", async () => {
  const h = await harness();
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "write-core",
    toolName: "write",
    input: { path: "connect.js", content: "export class Board {}" },
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "write-core",
    toolName: "write",
    content: [{ type: "text", text: "Successfully wrote connect.js" }],
    isError: false,
  });

  let result: unknown;
  for (let index = 1; index <= 3; index += 1) {
    const id = `evidence-${index}`;
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: id,
      toolName: index === 2 ? "read" : "bash",
      input:
        index === 2
          ? { path: "connect.js" }
          : { command: `node smoke-${index}.js` },
    });
    result = await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: id,
      toolName: index === 2 ? "read" : "bash",
      content: [{ type: "text", text: "focused evidence" }],
      isError: false,
    });
  }

  assert.equal(result, undefined);
  assert.equal(
    h.emissions.some(
      (entry) =>
        (entry.data as { type?: string }).type ===
        "mutation_evidence_checkpoint",
    ),
    false,
  );
});

test("successful validation remains observe-only", async () => {
  const h = await harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "call-test",
    toolName: "bash",
    input: { command: "go test ./..." },
    content: [{ type: "text", text: "ok  \tbookstore\t0.42s" }],
    isError: false,
  });

  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "implement the task" }],
  });

  assert.equal(result, undefined);
  assert.deepEqual(h.emissions, []);
});

test("test-like Bash calls receive a bounded default timeout", async () => {
  const h = await harness();
  const input = {
    command:
      "cat > brute_test.go <<'EOF'\npackage bookstore\nEOF\ngo test -run TestBrute ./...",
  };

  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-bounded-validation",
    toolName: "bash",
    input,
  });

  assert.equal((input as { timeout?: number }).timeout, 180);
  assert.deepEqual(h.emissions.at(-1), {
    channel: "openpi:execution-convergence",
    data: {
      type: "validation_timeout_default",
      boundedValidationCalls: 1,
      timeoutSeconds: 180,
    },
  });
});

test("an injected validation timeout records only when it actually fires", async () => {
  const h = await harness();
  const input = { command: "go test -run TestBrute ./..." };
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-validation-timeout",
    toolName: "bash",
    input,
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "call-validation-timeout",
    toolName: "bash",
    input,
    content: [{ type: "text", text: "Command timed out after 180 seconds" }],
    isError: true,
  });

  assert.deepEqual(h.emissions.at(-1), {
    channel: "openpi:execution-convergence",
    data: {
      type: "validation_timeout_triggered",
      timedOutValidationCalls: 1,
      timeoutSeconds: 180,
    },
  });
});

test("a validation command that already timed out gets a shorter retry bound", async () => {
  const h = await harness();
  const firstInput = { command: "go test -run TestGreedy -v" };
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "first-validation",
    toolName: "bash",
    input: firstInput,
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "first-validation",
    toolName: "bash",
    input: firstInput,
    content: [{ type: "text", text: "Command timed out after 180 seconds" }],
    isError: true,
  });

  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "intervening-fix",
    toolName: "write",
    input: { path: "greedy_test.go", content: "smaller test" },
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "intervening-fix",
    toolName: "write",
    input: { path: "greedy_test.go", content: "smaller test" },
    content: [{ type: "text", text: "Successfully wrote file" }],
    isError: false,
  });

  const retryInput = { command: "go test -run TestGreedy -v" };
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "retry-validation",
    toolName: "bash",
    input: retryInput,
  });

  assert.equal((retryInput as { timeout?: number }).timeout, 60);
  assert.deepEqual(h.emissions.at(-1), {
    channel: "openpi:execution-convergence",
    data: {
      type: "validation_retry_timeout_default",
      boundedValidationCalls: 1,
      shortenedValidationRetries: 1,
      timeoutSeconds: 60,
    },
  });
});

test("explicit Bash timeouts and non-validation commands are unchanged", async () => {
  const h = await harness();
  const explicit = { command: "go test ./...", timeout: 420 };
  const ordinary = { command: "go build ./..." };

  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-explicit-timeout",
    toolName: "bash",
    input: explicit,
  });
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-ordinary-bash",
    toolName: "bash",
    input: ordinary,
  });

  assert.equal(explicit.timeout, 420);
  assert.equal((ordinary as { timeout?: number }).timeout, undefined);
  assert.deepEqual(h.emissions, []);
});

test("a successful build remains observe-only because compilation is not completion", async () => {
  const h = await harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "call-build",
    toolName: "bash",
    input: { command: "go build ./..." },
    content: [{ type: "text", text: "" }],
    isError: false,
  });

  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "implement the task" }],
  });

  assert.equal(result, undefined);
  assert.deepEqual(h.emissions, []);
});

test("a third consecutive identical failed call is blocked before execution", async () => {
  const h = await harness();
  for (let index = 1; index <= 2; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `call-${index}`,
      toolName: "read",
      input: { path: "missing.txt", offset: 1, limit: 20 },
    });
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `call-${index}`,
      toolName: "read",
      input: { path: "missing.txt", offset: 1, limit: 20 },
      content: [{ type: "text", text: "File not found" }],
      isError: true,
    });
  }

  const blocked = (await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "call-3",
    toolName: "read",
    input: { limit: 20, path: "missing.txt", offset: 1 },
  })) as { block?: boolean; reason?: string } | undefined;

  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /exact read call.*failed repeatedly/i);
  assert.deepEqual(h.emissions.at(-1), {
    channel: "openpi:execution-convergence",
    data: { type: "loop_gate", blockedRepeatedFailures: 1 },
  });
});

test("success or a different failed call resets the exact-failure streak", async () => {
  const h = await harness();
  for (let index = 1; index <= 2; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `missing-${index}`,
      toolName: "read",
      input: { path: "missing.txt" },
    });
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `missing-${index}`,
      toolName: "read",
      input: { path: "missing.txt" },
      content: [{ type: "text", text: "File not found" }],
      isError: true,
    });
  }
  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "different",
    toolName: "read",
    input: { path: "present.txt" },
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolCallId: "different",
    toolName: "read",
    input: { path: "present.txt" },
    content: [{ type: "text", text: "present" }],
    isError: false,
  });

  assert.equal(
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "missing-3",
      toolName: "read",
      input: { path: "missing.txt" },
    }),
    undefined,
  );
});

test("a dense burst of different tool failures requests an evidence reset", async () => {
  const h = await harness();
  const attempts = [
    { id: "bad-edit", toolName: "edit", failed: true },
    { id: "pwd", toolName: "bash", failed: false },
    { id: "bad-bash", toolName: "bash", failed: true },
    { id: "write-helper", toolName: "write", failed: false },
    { id: "bad-write", toolName: "write", failed: true },
  ];
  let finalResult: unknown;

  for (const attempt of attempts) {
    const input =
      attempt.toolName === "bash"
        ? { command: attempt.id }
        : { path: `${attempt.id}.txt`, content: "candidate" };
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: attempt.id,
      toolName: attempt.toolName,
      input,
    });
    finalResult = await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: attempt.id,
      toolName: attempt.toolName,
      input,
      content: [
        {
          type: "text",
          text: attempt.failed
            ? "tool attempt failed"
            : "tool attempt succeeded",
        },
      ],
      isError: attempt.failed,
    });
  }

  assert.deepEqual(finalResult, {
    content: [
      { type: "text", text: "tool attempt failed" },
      {
        type: "text",
        text: "[OpenPI recovery checkpoint: 3 of the last 8 tool attempts failed. Re-establish the authoritative current state with a read or listing before another mutation. Prefer workspace-relative paths over retyping temporary absolute paths. Do not delete files unless you verified this session created them or the task requires removal. Drop speculative side work, then make one minimal evidence-backed change.]",
      },
    ],
  });
  assert.deepEqual(h.emissions.at(-1), {
    channel: "openpi:execution-convergence",
    data: { type: "failure_recovery_hint", injectedRecoveryHints: 1 },
  });
});

test("a long trajectory gets one contract-focused settlement hint", async () => {
  const h = await harness();
  let result: unknown;
  let twentiethResult: unknown;
  for (let index = 1; index <= 21; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `call-long-${index}`,
      toolName: "read",
      input: { path: `file-${index}.txt` },
    });
    result = await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `call-long-${index}`,
      toolName: "read",
      input: { path: `file-${index}.txt` },
      content: [{ type: "text", text: `content ${index}` }],
      isError: false,
    });
    if (index < 20) assert.equal(result, undefined);
    if (index === 20) twentiethResult = result;
  }

  assert.deepEqual(twentiethResult, {
    content: [
      { type: "text", text: "content 20" },
      {
        type: "text",
        text: "[OpenPI trajectory checkpoint: 20 tool attempts used. Re-read the user contract and inspect the current artifact. Stop speculative exploration. Run one focused validation that covers the remaining risk; if it passes and the artifact satisfies the contract, finish. Otherwise make one evidence-backed change.]",
      },
    ],
  });
  assert.deepEqual(result, undefined);
  assert.deepEqual(h.emissions, [
    {
      channel: "openpi:execution-convergence",
      data: {
        type: "trajectory_budget_hint",
        injectedTrajectoryHints: 1,
        toolAttempts: 20,
      },
    },
  ]);
});

test("the guarded no-model-hints profile records triggers without changing tool results", async () => {
  const previousAgentRoot = process.env.OPENPI_BENCHMARK_AGENT_ROOT;
  const previousProfile =
    process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
  process.env.OPENPI_BENCHMARK_AGENT_ROOT = "/tmp/openpi-benchmark-agent";
  process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE = "no-model-hints";
  try {
    const recovery = await harness();
    for (let index = 1; index <= 3; index += 1) {
      await recovery.emit("tool_call", {
        type: "tool_call",
        toolCallId: `failed-${index}`,
        toolName: "read",
        input: { path: `missing-${index}.txt` },
      });
      assert.equal(
        await recovery.emit("tool_result", {
          type: "tool_result",
          toolCallId: `failed-${index}`,
          toolName: "read",
          input: { path: `missing-${index}.txt` },
          content: [{ type: "text", text: "File not found" }],
          isError: true,
        }),
        undefined,
      );
    }
    assert.deepEqual(recovery.emissions.at(-1), {
      channel: "openpi:execution-convergence",
      data: {
        type: "failure_recovery_hint_suppressed",
        suppressedRecoveryHints: 1,
      },
    });

    const trajectory = await harness();
    for (let index = 1; index <= 20; index += 1) {
      await trajectory.emit("tool_call", {
        type: "tool_call",
        toolCallId: `long-${index}`,
        toolName: "read",
        input: { path: `file-${index}.txt` },
      });
      assert.equal(
        await trajectory.emit("tool_result", {
          type: "tool_result",
          toolCallId: `long-${index}`,
          toolName: "read",
          input: { path: `file-${index}.txt` },
          content: [{ type: "text", text: `content ${index}` }],
          isError: false,
        }),
        undefined,
      );
    }
    assert.deepEqual(trajectory.emissions, [
      {
        channel: "openpi:execution-convergence",
        data: {
          type: "trajectory_budget_hint_suppressed",
          suppressedTrajectoryHints: 1,
          toolAttempts: 20,
        },
      },
    ]);
  } finally {
    if (previousAgentRoot === undefined) {
      delete process.env.OPENPI_BENCHMARK_AGENT_ROOT;
    } else {
      process.env.OPENPI_BENCHMARK_AGENT_ROOT = previousAgentRoot;
    }
    if (previousProfile === undefined) {
      delete process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE;
    } else {
      process.env.OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE =
        previousProfile;
    }
  }
});

test("a different call earlier in the same batch resets before its result settles", async () => {
  const h = await harness();
  for (let index = 1; index <= 2; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `missing-${index}`,
      toolName: "read",
      input: { path: "missing.txt" },
    });
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `missing-${index}`,
      toolName: "read",
      input: { path: "missing.txt" },
      content: [{ type: "text", text: "File not found" }],
      isError: true,
    });
  }

  await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "different-pending",
    toolName: "read",
    input: { path: "present.txt" },
  });
  const repeated = await h.emit("tool_call", {
    type: "tool_call",
    toolCallId: "missing-3",
    toolName: "read",
    input: { path: "missing.txt" },
  });

  assert.equal(repeated, undefined);
});

test("blocked exact-failure state clears when the agent settles", async () => {
  const h = await harness();
  for (let index = 1; index <= 2; index++) {
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: `call-${index}`,
      toolName: "bash",
      input: { command: "false" },
    });
    await h.emit("tool_result", {
      type: "tool_result",
      toolCallId: `call-${index}`,
      toolName: "bash",
      input: { command: "false" },
      content: [{ type: "text", text: "Command exited with code 1" }],
      isError: true,
    });
  }
  await h.emit("agent_settled", { type: "agent_settled" });

  assert.equal(
    await h.emit("tool_call", {
      type: "tool_call",
      toolCallId: "call-3",
      toolName: "bash",
      input: { command: "false" },
    }),
    undefined,
  );
});

test("successful write arguments remain intact without a current-file snapshot", async () => {
  const h = await harness();
  const firstWrite = {
    type: "toolCall",
    id: "call-write-1",
    name: "write",
    arguments: { path: "book_store.go", content: "old source".repeat(500) },
  };
  const latestWrite = {
    type: "toolCall",
    id: "call-write-2",
    name: "write",
    arguments: { path: "./book_store.go", content: "current source" },
  };
  const messages = [
    { role: "assistant", content: [firstWrite] },
    {
      role: "toolResult",
      toolCallId: "call-write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
    { role: "assistant", content: [latestWrite] },
    {
      role: "toolResult",
      toolCallId: "call-write-2",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", {
    type: "context",
    messages,
  });

  assert.equal(result, undefined);
  assert.equal(firstWrite.arguments.content, "old source".repeat(500));
  assert.equal(latestWrite.arguments.content, "current source");
  assert.deepEqual(h.emissions, []);
});

test("successful edit arguments remain intact without a current-file snapshot", async () => {
  const h = await harness();
  const firstEdit = {
    type: "toolCall",
    id: "call-edit-1",
    name: "edit",
    arguments: {
      path: "book_store.go",
      edits: [{ oldText: "old".repeat(500), newText: "new".repeat(500) }],
    },
  };
  const latestEdit = {
    type: "toolCall",
    id: "call-edit-2",
    name: "edit",
    arguments: {
      path: "book_store.go",
      edits: [{ oldText: "current old", newText: "current new" }],
    },
  };
  const messages = [
    { role: "assistant", content: [firstEdit] },
    {
      role: "toolResult",
      toolCallId: "call-edit-1",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block" }],
      isError: false,
    },
    { role: "assistant", content: [latestEdit] },
    {
      role: "toolResult",
      toolCallId: "call-edit-2",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", {
    type: "context",
    messages,
  });

  assert.equal(result, undefined);
  assert.deepEqual(firstEdit.arguments.edits, [
    { oldText: "old".repeat(500), newText: "new".repeat(500) },
  ]);
  assert.deepEqual(latestEdit.arguments.edits, [
    { oldText: "current old", newText: "current new" },
  ]);
  assert.deepEqual(h.emissions, []);
});

test("long Bash commands that may mutate files remain intact", async () => {
  const h = await harness();
  const oldCommand = `cat > zz_test.go <<'EOF'\n${"old test source\n".repeat(80)}EOF`;
  const failedCommand = `cat > zz_test.go <<'EOF'\n${"failed test source\n".repeat(80)}EOF`;
  const latestCommand = `cat > zz_test.go <<'EOF'\n${"latest test source\n".repeat(80)}EOF`;
  const oldCall = {
    type: "toolCall",
    id: "call-bash-1",
    name: "bash",
    arguments: { command: oldCommand },
  };
  const failedCall = {
    type: "toolCall",
    id: "call-bash-2",
    name: "bash",
    arguments: { command: failedCommand },
  };
  const latestCall = {
    type: "toolCall",
    id: "call-bash-3",
    name: "bash",
    arguments: { command: latestCommand },
  };
  const messages = [
    {
      role: "assistant",
      content: [oldCall],
    },
    {
      role: "toolResult",
      toolCallId: "call-bash-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [failedCall],
    },
    {
      role: "toolResult",
      toolCallId: "call-bash-2",
      toolName: "bash",
      content: [{ type: "text", text: "FAIL" }],
      isError: true,
    },
    {
      role: "assistant",
      content: [latestCall],
    },
    {
      role: "toolResult",
      toolCallId: "call-bash-3",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
  ];

  const result = (await h.emit("context", {
    type: "context",
    messages,
  })) as
    | {
        messages?: Array<{
          content?: Array<{ arguments?: { command?: string } }>;
        }>;
      }
    | undefined;

  assert.equal(result, undefined);
  assert.equal(oldCall.arguments.command, oldCommand);
  assert.equal(failedCall.arguments.command, failedCommand);
  assert.equal(latestCall.arguments.command, latestCommand);
  assert.deepEqual(h.emissions, []);
});

test("successful Bash output is bounded including the latest result while durable history stays intact", async () => {
  const h = await harness();
  const longOutput = `BEGIN\n${"middle output\n".repeat(900)}END`;
  const staleResult = {
    role: "toolResult",
    toolCallId: "call-bash-1",
    toolName: "bash",
    content: [{ type: "text", text: longOutput }],
    isError: false,
  };
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-bash-1",
          name: "bash",
          arguments: { command: "find . -type f -print" },
        },
      ],
    },
    staleResult,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-bash-2",
          name: "bash",
          arguments: { command: "git status --short" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-bash-2",
      toolName: "bash",
      content: [{ type: "text", text: longOutput }],
      isError: false,
    },
  ];

  const result = (await h.emit("context", {
    type: "context",
    messages,
  })) as
    | {
        messages?: Array<{
          content?: Array<{ type?: string; text?: string }>;
        }>;
      }
    | undefined;
  const projected = result?.messages?.[1]?.content?.[0]?.text ?? "";
  const projectedLatest = result?.messages?.[3]?.content?.[0]?.text ?? "";

  assert.match(projected, /^BEGIN/);
  assert.match(projected, /Bash output bounded/i);
  assert.match(projected, /END$/);
  assert.ok(projected.length < longOutput.length);
  assert.match(projectedLatest, /^BEGIN/);
  assert.match(projectedLatest, /Bash output bounded/i);
  assert.match(projectedLatest, /END$/);
  assert.ok(projectedLatest.length < longOutput.length);
  assert.equal(staleResult.content[0]?.text, longOutput);
  assert.deepEqual(h.emissions.at(-1)?.data, {
    type: "context_projection",
    projectedBashResultApplications: 2,
    newlyProjectedBashResults: 2,
  });
});

test("latest Bash output with a failure marker remains intact", async () => {
  const h = await harness();
  const failedOutput = `FAIL: verifier\n${"failure detail\n".repeat(900)}`;
  const messages = [
    {
      role: "toolResult",
      toolCallId: "call-bash-failed",
      toolName: "bash",
      content: [{ type: "text", text: failedOutput }],
      isError: false,
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
  assert.equal(messages[0]?.content[0]?.text, failedOutput);
  assert.deepEqual(h.emissions, []);
});

test("Bash result telemetry separates projection applications from unique results", async () => {
  const h = await harness();
  const messages = [
    {
      role: "toolResult",
      toolCallId: "call-bash-old",
      toolName: "bash",
      content: [{ type: "text", text: "old\n".repeat(2_500) }],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "call-bash-latest",
      toolName: "bash",
      content: [{ type: "text", text: "latest" }],
      isError: false,
    },
  ];

  await h.emit("context", { type: "context", messages });
  await h.emit("context", { type: "context", messages });
  await h.emit("agent_settled", { type: "agent_settled" });
  await h.emit("context", { type: "context", messages });

  assert.deepEqual(
    h.emissions.map(({ data }) => data),
    [
      {
        type: "context_projection",
        projectedBashResultApplications: 1,
        newlyProjectedBashResults: 1,
      },
      {
        type: "context_projection",
        projectedBashResultApplications: 1,
        newlyProjectedBashResults: 0,
      },
      {
        type: "context_projection",
        projectedBashResultApplications: 1,
        newlyProjectedBashResults: 1,
      },
    ],
  );
});

test("signed tool calls fail open instead of being folded", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "book_store.go", content: "old source" },
          thoughtSignature: "opaque-provider-signature",
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-2",
          name: "write",
          arguments: { path: "book_store.go", content: "current source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-2",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("a signed latest mutation keeps earlier calls unchanged", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "book_store.go", content: "old source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-2",
          name: "write",
          arguments: { path: "book_store.go", content: "current source" },
          thoughtSignature: "opaque-provider-signature",
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-2",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("mutations paired with redacted thinking fail open", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-encrypted-payload",
          redacted: true,
        },
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "book_store.go", content: "old source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-2",
          name: "write",
          arguments: { path: "book_store.go", content: "current source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-2",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("mutations paired with opaque thinking signatures fail open", async () => {
  const h = await harness();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "provider reasoning",
          thinkingSignature: "opaque-provider-signature",
        },
        {
          type: "toolCall",
          id: "call-write-1",
          name: "write",
          arguments: { path: "book_store.go", content: "old source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-1",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-write-2",
          name: "write",
          arguments: { path: "book_store.go", content: "current source" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-write-2",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote file" }],
      isError: false,
    },
  ];

  const result = await h.emit("context", { type: "context", messages });

  assert.equal(result, undefined);
});

test("unchanged context emits no projection telemetry", async () => {
  const h = await harness();
  await h.emit("context", {
    type: "context",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "long private reasoning",
            thinkingSignature: "reasoning_content",
          },
          {
            type: "toolCall",
            id: "call-write-1",
            name: "write",
            arguments: { path: "book_store.go", content: "old source" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-write-1",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote file" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-write-2",
            name: "write",
            arguments: { path: "book_store.go", content: "current source" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-write-2",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote file" }],
        isError: false,
      },
    ],
  });

  assert.deepEqual(h.emissions, []);
});
