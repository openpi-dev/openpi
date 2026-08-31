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
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import inlineSkillReferences, {
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
  readonly providerMessages: unknown;
  readonly errors: ExtensionError[];
}

async function runSession(
  options: { prompt?: string; removeSkillBeforePrompt?: boolean } = {},
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
  provider.setResponses([
    (context) => {
      snapshots.push(structuredClone(context.messages));
      return fauxAssistantMessage("Done.");
    },
  ]);

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
    extensionFactories: [inlineSkillReferences],
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
    await session.prompt(
      options.prompt ?? "Please use $review, then report the result.",
    );
    await session.waitForIdle();
    return {
      messages: structuredClone(session.messages),
      providerMessages: snapshots[0],
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
  const hidden = result.messages.find(
    (message) =>
      message.role === "custom" &&
      message.customType === "openpi-inline-skill-references",
  );

  assert.equal(user?.role, "user");
  assert.deepEqual(user.content, [
    {
      type: "text",
      text: "Please use $review, then report the result.",
    },
  ]);
  assert.equal(hidden?.role, "custom");
  assert.equal(hidden.display, false);
  assert.match(String(hidden.content), /<skill name="review"/);
  assert.match(
    String(hidden.content),
    /Follow the review body, not the frontmatter\./,
  );
  assert.doesNotMatch(String(hidden.content), /disable-model-invocation/);
  assert.doesNotMatch(String(hidden.content), /<skill name="other"/);

  const modelContext = JSON.stringify(result.providerMessages);
  assert.match(modelContext, /Please use \$review, then report the result\./);
  assert.match(modelContext, /<skill name=\\"review\\"/);
  assert.equal(result.errors.length, 0);
});

test("does not reinterpret native slash Skill expansion as user references", async () => {
  const result = await runSession({ prompt: "/skill:review" });

  assert.equal(
    result.messages.some(({ role }) => role === "custom"),
    false,
  );
  const modelContext = JSON.stringify(result.providerMessages);
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
  assert.equal(result.errors[0]?.event, "before_agent_start");
  assert.match(
    result.errors[0]?.error ?? "",
    /Failed to load inline Skill "review"/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.providerMessages),
    /<skill name=\\"review\\"/,
  );
});
