import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutocompleteProviderFactory,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Editor,
  type AutocompleteProvider,
  type TUI,
} from "@earendil-works/pi-tui";
import inlineSkillReferencesExtension from "../../../extensions/inline-skill-references/index.ts";

const sourceInfo = {
  path: "/fixture",
  source: "local",
  scope: "project",
  origin: "top-level",
} as const;

function command(
  name: string,
  source: SlashCommandInfo["source"],
  description: string,
): SlashCommandInfo {
  return { name, source, description, sourceInfo };
}

function autocompleteHarness(
  commands: SlashCommandInfo[],
  delegated: AutocompleteProvider = new CombinedAutocompleteProvider(
    [],
    "/fixture",
  ),
) {
  const sessionStarts: Array<
    (event: unknown, context: ExtensionContext) => void
  > = [];
  let factory: AutocompleteProviderFactory | undefined;
  const pi = {
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      if (event === "session_start") sessionStarts.push(handler);
    },
    getCommands: () => commands,
  } as unknown as ExtensionAPI;

  inlineSkillReferencesExtension(pi);
  for (const start of sessionStarts) {
    start({}, {
      mode: "tui",
      ui: {
        addAutocompleteProvider(candidate: AutocompleteProviderFactory) {
          factory = candidate;
        },
      },
    } as unknown as ExtensionContext);
  }

  assert.ok(
    factory,
    "the TUI session should register an autocomplete provider",
  );
  return factory(delegated);
}

function expansionHarness() {
  const beforeStarts: Array<
    (
      event: BeforeAgentStartEvent,
      context: ExtensionContext,
    ) =>
      | Promise<BeforeAgentStartEventResult | void>
      | BeforeAgentStartEventResult
      | void
  > = [];
  const pi = {
    on(
      event: string,
      handler: (
        event: BeforeAgentStartEvent,
        context: ExtensionContext,
      ) =>
        | Promise<BeforeAgentStartEventResult | void>
        | BeforeAgentStartEventResult
        | void,
    ) {
      if (event === "before_agent_start") beforeStarts.push(handler);
    },
  } as unknown as ExtensionAPI;

  inlineSkillReferencesExtension(pi);
  assert.equal(
    beforeStarts.length,
    1,
    "the shared pre-model hook is registered",
  );

  return async (event: BeforeAgentStartEvent) =>
    beforeStarts[0]!(event, {} as ExtensionContext);
}

interface SkillFixture {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

async function createSkillFixtures(fixtures: readonly SkillFixture[]) {
  const root = await mkdtemp(join(tmpdir(), "openpi-inline-skill-"));
  const skills = await Promise.all(
    fixtures.map(async (fixture) => {
      const baseDir = join(root, fixture.name);
      const filePath = join(baseDir, "SKILL.md");
      await mkdir(baseDir);
      await writeFile(
        filePath,
        [
          "---",
          `name: ${fixture.name}`,
          `description: ${fixture.description}`,
          "---",
          "",
          fixture.body,
        ].join("\n"),
      );
      return {
        name: fixture.name,
        description: fixture.description,
        filePath,
        baseDir,
        sourceInfo,
        disableModelInvocation: false,
      };
    }),
  );
  return { root, skills };
}

test("inline completion lists only the current Skill commands with descriptions", async () => {
  const provider = autocompleteHarness([
    command("skill:review", "skill", "Review a change"),
    command("skill:tdd", "skill", "Work test-first"),
    command("reload", "extension", "Reload resources"),
    command("release-notes", "prompt", "Draft release notes"),
  ]);

  const suggestions = await provider.getSuggestions(
    ["Please use $r"],
    0,
    "Please use $r".length,
    { signal: new AbortController().signal },
  );

  assert.deepEqual(suggestions, {
    prefix: "$r",
    items: [
      {
        value: "$review",
        label: "$review",
        description: "Review a change",
      },
    ],
  });
});

test("inline completion follows Pi's current command projection without a cache", async () => {
  const commands = [command("skill:review", "skill", "Review a change")];
  const provider = autocompleteHarness(commands);

  commands.splice(0, 1, command("skill:release", "skill", "Prepare a release"));
  const suggestions = await provider.getSuggestions(["$r"], 0, 2, {
    signal: new AbortController().signal,
  });

  assert.deepEqual(suggestions?.items, [
    {
      value: "$release",
      label: "$release",
      description: "Prepare a release",
    },
  ]);
});

test("inline completion does not impose a second Skill-name validator", async () => {
  const provider = autocompleteHarness([
    command("skill:Review", "skill", "Review a change"),
  ]);

  const suggestions = await provider.getSuggestions(
    ["Please use $R"],
    0,
    "Please use $R".length,
    { signal: new AbortController().signal },
  );

  assert.deepEqual(suggestions, {
    prefix: "$R",
    items: [
      {
        value: "$Review",
        label: "$Review",
        description: "Review a change",
      },
    ],
  });
});

test("inline completion is registered only for TUI sessions", () => {
  const sessionStarts: Array<
    (event: unknown, context: ExtensionContext) => void
  > = [];
  let registered = false;
  const pi = {
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      if (event === "session_start") sessionStarts.push(handler);
    },
  } as unknown as ExtensionAPI;

  inlineSkillReferencesExtension(pi);
  sessionStarts[0]!(
    {} as unknown,
    {
      mode: "rpc",
      ui: {
        addAutocompleteProvider() {
          registered = true;
        },
      },
    } as unknown as ExtensionContext,
  );

  assert.equal(registered, false);
});

