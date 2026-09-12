import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  contentText,
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  ModelRuntime,
  parseSkillBlock,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionDirectory = fileURLToPath(
  new URL("../../../extensions", import.meta.url),
);
const body = "NATIVE_REVIEW_BODY. Literal $explicit is not another invocation.";
const skillFile = (content = body) =>
  `---\nname: review\ndescription: Review fixture\n---\n${content}\n`;
let root: string;
let agentDir: string;
let skillPath: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openpi-native-skills-"));
  agentDir = path.join(root, "agent");
  // Load the real package extensions against an isolated agent directory, never
  // the developer's setup, credentials, Skills, or project settings.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  skillPath = path.join(agentDir, "skills/review/SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, skillFile());
  const explicitPath = path.join(agentDir, "skills/explicit/SKILL.md");
  await mkdir(path.dirname(explicitPath), { recursive: true });
  await writeFile(
    explicitPath,
    "---\nname: explicit\ndescription: Explicit fixture\ndisable-model-invocation: true\n---\nEXPLICIT_ONLY_BODY\n",
  );
});

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
});

async function withSession(
  run: (fixture: {
    session: AgentSession;
    manager: SessionManager;
    snapshots: Context[];
    errors: ExtensionError[];
    provider: ReturnType<typeof fauxProvider>;
    capture: (context: Context) => ReturnType<typeof fauxAssistantMessage>;
  }) => Promise<void>,
) {
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  const snapshots: Context[] = [];
  const errors: ExtensionError[] = [];
  const provider = fauxProvider({
    api: "openpi-native-skills-test",
    provider: `native-skills-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  const capture = (context: Context) => {
    snapshots.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
    });
    return fauxAssistantMessage("Completed the fixture request.");
  };
  provider.setResponses(Array.from({ length: 8 }, () => capture));
  const settingsManager = SettingsManager.inMemory(
    {
      packages: [path.dirname(extensionDirectory)],
      compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 1000 },
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
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [path.join(agentDir, "skills")],
    noSkills: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(loader.getExtensions().extensions.length > 0);
  assert.deepEqual(
    loader
      .getSkills()
      .skills.map((skill) => skill.name)
      .sort(),
    ["explicit", "review"],
  );
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
  });
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (e) => errors.push(e),
    });
    await run({ session, manager, snapshots, errors, provider, capture });
    assert.deepEqual(
      session.messages.flatMap((message) =>
        message.role === "assistant" && message.stopReason === "error"
          ? [message.errorMessage]
          : [],
      ),
      [],
      "a provider failure must not masquerade as a successful context check",
    );
  } finally {
    await session.abort();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
}

test("OpenPI leaves dollar references as ordinary text, without hidden Skill bodies", async () => {
  await withSession(async ({ session, manager, snapshots, errors }) => {
    const prompt = "Use $review, $explicit and $unknown as ordinary text.";
    await session.prompt(prompt);
    assert.equal(snapshots.length, 1, JSON.stringify(session.messages));
    const user = session.messages.find((message) => message.role === "user");
    assert.ok(user);
    assert.equal(contentText(user.content), prompt);
    assert.equal(
      /NATIVE_REVIEW_BODY|EXPLICIT_ONLY_BODY/.test(JSON.stringify(snapshots)),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(manager.getEntries()),
      /NATIVE_REVIEW_BODY|EXPLICIT_ONLY_BODY/,
    );
    assert.deepEqual(errors, []);
  });
});

test("Pi exposes metadata first and its native read puts the Skill in ordinary tool history", async () => {
  await withSession(
    async ({ session, manager, snapshots, provider, capture, errors }) => {
      provider.setResponses([
        (context) => {
          capture(context);
          return fauxAssistantMessage(
            fauxToolCall("read", { path: skillPath }, { id: "read-skill" }),
            { stopReason: "toolUse" },
          );
        },
        capture,
      ]);
      await session.prompt("Read the review instructions when needed.");
      assert.equal(snapshots.length, 2);
      assert.match(snapshots[0]!.systemPrompt ?? "", /<name>review<\/name>/);
      assert.match(snapshots[0]!.systemPrompt ?? "", /Use the read tool/);
      assert.doesNotMatch(
        snapshots[0]!.systemPrompt ?? "",
        /<name>explicit<\/name>|NATIVE_REVIEW_BODY/,
      );
      assert.doesNotMatch(
        JSON.stringify(snapshots[0]!.messages),
        /NATIVE_REVIEW_BODY/,
      );
      const read = snapshots[1]!.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "read",
      );
      assert.ok(read);
      assert.match(JSON.stringify(read), /NATIVE_REVIEW_BODY/);
      assert.match(JSON.stringify(manager.getEntries()), /NATIVE_REVIEW_BODY/);
      assert.deepEqual(errors, []);
    },
  );
});

test("native slash invocation expands once into a persisted user message, including explicit-only Skills", async () => {
  await withSession(async ({ session, manager, snapshots, errors }) => {
    await session.prompt("/skill:review Check this change.");
    const user = session.messages.find((message) => message.role === "user");
    assert.ok(user);
    const text = contentText(user.content);
    const block = parseSkillBlock(text);
    assert.equal(block?.name, "review");
    assert.equal(block?.userMessage, "Check this change.");
    assert.match(text, /NATIVE_REVIEW_BODY/);
    assert.doesNotMatch(text, /description:|EXPLICIT_ONLY_BODY/);
    assert.equal(
      JSON.stringify(snapshots[0]!.messages).split("NATIVE_REVIEW_BODY")
        .length - 1,
      1,
    );
    await session.prompt("/skill:explicit Check this too.");
    assert.match(JSON.stringify(snapshots[1]!.messages), /EXPLICIT_ONLY_BODY/);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile);
    const persisted = JSON.stringify(reopened.buildSessionContext().messages);
    assert.match(persisted, /NATIVE_REVIEW_BODY/);
    assert.match(persisted, /EXPLICIT_ONLY_BODY/);
    assert.deepEqual(errors, []);
  });
});

test("native slash invocation works through direct and streaming queued inputs", async (t) => {
  for (const behavior of ["steer", "followUp"] as const) {
    for (const direct of [false, true]) {
      await t.test(`${behavior}, direct=${direct}`, async () => {
        await withSession(async ({ session, snapshots, errors }) => {
          let queued: Promise<void> | undefined;
          const unsubscribe = session.subscribe((event) => {
            if (
              event.type !== "message_end" ||
              event.message.role !== "assistant" ||
              queued
            )
              return;
            queued = direct
              ? session[behavior]("/skill:review Continue the task.")
              : session.prompt("/skill:review Continue the task.", {
                  streamingBehavior: behavior,
                });
          });
          try {
            await session.prompt("Start the task.");
            await queued;
            await session.waitForIdle();
            assert.equal(snapshots.length, 2);
            assert.doesNotMatch(
              JSON.stringify(snapshots[0]!.messages),
              /NATIVE_REVIEW_BODY/,
            );
            assert.match(
              JSON.stringify(snapshots[1]!.messages),
              /NATIVE_REVIEW_BODY/,
            );
            assert.deepEqual(errors, []);
          } finally {
            unsubscribe();
          }
        });
      });
    }
  }
});

test("Pi reports missing Skill files and leaves unknown slash commands unchanged", async () => {
  await withSession(async ({ session, snapshots, errors }) => {
    await unlink(skillPath);
    try {
      await session.prompt("/skill:review Check this.");
      assert.ok(errors.some((error) => error.event === "skill_expansion"));
      assert.doesNotMatch(JSON.stringify(snapshots), /NATIVE_REVIEW_BODY/);
      await session.prompt("/skill:unknown Check this.");
      const last = session.messages
        .filter((message) => message.role === "user")
        .at(-1);
      assert.ok(last);
      assert.equal(contentText(last.content), "/skill:unknown Check this.");
    } finally {
      await writeFile(skillPath, skillFile());
    }
  });
});

test("native compaction drops old Skill text from context without deleting history or reinjecting it", async () => {
  await withSession(async ({ session, manager, snapshots, errors }) => {
    await session.prompt("/skill:review Check this.");
    const source = manager
      .getEntries()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    assert.ok(source);
    await session.prompt(
      `Continue with this recent material: ${"recent ".repeat(500)}`,
    );
    await session.compact();
    assert.equal(
      manager.buildContextEntries().some((entry) => entry.id === source.id),
      false,
    );
    assert.doesNotMatch(JSON.stringify(session.messages), /NATIVE_REVIEW_BODY/);
    assert.match(JSON.stringify(manager.getEntries()), /NATIVE_REVIEW_BODY/);
    await session.prompt("Continue after the summary.");
    assert.doesNotMatch(
      JSON.stringify(snapshots.at(-1)!.messages),
      /NATIVE_REVIEW_BODY/,
    );
    // An explicit later invocation reads the current file, not a frozen copy.
    await writeFile(skillPath, skillFile("UPDATED_NATIVE_BODY"));
    try {
      await session.prompt("/skill:review Read the current instructions.");
      assert.match(
        JSON.stringify(snapshots.at(-1)!.messages),
        /UPDATED_NATIVE_BODY/,
      );
      assert.doesNotMatch(
        JSON.stringify(snapshots.at(-1)!.messages),
        /NATIVE_REVIEW_BODY/,
      );
    } finally {
      await writeFile(skillPath, skillFile());
    }
    assert.deepEqual(errors, []);
  });
});
