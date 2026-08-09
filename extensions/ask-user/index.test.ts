import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import askUser, {
  type AskUserAnswer,
  type AskUserInput,
  MAX_ANSWER_DRAFT_UTF8_BYTES,
  answerDraftFits,
  formatAnswers,
  formatPreviewLine,
  formatReviewAnswer,
} from "./index.ts";
import {
  ASK_USER_PROMPT_GUIDELINES,
  buildAskUserResultMessage,
} from "./prompt.ts";

test("formats selected, noted, and custom answers", () => {
  const answers = [
    { id: "db", selected: "Postgres (Recommended)", note: "SQLite in tests" },
    { id: "region", custom: "Singapore" },
  ];
  assert.equal(
    formatAnswers(answers),
    "db: Postgres (Recommended) — SQLite in tests\nregion: Singapore",
  );
  assert.match(
    buildAskUserResultMessage({ kind: "answered", answers }),
    /db: Postgres \(Recommended\).*note: SQLite in tests/,
  );
});

test("preview truncation preserves Unicode characters and strips controls", () => {
  const rendered = formatPreviewLine(
    "123456789😀\u009b2J\u001b]52;c;payload\u0007safe",
    12,
  );
  const plain = stripVTControlCharacters(rendered);
  assert.match(plain, /😀…$/);
  assert.doesNotMatch(plain, /payload|[\u001b\u0080-\u009f]/);
});

test("prompt requires genuine ambiguity, recommendations, and no continue questions", () => {
  const text = ASK_USER_PROMPT_GUIDELINES.join("\n");
  assert.match(text, /genuine ambiguity/);
  assert.match(text, /recommendation first/);
  assert.match(text, /Never use it to ask whether to continue/);
});

test("dismissal does not imply an answer", () => {
  assert.match(
    buildAskUserResultMessage({ kind: "dismissed" }),
    /Do not assume answers/,
  );
});

test("answer drafts have a UTF-8 byte bound", () => {
  assert.equal(answerDraftFits("a".repeat(MAX_ANSWER_DRAFT_UTF8_BYTES)), true);
  assert.equal(
    answerDraftFits("a".repeat(MAX_ANSWER_DRAFT_UTF8_BYTES + 1)),
    false,
  );
  assert.equal(
    answerDraftFits("界".repeat(Math.floor(MAX_ANSWER_DRAFT_UTF8_BYTES / 3))),
    true,
  );
  assert.equal(
    answerDraftFits(
      "界".repeat(Math.floor(MAX_ANSWER_DRAFT_UTF8_BYTES / 3) + 1),
    ),
    false,
  );
});

test("review summaries are single-line, terminal-safe, and bounded", () => {
  const answer = formatReviewAnswer(
    {
      id: "region",
      custom: "Singapore\nwith controls\u001b]52;c;payload\u0007",
      note: "close to users",
    },
    32,
  );
  assert.equal(stripVTControlCharacters(answer), answer);
  assert.doesNotMatch(answer, /\n|payload/);
  assert.ok([...answer].length <= 32);
  assert.match(answer, /…$/);
});

interface InteractiveComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

interface AskUserToolResult {
  details: {
    answers: AskUserAnswer[];
    cancelled: boolean;
  };
}

type AskUserExecute = (
  toolCallId: string,
  params: AskUserInput,
  signal: AbortSignal,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AskUserToolResult>;

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const input = {
  enter: "\r",
  escape: "\u001b",
  tab: "\t",
  up: "\u001b[A",
  down: "\u001b[B",
} as const;

async function runQuestionnaire(
  params: AskUserInput,
  drive: (component: InteractiveComponent, doneCalls: () => number) => void,
) {
  let execute: AskUserExecute | undefined;
  const pi = {
    registerTool(definition: { name: string; execute: AskUserExecute }) {
      if (definition.name === "ask_user") execute = definition.execute;
    },
  } as unknown as ExtensionAPI;
  askUser(pi);
  assert.ok(execute);

  const ctx = {
    mode: "tui",
    ui: {
      custom: async (
        factory: (
          tui: { requestRender(): void },
          theme: typeof identityTheme,
          keybindings: object,
          done: (value: AskUserAnswer[] | null) => void,
        ) => InteractiveComponent,
      ) =>
        new Promise<AskUserAnswer[] | null>((resolve) => {
          let calls = 0;
          const component = factory(
            { requestRender() {} },
            identityTheme,
            {},
            (value) => {
              calls++;
              resolve(value);
            },
          );
          drive(component, () => calls);
        }),
    },
  } as unknown as ExtensionContext;

  return execute("ask-1", params, new AbortController().signal, undefined, ctx);
}

test("option labels with the same terminal-safe display identity are rejected before UI", async () => {
  let uiOpened = false;
  await assert.rejects(
    runQuestionnaire(
      {
        questions: [
          {
            id: "database",
            header: "Database",
            question: "Which database?",
            options: [
              { label: "Café", description: "Composed Unicode" },
              {
                label: "  \u001b[31mCafe\u200d\u0301\u001b[0m\n",
                description:
                  "Joiner blocks composition until identity normalization",
              },
            ],
          },
        ],
      },
      () => {
        uiOpened = true;
        throw new Error("UI must not open for ambiguous option labels");
      },
    ),
    /question "database" option labels must be unique/,
  );
  assert.equal(uiOpened, false);
});

test("visibly distinct option labels remain valid", async () => {
  const result = await runQuestionnaire(
    {
      questions: [
        {
          id: "accent",
          header: "Accent",
          question: "Which spelling?",
          options: [
            { label: "Café", description: "Accented spelling" },
            { label: "Cafe", description: "Plain spelling" },
          ],
        },
      ],
    },
    (component) => {
      component.handleInput(input.enter);
      component.handleInput(input.enter);
    },
  );
  assert.deepEqual(result.details.answers, [
    { id: "accent", selected: "Café" },
  ]);
});

const reviewQuestions = {
  questions: [
    {
      id: "db",
      header: "Database",
      question: "Which database?",
      options: [
        { label: "Postgres", description: "Production database" },
        { label: "SQLite", description: "Local database" },
      ],
    },
    {
      id: "region",
      header: "Region",
      question: "Which region?",
      options: [
        { label: "Singapore", description: "Asia Pacific" },
        { label: "Frankfurt", description: "Europe" },
      ],
    },
  ],
} satisfies AskUserInput;

test("questionnaire rendering strips controls and wraps long CJK text without dropping it", async () => {
  const payload = "\u001b]52;c;hidden\u0007";
  const cjk = "界".repeat(40);
  let questionScreen = "";
  let reviewScreen = "";
  await runQuestionnaire(
    {
      questions: [
        {
          id: "safe",
          header: `Header${payload}`,
          question: `${cjk}${payload}`,
          options: [
            {
              label: `First${payload}`,
              description: `Description${payload}`,
            },
            { label: "Second", description: "Fallback" },
          ],
        },
      ],
    },
    (component) => {
      questionScreen = component.render(20).join("\n");
      component.handleInput(input.enter);
      reviewScreen = component.render(40).join("\n");
      component.handleInput(input.enter);
    },
  );

  assert.doesNotMatch(questionScreen, /\u001b\]52|hidden/);
  assert.equal(questionScreen.match(/界/g)?.length, 40);
  assert.doesNotMatch(reviewScreen, /\u001b\]52|hidden/);
});