test("inline completion delegates slash and file completion unchanged", async () => {
  const calls: string[] = [];
  const delegated: AutocompleteProvider = {
    async getSuggestions() {
      calls.push("suggestions");
      return {
        prefix: "delegated",
        items: [{ value: "delegated", label: "delegated" }],
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      calls.push("apply");
      return { lines: ["delegated"], cursorLine, cursorCol: 9 };
    },
    shouldTriggerFileCompletion() {
      calls.push("file-trigger");
      return false;
    },
  };
  const provider = autocompleteHarness([], delegated);

  const slash = await provider.getSuggestions(["/reload"], 0, 7, {
    signal: new AbortController().signal,
  });
  const file = await provider.getSuggestions(["Use @README"], 0, 11, {
    signal: new AbortController().signal,
  });
  const completion = provider.applyCompletion(
    ["$review"],
    0,
    7,
    {
      value: "$review",
      label: "$review",
    },
    "$review",
  );
  const fileTrigger = provider.shouldTriggerFileCompletion?.(["@README"], 0, 7);

  assert.deepEqual(slash, {
    prefix: "delegated",
    items: [{ value: "delegated", label: "delegated" }],
  });
  assert.deepEqual(file, slash);
  assert.deepEqual(completion, {
    lines: ["delegated"],
    cursorLine: 0,
    cursorCol: 9,
  });
  assert.equal(fileTrigger, false);
  assert.deepEqual(calls, [
    "suggestions",
    "suggestions",
    "apply",
    "file-trigger",
  ]);
});

test("Tab accepts an inline Skill completion without submitting the editor", async () => {
  const provider = autocompleteHarness([
    command("skill:review", "skill", "Review a change"),
  ]);
  let signalSuggestionsReady: () => void = () => {};
  const suggestionsReady = new Promise<void>((resolve) => {
    signalSuggestionsReady = resolve;
  });
  const editor = new Editor(
    {
      terminal: { rows: 24 },
      requestRender() {
        signalSuggestionsReady();
      },
    } as unknown as TUI,
    {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text,
        selectedText: (text) => text,
        description: (text) => text,
        scrollInfo: (text) => text,
        noMatch: (text) => text,
      },
    },
  );
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setAutocompleteProvider(provider);
  editor.setText("Use ");

  editor.handleInput("$");
  await suggestionsReady;
  assert.match(editor.render(80).join("\n"), /\$review/);
  editor.handleInput("\t");

  assert.equal(editor.getText(), "Use $review");
  assert.deepEqual(submitted, []);
});

