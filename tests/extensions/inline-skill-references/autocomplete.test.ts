import assert from "node:assert/strict";
import test from "node:test";
import type {
  AutocompleteProviderFactory,
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

test("completion shares submitted reference boundaries across lines", async () => {
  const provider = autocompleteHarness([
    command("skill:review", "skill", "Review"),
  ]);
  const options = { signal: new AbortController().signal };
  assert.equal(
    await provider.getSuggestions(["First line", "$r"], 1, 2, options),
    null,
  );
  assert.equal(
    (await provider.getSuggestions(["First line", " $r"], 1, 3, options))
      ?.items[0]?.value,
    "$review",
  );
});

test("preserves custom triggers from an existing autocomplete provider", () => {
  const provider = autocompleteHarness([], {
    triggerCharacters: ["!", "$"],
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  });
  assert.deepEqual(provider.triggerCharacters, ["!", "$"]);
});

test("our Skill completion inserts literally without a foreign provider rewriting it", async () => {
  let delegated = 0;
  const provider = autocompleteHarness(
    [command("skill:review", "skill", "Review")],
    {
      getSuggestions: async () => null,
      applyCompletion(lines, cursorLine, cursorCol) {
        delegated += 1;
        return { lines: ["wrong"], cursorLine, cursorCol };
      },
    },
  );
  const options = { signal: new AbortController().signal };
  const suggestions = await provider.getSuggestions(
    ["Use $r, please"],
    0,
    6,
    options,
  );
  assert.ok(suggestions);
  const result = provider.applyCompletion(
    ["Use $r, please"],
    0,
    6,
    suggestions.items[0]!,
    suggestions.prefix,
  );
  assert.deepEqual(result, {
    lines: ["Use $review, please"],
    cursorLine: 0,
    cursorCol: 11,
  });
  assert.equal(delegated, 0);
});