test("answers stay draft until review, where any question can be revised", async () => {
  const result = await runQuestionnaire(
    reviewQuestions,
    (component, doneCalls) => {
      component.handleInput(input.enter); // Postgres
      component.handleInput(input.down);
      component.handleInput(input.enter); // Frankfurt

      const firstReview = stripVTControlCharacters(
        component.render(100).join("\n"),
      );
      assert.match(firstReview, /Review answers/);
      assert.match(firstReview, /Database — Postgres/);
      assert.match(firstReview, /Region — Frankfurt/);
      assert.equal(doneCalls(), 0, "draft answers must not auto-submit");

      component.handleInput(input.up); // submit -> Region
      component.handleInput(input.enter); // reopen Region
      component.handleInput(input.up); // Frankfurt -> Singapore
      component.handleInput(input.enter); // save revised draft -> review
      assert.equal(doneCalls(), 0);
      component.handleInput(input.enter); // explicit Submit answers
    },
  );

  assert.equal(result.details.cancelled, false);
  assert.deepEqual(result.details.answers, [
    { id: "db", selected: "Postgres" },
    { id: "region", selected: "Singapore" },
  ]);
});

test("free-form text survives leaving and reopening its draft editor", async () => {
  const result = await runQuestionnaire(
    { questions: [reviewQuestions.questions[0]!] },
    (component, doneCalls) => {
      component.handleInput("3"); // Write my own answer
      for (const character of "draft") component.handleInput(character);
      component.handleInput(input.escape); // preserve draft, return to options
      component.handleInput(input.enter); // reopen Other with the saved draft
      component.handleInput(input.enter); // save answer -> review
      assert.equal(doneCalls(), 0);
      component.handleInput(input.enter); // explicit submit
    },
  );

  assert.deepEqual(result.details.answers, [{ id: "db", custom: "draft" }]);
});

test("an oversized compact paste is rejected without clearing the existing draft", async () => {
  const result = await runQuestionnaire(
    { questions: [reviewQuestions.questions[0]!] },
    (component, doneCalls) => {
      component.handleInput("3"); // Write my own answer
      for (const character of "kept") component.handleInput(character);
      component.handleInput(
        `\u001b[200~${"x".repeat(MAX_ANSWER_DRAFT_UTF8_BYTES + 1)}\u001b[201~`,
      );
      component.handleInput(input.enter); // existing bounded draft -> review
      assert.equal(doneCalls(), 0);
      component.handleInput(input.enter); // explicit submit
    },
  );

  assert.deepEqual(result.details.answers, [{ id: "db", custom: "kept" }]);
});

test("notes survive leaving and reopening their draft editor", async () => {
  const result = await runQuestionnaire(
    { questions: [reviewQuestions.questions[0]!] },
    (component, doneCalls) => {
      component.handleInput(input.tab);
      for (const character of "local tests") component.handleInput(character);
      component.handleInput(input.escape);
      component.handleInput(input.tab);
      component.handleInput(input.enter); // save selected option + note -> review
      assert.equal(doneCalls(), 0);
      component.handleInput(input.enter); // explicit submit
    },
  );

  assert.deepEqual(result.details.answers, [
    { id: "db", selected: "Postgres", note: "local tests" },
  ]);
});

test("dismissing the review returns no draft answers", async () => {
  const result = await runQuestionnaire(
    { questions: [reviewQuestions.questions[0]!] },
    (component) => {
      component.handleInput(input.enter); // answer -> review
      component.handleInput(input.escape); // dismiss all drafts
    },
  );

  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.answers, []);
});