test("a submitted inline reference preserves user text and injects hidden Skill content", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const skill = fixtures.skills[0]!;
  const expand = expansionHarness();
  const prompt = "Please use $review.";

  try {
    const result = await expand({
      type: "before_agent_start",
      prompt,
      systemPrompt: "system",
      systemPromptOptions: {
        cwd: fixtures.root,
        skills: fixtures.skills,
      },
    });

    assert.equal(prompt, "Please use $review.");
    assert.equal(result?.message?.display, false);
    assert.equal(
      result?.message?.content,
      [
        `<skill name="review" location="${skill.filePath}">`,
        `References are relative to ${skill.baseDir}.`,
        "",
        "Review the diff before approving it.",
        "</skill>",
      ].join("\n"),
    );
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("ordinary punctuation terminates an inline Skill reference", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const expand = expansionHarness();

  try {
    for (const punctuation of ["(", "#", "/"]) {
      const result = await expand({
        type: "before_agent_start",
        prompt: `Use $review${punctuation}`,
        systemPrompt: "system",
        systemPromptOptions: { cwd: fixtures.root, skills: fixtures.skills },
      });

      assert.equal(result?.message?.display, false, punctuation);
    }
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("native slash Skill content is skipped while its user arguments expand", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const expand = expansionHarness();
  const nativeSkillPrompt = [
    '<skill name="native" location="/fixture/native/SKILL.md">',
    "References are relative to /fixture/native.",
    "",
    "This native Skill body mentions $review.",
    "</skill>",
    "",
    "Then apply $review.",
  ].join("\n");

  try {
    const result = await expand({
      type: "before_agent_start",
      prompt: nativeSkillPrompt,
      systemPrompt: "system",
      systemPromptOptions: { cwd: fixtures.root, skills: fixtures.skills },
    });

    assert.equal(result?.message?.display, false);
    const content = result?.message?.content;
    if (typeof content !== "string") {
      throw new Error("expected the hidden Skill message to contain text");
    }
    assert.equal((content.match(/<skill name=/g) ?? []).length, 1);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("submitted references load distinct known Skills in first-reference order", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "tdd",
      description: "Work test-first",
      body: "Start with a failing test.",
    },
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const expand = expansionHarness();
  const prompt = "$tdd, then $review.) Finally, $tdd again.";

  try {
    const result = await expand({
      type: "before_agent_start",
      prompt,
      systemPrompt: "system",
      systemPromptOptions: { cwd: fixtures.root, skills: fixtures.skills },
    });
    const content = result?.message?.content;

    assert.equal(prompt, "$tdd, then $review.) Finally, $tdd again.");
    if (typeof content !== "string") {
      throw new Error("expected the hidden Skill message to contain text");
    }
    assert.equal((content.match(/<skill name=/g) ?? []).length, 2);
    assert.ok(content.indexOf('name="tdd"') < content.indexOf('name="review"'));
    assert.match(content, /Start with a failing test\./);
    assert.match(content, /Review the diff before approving it\./);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("unknown, escaped, and embedded dollar text remains ordinary user input", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const expand = expansionHarness();
  const prompt = "$missing, \\$review, prose$review, and $review_extra.";

  try {
    const result = await expand({
      type: "before_agent_start",
      prompt,
      systemPrompt: "system",
      systemPromptOptions: { cwd: fixtures.root, skills: fixtures.skills },
    });

    assert.equal(
      prompt,
      "$missing, \\$review, prose$review, and $review_extra.",
    );
    assert.equal(result, undefined);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("a known reference expands alongside ignored candidates in the same line", async () => {
  const fixtures = await createSkillFixtures([
    {
      name: "review",
      description: "Review a change",
      body: "Review the diff before approving it.",
    },
  ]);
  const expand = expansionHarness();
  const prompt =
    "$missing, $review, \\$review, prose$review, and $review_extra.";

  try {
    const result = await expand({
      type: "before_agent_start",
      prompt,
      systemPrompt: "system",
      systemPromptOptions: { cwd: fixtures.root, skills: fixtures.skills },
    });

    assert.equal(result?.message?.display, false);
    const content = result?.message?.content;
    if (typeof content !== "string") {
      throw new Error("expected the hidden Skill message to contain text");
    }
    assert.equal((content.match(/<skill name=/g) ?? []).length, 1);
  } finally {
    await rm(fixtures.root, { recursive: true, force: true });
  }
});

test("a Skill content read failure is not silently converted into a loaded reference", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openpi-inline-skill-"));
  const expand = expansionHarness();

  try {
    await assert.rejects(
      expand({
        type: "before_agent_start",
        prompt: "$review",
        systemPrompt: "system",
        systemPromptOptions: {
          cwd: fixtureRoot,
          skills: [
            {
              name: "review",
              description: "Review a change",
              filePath: join(fixtureRoot, "missing-SKILL.md"),
              baseDir: fixtureRoot,
              sourceInfo,
              disableModelInvocation: false,
            },
          ],
        },
      }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
