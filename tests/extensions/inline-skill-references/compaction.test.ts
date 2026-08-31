import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  ModelRuntime,
  SessionManager,
  sessionEntryToContextMessages,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import inlineSkillReferences, {
  injectInlineSkillReferences,
  reanchorCompactedSkillReferences,
} from "../../../extensions/inline-skill-references/index.ts";

test("keeps run-scoped Skill snapshots through compaction, retry and queued input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-inline-compaction-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const reviewPath = path.join(agentDir, "skills/review/SKILL.md");
  await mkdir(cwd, { recursive: true });
  for (const name of ["review", "other"]) {
    await mkdir(path.join(agentDir, "skills", name), { recursive: true });
    await writeFile(
      path.join(agentDir, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\nINLINE_${name.toUpperCase()}_SENTINEL\n`,
    );
  }
  const snapshots: unknown[][] = [];
  const errors: ExtensionError[] = [];
  const events: string[] = [];
  const provider = fauxProvider({
    api: "inline-compaction-test",
    provider: `inline-compaction-${path.basename(root)}`,
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        contextWindow: 200000,
        maxTokens: 1000,
      },
    ],
  });
  const response =
    (message: ReturnType<typeof fauxAssistantMessage>) =>
    (context: { messages: unknown[] }) => {
      snapshots.push(structuredClone(context.messages));
      return message;
    };
  const overflow = () =>
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "maximum context length is 200000 tokens",
    });
  provider.setResponses([
    response(
      fauxAssistantMessage(fauxToolCall("large_output", {}, { id: "first" }), {
        stopReason: "toolUse",
      }),
    ),
    response(overflow()),
    response(
      fauxAssistantMessage(fauxToolCall("large_output", {}, { id: "second" }), {
        stopReason: "toolUse",
      }),
    ),
    response(fauxAssistantMessage("Recovered.")),
    response(fauxAssistantMessage("Unrelated next run.")),
  ]);
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: {
        enabled: true,
        keepRecentTokens: 1000,
        reserveTokens: 1000,
      },
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  let compactions = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      inlineSkillReferences,
      (pi) => {
        pi.registerTool({
          name: "large_output",
          label: "Large fixture",
          description: "Returns local fixture data",
          parameters: Type.Object({}),
          async execute() {
            await writeFile(
              reviewPath,
              "---\nname: review\ndescription: Changed\n---\nMUTATED_SKILL_BODY\n",
            );
            return {
              content: [{ type: "text", text: "x".repeat(12000) }],
              details: {},
            };
          },
        });
        pi.on("session_before_compact", (event) => {
          compactions += 1;
          return {
            compaction: {
              // Deterministic summary; the real Pi lifecycle still selects and persists the cut.
              summary: "Fixture summary: continue the pending task.",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      },
    ],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  let queued: Promise<void> | undefined;
  const deadline = setTimeout(() => void session.abort(), 15000);
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    session.subscribe((event) => {
      if (
        event.type === "compaction_end" &&
        !event.aborted &&
        compactions === 1
      ) {
        queued = session.steer("Use $other for the remaining work.");
      }
      if (event.type === "agent_settled" || event.type === "compaction_end")
        events.push(event.type);
    });
    await session.prompt("Use $review and execute the task.");
    await queued;
    await session.waitForIdle();
    await session.prompt("An unrelated task without a Skill reference.");
    assert.equal(compactions, 1);
    assert.equal(snapshots.length, 5);
    assert.deepEqual(events, [
      "compaction_end",
      "agent_settled",
      "agent_settled",
    ]);
    assert.deepEqual(errors, []);
    for (const [index, messages] of snapshots.entries()) {
      const text = JSON.stringify(messages);
      assert.equal(
        text.split("INLINE_REVIEW_SENTINEL").length - 1,
        index < 4 ? 1 : 0,
        `review at call ${index}`,
      );
      assert.equal(
        text.split("INLINE_OTHER_SENTINEL").length - 1,
        index >= 2 && index < 4 ? 1 : 0,
        `other at call ${index}`,
      );
      assert.doesNotMatch(text, /MUTATED_SKILL_BODY/);
      if (index >= 2 && index < 4)
        assert.ok(
          text.indexOf("INLINE_REVIEW_SENTINEL") <
            text.indexOf("INLINE_OTHER_SENTINEL"),
        );
    }
    assert.doesNotMatch(
      JSON.stringify(sessionManager.getBranch()),
      /INLINE_REVIEW_SENTINEL|INLINE_OTHER_SENTINEL/,
    );
    assert.match(
      JSON.stringify(sessionManager.getBranch()),
      /Use \$review and execute the task/,
    );
  } finally {
    clearTimeout(deadline);
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function projection(
  content: string,
  sourceText = "Use $review",
  timestamp = 1,
) {
  return {
    sourceText,
    sourceTimestamp: timestamp,
    message: {
      role: "custom" as const,
      customType: "openpi-inline-skill-references",
      content,
      display: false,
      timestamp,
    },
  };
}

function user(text = "Use $review", timestamp = 1) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

test("reanchors duplicate submissions one-to-one and survives repeated equal summaries", () => {
  const manager = SessionManager.inMemory("/fixture");
  manager.appendMessage(user());
  const keptUser = manager.appendMessage(user());
  const original = [
    projection("first snapshot"),
    projection("second snapshot"),
  ];
  manager.appendCompaction("same summary", keptUser, 10000);
  const context = () =>
    manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  const once = reanchorCompactedSkillReferences(
    original,
    manager.getBranch(),
    manager.buildContextEntries(),
  );
  const first = injectInlineSkillReferences(structuredClone(context()), once);
  assert.deepEqual(
    first?.map((message) => message.role),
    ["compactionSummary", "custom", "user", "custom"],
  );
  assert.equal(
    once[1],
    original[1],
    "retained source must not move to summary",
  );
  assert.deepEqual(
    original.map((item) => Object.keys(item)),
    [
      ["sourceText", "sourceTimestamp", "message"],
      ["sourceText", "sourceTimestamp", "message"],
    ],
    "original snapshots stay immutable",
  );

  const tail = manager.appendMessage(user("Keep this tail", 2));
  manager.appendCompaction("same summary", tail, 10000);
  const twice = reanchorCompactedSkillReferences(
    once,
    manager.getBranch(),
    manager.buildContextEntries(),
  );
  const second = injectInlineSkillReferences(structuredClone(context()), twice);
  assert.deepEqual(
    second
      ?.filter((message) => message.role === "custom")
      .map((message) => message.content),
    ["first snapshot", "second snapshot"],
  );
  assert.deepEqual(
    second?.map((message) => message.role),
    ["compactionSummary", "custom", "custom", "user"],
  );
  if (second?.[1]?.role === "custom")
    second[1].content = "mutated by another context handler";
  const retry = injectInlineSkillReferences(structuredClone(context()), twice);
  assert.deepEqual(
    retry
      ?.filter((message) => message.role === "custom")
      .map((message) => message.content),
    ["first snapshot", "second snapshot"],
  );
});

test("missing source is not treated as proof of successful compaction", () => {
  const pending = projection("queued instructions");
  const manager = SessionManager.inMemory("/fixture");
  const unrelated = manager.appendMessage(user("Unrelated message", 2));
  manager.appendCompaction("other summary", unrelated, 10000);
  const context = manager
    .buildContextEntries()
    .flatMap(sessionEntryToContextMessages);
  assert.equal(injectInlineSkillReferences(context, [pending]), undefined);
  const unchanged = reanchorCompactedSkillReferences(
    [pending],
    manager.getBranch(),
    manager.buildContextEntries(),
  );
  assert.equal(
    unchanged[0],
    pending,
    "source must be in the canonical branch before reanchoring",
  );
  assert.equal(injectInlineSkillReferences(context, unchanged), undefined);
  assert.deepEqual(
    injectInlineSkillReferences([user()], unchanged)?.map(
      (message) => message.role,
    ),
    ["user", "custom"],
  );
});

test("no completed compaction leaves the original projection untouched", () => {
  const manager = SessionManager.inMemory("/fixture");
  manager.appendMessage(user());
  const original = [projection("snapshot")];
  const unchanged = reanchorCompactedSkillReferences(
    original,
    manager.getBranch(),
    manager.buildContextEntries(),
  );
  assert.equal(unchanged, original);
  assert.equal(injectInlineSkillReferences([], unchanged), undefined);
});
