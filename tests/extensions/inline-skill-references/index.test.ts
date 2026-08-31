import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionError,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import inlineSkillReferences, {
  createInlineSkillProjection,
  injectInlineSkillReferences,
  referencedSkills,
} from "../../../extensions/inline-skill-references/index.ts";

function skill(name: string): Skill {
  const baseDir = `/skills/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir,
    sourceInfo: {
      path: filePath,
      source: baseDir,
      scope: "temporary",
      origin: "top-level",
      baseDir,
    },
    disableModelInvocation: false,
  };
}

test("selects known references once in first-reference order", () => {
  const skills = [skill("first-skill"), skill("second-skill")];

  assert.deepEqual(
    referencedSkills(
      "$second-skill, then $first-skill. Repeat\t$second-skill)",
      skills,
    ).map(({ name }) => name),
    ["second-skill", "first-skill"],
  );
});

test("accepts only start-of-input or horizontal-whitespace boundaries", () => {
  const available = [skill("review")];

  for (const prompt of [
    "abc$review",
    "\\$review",
    "line one\n$review",
    "$unknown",
    "$reviewer",
    "$review_thing",
    "$review技能",
    "$review𠮷",
    "$review𝔞",
    "$review\u0301",
    "line one\r\n$review",
  ]) {
    assert.deepEqual(referencedSkills(prompt, available), [], prompt);
  }

  assert.deepEqual(
    referencedSkills("Use $review, please", available).map(({ name }) => name),
    ["review"],
  );
});

test("resolves each turn from Pi's supplied Skill set without caching", () => {
  const prompt = "Use $current-skill";

  assert.deepEqual(
    referencedSkills(prompt, [skill("current-skill")]).map(({ name }) => name),
    ["current-skill"],
  );
  assert.deepEqual(referencedSkills(prompt, [skill("replacement-skill")]), []);
});

interface SessionResult {
  readonly messages: Awaited<
    ReturnType<typeof createAgentSession>
  >["session"]["messages"];
  readonly providerMessages: unknown[];
  readonly errors: ExtensionError[];
}

async function runSession(
  options: {
    prompt?: string;
    removeSkillBeforePrompt?: boolean;
    mutateSkillDuringRun?: boolean;
    reloadWithLaterSkill?: boolean;
    secondPrompt?: string;
    queued?: {
      behavior: "steer" | "followUp";
      direct: boolean;
      prompt: string;
    };
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-inline-skills-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const skillDir = path.join(agentDir, "skills", "review");
  const skillPath = path.join(skillDir, "SKILL.md");
  const otherSkillDir = path.join(agentDir, "skills", "other");
  await mkdir(cwd, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await mkdir(otherSkillDir, { recursive: true });
  await writeFile(
    skillPath,
    [
      "---",
      "name: review",
      "description: Review the requested change",
      "disable-model-invocation: true",
      "---",
      "Follow the review body, not the frontmatter. Do not expand $other from this body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(otherSkillDir, "SKILL.md"),
    [
      "---",
      "name: other",
      "description: Another Skill",
      "---",
      "This body must load only from an explicit user reference.",
      "",
    ].join("\n"),
  );

  const snapshots: unknown[] = [];
  const errors: ExtensionError[] = [];
  const provider = fauxProvider({
    api: "openpi-inline-skills-test",
    provider: `openpi-inline-skills-${path.basename(root)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  const captureDone = (context: { messages: unknown[] }) => {
    snapshots.push(structuredClone(context.messages));
    return fauxAssistantMessage("Done.");
  };
  if (options.mutateSkillDuringRun) {
    provider.setResponses([
      (context) => {
        snapshots.push(structuredClone(context.messages));
        return fauxAssistantMessage(
          fauxToolCall("mutate_inline_skill_fixture", {}, { id: "mutate" }),
          { stopReason: "toolUse" },
        );
      },
      captureDone,
    ]);
  } else {
    provider.setResponses(
      Array.from(
        {
          length:
            options.queued ||
            options.reloadWithLaterSkill ||
            options.secondPrompt
              ? 2
              : 1,
        },
        () => captureDone,
      ),
    );
  }

  const extensionFactories = [inlineSkillReferences];
  if (options.mutateSkillDuringRun) {
    extensionFactories.push((pi) => {
      pi.registerTool({
        name: "mutate_inline_skill_fixture",
        label: "Mutate inline Skill fixture",
        description: "Mutates the inline Skill fixture during a tool loop",
        parameters: Type.Object({}),
        async execute() {
          await writeFile(
            skillPath,
            "---\nname: review\n---\nMutated Skill body.\n",
          );
          return {
            content: [{ type: "text", text: "mutated" }],
            details: {},
          };
        },
      });
    });
  }

  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
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
    extensionFactories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });

  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error),
    });
    if (options.removeSkillBeforePrompt) await unlink(skillPath);
    let queued: Promise<void> | undefined;
    let didQueue = false;
    const queuedInput = options.queued;
    const unsubscribe = queuedInput
      ? session.subscribe((event) => {
          if (event.type !== "turn_start" || didQueue) return;
          didQueue = true;
          queued = queuedInput.direct
            ? session[queuedInput.behavior](queuedInput.prompt)
            : session.prompt(queuedInput.prompt, {
                streamingBehavior: queuedInput.behavior,
              });
        })
      : undefined;
    await session.prompt(
      options.prompt ??
        (options.queued
          ? "Start the run."
          : "Please use $review, then report the result."),
    );
    if (options.reloadWithLaterSkill) {
      const laterSkillDir = path.join(agentDir, "skills", "later");
      await mkdir(laterSkillDir, { recursive: true });
      await writeFile(
        path.join(laterSkillDir, "SKILL.md"),
        "---\nname: later\ndescription: Later Skill\n---\nLater Skill body.\n",
      );
      await session.reload();
      await session.prompt("The second turn is unrelated.");
    } else if (options.secondPrompt) {
      await session.prompt(options.secondPrompt);
    }
    await queued;
    await session.waitForIdle();
    unsubscribe?.();
    return {
      messages: structuredClone(session.messages),
      providerMessages: snapshots,
      errors,
    } satisfies SessionResult;
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("keeps raw user text visible and adds frontmatter-free hidden model context", async () => {
  const result = await runSession();
  const user = result.messages.find(({ role }) => role === "user");

  assert.equal(user?.role, "user");
  assert.deepEqual(user.content, [
    {
      type: "text",
      text: "Please use $review, then report the result.",
    },
  ]);
  assert.equal(
    result.messages.some(
      (message) =>
        message.role === "custom" &&
        message.customType === "openpi-inline-skill-references",
    ),
    false,
  );

  const modelContext = JSON.stringify(result.providerMessages[0]);
  assert.match(modelContext, /Please use \$review, then report the result\./);
  assert.match(modelContext, /<skill name=\\"review\\"/);
  assert.match(modelContext, /Follow the review body, not the frontmatter\./);
  assert.doesNotMatch(modelContext, /disable-model-invocation/);
  assert.doesNotMatch(modelContext, /<skill name=\\"other\\"/);
  assert.equal(result.errors.length, 0);
});

test("projects one hidden custom message without changing its source messages", async () => {
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Use $review" }],
      timestamp: 1,
    },
  ];
  const available = skill("review");
  const root = await mkdtemp(path.join(tmpdir(), "openpi-inline-projection-"));
  const filePath = path.join(root, "SKILL.md");
  await writeFile(filePath, "---\nname: review\n---\nReview body.\n");

  try {
    const projection = await createInlineSkillProjection(messages[0], [
      { ...available, filePath, baseDir: root },
    ]);
    const projected = injectInlineSkillReferences(
      messages,
      projection ? [projection] : [],
    );
    assert.equal(projected?.length, 2);
    assert.equal(projected?.[1]?.role, "custom");
    if (projected?.[1]?.role === "custom") {
      assert.equal(projected[1].display, false);
      assert.match(String(projected[1].content), /Review body\./);
    }
    assert.equal(messages.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates stored projections from later context handler mutations", async () => {
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Use $review" }],
      timestamp: 1,
    },
  ];
  const available = skill("review");
  const root = await mkdtemp(path.join(tmpdir(), "openpi-inline-isolation-"));
  const filePath = path.join(root, "SKILL.md");
  await writeFile(filePath, "---\nname: review\n---\nOriginal body.\n");

  try {
    const projection = await createInlineSkillProjection(messages[0], [
      { ...available, filePath, baseDir: root },
    ]);
    assert.ok(projection);

    const first = injectInlineSkillReferences(messages, [projection]);
    assert.equal(first?.[1]?.role, "custom");
    if (first?.[1]?.role === "custom") {
      first[1].content = "Mutated by a later context handler.";
    }

    const second = injectInlineSkillReferences(messages, [projection]);
    assert.equal(second?.[1]?.role, "custom");
    if (second?.[1]?.role === "custom") {
      assert.match(String(second[1].content), /Original body\./);
      assert.notEqual(first?.[1], second[1]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expands streaming prompts and direct queued Session inputs", async () => {
  for (const queued of [
    { behavior: "steer" as const, direct: false },
    { behavior: "followUp" as const, direct: false },
    { behavior: "steer" as const, direct: true },
    { behavior: "followUp" as const, direct: true },
  ]) {
    const prompt = `Please use $review through ${queued.behavior}.`;
    const result = await runSession({ queued: { ...queued, prompt } });
    const modelContext = JSON.stringify(result.providerMessages.at(-1));

    assert.match(modelContext, new RegExp(prompt.replace("$", "\\$")));
    assert.match(modelContext, /<skill name=\\"review\\"/);
    assert.equal(result.errors.length, 0);
  }
});

test("does not reinterpret an old unknown reference after a Skill reload", async () => {
  const result = await runSession({
    prompt: "Mention $later before that Skill exists.",
    reloadWithLaterSkill: true,
  });

  assert.equal(result.providerMessages.length, 2);
  assert.match(
    JSON.stringify(result.providerMessages[1]),
    /Mention \$later before that Skill exists\./,
  );
  assert.doesNotMatch(
    JSON.stringify(result.providerMessages[1]),
    /<skill name=\\"later\\"/,
  );
  assert.equal(result.errors.length, 0);
});

test("removes a settled turn's Skill projection from later turns", async () => {
  const result = await runSession({
    secondPrompt: "An unrelated second turn.",
  });

  assert.equal(result.providerMessages.length, 2);
  assert.doesNotMatch(
    JSON.stringify(result.providerMessages[1]),
    /<skill name=\\"review\\"/,
  );
  assert.equal(result.errors.length, 0);
});

test("keeps one Skill projection stable through later provider calls", async () => {
  const result = await runSession({ mutateSkillDuringRun: true });

  assert.equal(result.providerMessages.length, 2);
  for (const modelContext of result.providerMessages) {
    const serialized = JSON.stringify(modelContext);
    assert.match(serialized, /Follow the review body, not the frontmatter\./);
    assert.doesNotMatch(serialized, /Mutated Skill body\./);
  }
  assert.equal(result.errors.length, 0);
});

test("does not reinterpret native slash Skill expansion as user references", async () => {
  const result = await runSession({ prompt: "/skill:review" });

  assert.equal(
    result.messages.some(({ role }) => role === "custom"),
    false,
  );
  const modelContext = JSON.stringify(result.providerMessages[0]);
  assert.match(modelContext, /<skill name=\\"review\\"/);
  assert.doesNotMatch(modelContext, /<skill name=\\"other\\"/);
  assert.equal(result.errors.length, 0);
});

test("surfaces Skill read failures and injects no false loaded context", async () => {
  const result = await runSession({ removeSkillBeforePrompt: true });

  assert.equal(
    result.messages.some(({ role }) => role === "custom"),
    false,
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.event, "message_end");
  assert.match(
    result.errors[0]?.error ?? "",
    /Failed to load inline Skill "review"/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.providerMessages[0]),
    /<skill name=\\"review\\"/,
  );
});
