import assert from "node:assert/strict";
import test from "node:test";
import {
  foldUserMessage,
  transformUserMarkdown,
} from "../../../extensions/user-input-fold/index.ts";

const MARKER = "… folded";

const numberedLines = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `line ${String(i + 1).padStart(2, "0")}`,
  );

const giantBlock = [
  "```js",
  ...Array.from({ length: 300 }, (_, i) => `console.log(${i});`),
  "```",
].join("\n");

test("messages below both thresholds round-trip byte-identical", () => {
  const messages = [
    "hi",
    "hello\n",
    "a\r\nb",
    "  spaced  \n\n",
    "explanation\n```js\nfoo();\nbar();\n```\ndone",
    "x".repeat(1200),
    numberedLines(20).join("\n"),
  ];
  for (const message of messages) {
    assert.equal(foldUserMessage(message), message);
  }
});

test("a message at exactly the line threshold is unchanged", () => {
  const message = numberedLines(20).join("\n");
  assert.equal(foldUserMessage(message), message);
});

test("one line over the line threshold folds to a twelve-line preview", () => {
  const message = numberedLines(21).join("\n");
  const out = foldUserMessage(message);
  assert.ok(out.startsWith("line 01"));
  assert.ok(out.includes("line 12"));
  assert.ok(!out.includes("line 13"));
  assert.equal(out.split("\n").length, 13); // 12 preview lines + marker
  assert.ok(
    out.endsWith("… folded 9 lines · full content was sent to the model"),
  );
});

test("a message at exactly the character threshold is unchanged", () => {
  const message = "x".repeat(1200);
  assert.equal(foldUserMessage(message), message);
});

test("one char over the char threshold with one line to hide is left alone", () => {
  // Over the character threshold, but the fold would hide a single (mid-cut)
  // line — far below the minimum-benefit gate, so it renders in full.
  const message = "x".repeat(1201);
  assert.equal(foldUserMessage(message), message);
});

test("long wrapped lines fold by character count, not just line count", () => {
  // 20 lines of 61 chars: at the line threshold but 1239 chars overall.
  const message = Array.from({ length: 20 }, () => "y".repeat(61)).join("\n");
  const out = foldUserMessage(message);
  assert.equal(out.split("\n").length, 13);
  assert.ok(
    out.endsWith("… folded 8 lines · full content was sent to the model"),
  );
});

test("a char-heavy message with only a few foldable lines stays unchanged", () => {
  // Like the /openpi-setup prompt: short config-recap lines plus one very
  // long guidance line. Over the char threshold, but the fold would only
  // hide a handful of lines the user is meant to read.
  const shortLines = Array.from(
    { length: 15 },
    (_, i) => `config line ${i}: ${"c".repeat(20)}`,
  );
  const message = [
    "Configure the installed OpenPI package according to this request:",
    ...shortLines,
    "g".repeat(700),
  ].join("\n");
  assert.ok(message.length > 1200);
  assert.ok(message.split("\n").length <= 20);
  assert.equal(foldUserMessage(message), message);
});

test("folding must hide at least 8 lines to earn its keep", () => {
  // 19 lines of 70 chars: char-triggered (1348 chars), fold would hide 7.
  const sevenHidden = Array.from({ length: 19 }, () => "z".repeat(70)).join(
    "\n",
  );
  assert.ok(sevenHidden.length > 1200);
  assert.equal(foldUserMessage(sevenHidden), sevenHidden);

  // 20 lines of 70 chars: char-triggered (1419 chars), fold hides exactly 8.
  const eightHidden = `${sevenHidden}\n${"z".repeat(70)}`;
  const out = foldUserMessage(eightHidden);
  assert.equal(out.split("\n").length, 13);
  assert.ok(
    out.endsWith("… folded 8 lines · full content was sent to the model"),
  );
});

test("a single giant fenced block folds to its first content lines", () => {
  const out = foldUserMessage(giantBlock);
  assert.ok(out.startsWith("```js"));
  assert.ok(out.includes("console.log(3);"));
  assert.ok(!out.includes("console.log(4);"));
  assert.equal(out.split("\n").length, 8); // fence + 4 lines + … + fence + marker
  assert.ok(
    out.endsWith("… folded 296 lines · full content was sent to the model"),
  );
});

test("multiple fenced blocks fold per block while prose shares one budget", () => {
  const message = [
    "intro prose",
    "```js",
    ...Array.from({ length: 10 }, (_, i) => `js-${i};`),
    "```",
    "middle prose",
    "```py",
    ...Array.from({ length: 10 }, (_, i) => `py-${i}`),
    "```",
    "tail prose",
  ].join("\n");
  const out = foldUserMessage(message);
  assert.ok(out.includes("intro prose"));
  assert.ok(out.includes("js-3;"));
  assert.ok(!out.includes("js-4;"));
  assert.ok(out.includes("middle prose"));
  assert.ok(out.includes("py-3"));
  assert.ok(!out.includes("py-4"));
  assert.ok(out.includes("tail prose"));
  assert.ok(
    out.endsWith("… folded 12 lines · full content was sent to the model"),
  );
});

test("CRLF messages fold without losing their line endings", () => {
  const message = Array.from(
    { length: 21 },
    (_, i) => `row ${String(i).padStart(2, "0")}`,
  ).join("\r\n");
  const out = foldUserMessage(message);
  assert.ok(out.includes("row 00\r"));
  assert.ok(out.includes("row 11\r"));
  assert.ok(!out.includes("row 12"));
  assert.ok(
    out.endsWith("… folded 9 lines · full content was sent to the model"),
  );
});

test("LF and CRLF fenced messages fold with the same semantics", () => {
  const lf = [
    "intro",
    "```js",
    ...Array.from({ length: 30 }, (_, i) => `console.log(${i});`),
    "```",
    "outro",
  ].join("\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  const normalizeNewlines = (text: string) => text.replaceAll("\r\n", "\n");

  assert.equal(normalizeNewlines(foldUserMessage(crlf)), foldUserMessage(lf));
  assert.ok(foldUserMessage(crlf).includes("```\r\n"));
});

test("trailing newlines neither fold short messages nor pad the count", () => {
  assert.equal(foldUserMessage("hello\n"), "hello\n");
  assert.equal(foldUserMessage("hello\n\n"), "hello\n\n");
  const withTrailing = `${numberedLines(21).join("\n")}\n`;
  assert.ok(
    foldUserMessage(withTrailing).endsWith(
      "… folded 9 lines · full content was sent to the model",
    ),
  );
});

test("a fenced message under the thresholds is not folded at all", () => {
  const message = "explanation\n```js\nfoo();\nbar();\n```\ndone";
  assert.equal(foldUserMessage(message), message);
});

test("empty and whitespace-only messages are left alone", () => {
  for (const message of ["", " ", "\n", "\t", "  \n  \n"]) {
    assert.equal(foldUserMessage(message), message);
  }
});

test("an unterminated fence folds as a code block with a synthesized close", () => {
  const message = [
    "```js",
    ...Array.from({ length: 30 }, (_, i) => `stmt ${i};`),
  ].join("\n");
  const out = foldUserMessage(message);
  assert.ok(out.startsWith("```js"));
  assert.ok(out.includes("stmt 3;"));
  assert.ok(!out.includes("stmt 4;"));
  // The synthesized closing fence keeps the folded preview balanced Markdown.
  assert.ok(out.includes("…\n```"));
  assert.ok(
    out.endsWith("… folded 25 lines · full content was sent to the model"),
  );
});

test("a nested ``` block does not close a ```` block (CommonMark §4.5)", () => {
  const message = [
    "Please review this prompt template:",
    "````markdown",
    "Here is an example snippet:",
    "```javascript",
    "function hello() {",
    '  console.log("Hello world");',
    "}",
    "```",
    "Follow the instructions above carefully.",
    ...Array.from({ length: 15 }, (_, i) => `${i + 1}. Step ${i + 1}`),
    "````",
    "End of message.",
  ].join("\n");
  const out = foldUserMessage(message);
  assert.ok(
    out.startsWith("Please review this prompt template:\n````markdown"),
  );
  // Content after the inner ``` fence stays inside the outer block.
  assert.ok(!out.includes("Follow the instructions"));
  assert.ok(!out.includes("Step 1"));
  // The outer block is closed by its matching four-backtick fence.
  assert.ok(out.includes("…\n````\nEnd of message."));
  assert.ok(
    out.endsWith("… folded 18 lines · full content was sent to the model"),
  );
});

test("a longer closing fence closes a shorter opening fence", () => {
  const message = ["~~~", ...numberedLines(30), "~~~~~~"].join("\n");
  const out = foldUserMessage(message);
  assert.ok(out.startsWith("~~~\nline 01"));
  assert.ok(out.includes("…\n~~~~~~"));
  assert.ok(
    out.endsWith("… folded 26 lines · full content was sent to the model"),
  );
});

test("tilde fences are recognized and fold like backtick fences", () => {
  const message = [
    "intro",
    "~~~py",
    ...Array.from({ length: 30 }, (_, i) => `py-${i}`),
    "~~~",
    "outro",
  ].join("\n");
  const out = foldUserMessage(message);
  assert.ok(out.startsWith("intro\n~~~py"));
  assert.ok(out.includes("py-3"));
  assert.ok(!out.includes("py-4"));
  assert.ok(out.includes("…\n~~~\noutro"));
  assert.ok(
    out.endsWith("… folded 26 lines · full content was sent to the model"),
  );
});

test("backtick and tilde fences never close each other", () => {
  const message = [
    "~~~text",
    "```",
    ...numberedLines(30),
    "```",
    "~~~",
    "tail",
  ].join("\n");
  const out = foldUserMessage(message);
  // The inner ``` lines are content of the tilde block, not its closer.
  assert.ok(out.startsWith("~~~text\n```\nline 01"));
  assert.ok(out.includes("…\n~~~\ntail"));
  assert.ok(
    out.endsWith("… folded 28 lines · full content was sent to the model"),
  );
});

test("many individually short code blocks share one bounded preview budget", () => {
  const block = ["```", "a", "b", "c", "d", "```"].join("\n");
  const message = Array.from({ length: 5 }, () => block).join("\n");
  const out = foldUserMessage(message);
  assert.notEqual(out, message);
  assert.ok(out.split("\n").length <= 21);
  assert.equal((out.match(/```/g) ?? []).length % 2, 0);
  assert.ok(
    out.endsWith("… folded 12 lines · full content was sent to the model"),
  );
});

test("many truncated code blocks cannot make the folded output longer than the input", () => {
  const block = ["```js", "a", "b", "c", "d", "e", "```"].join("\n");
  const message = Array.from({ length: 100 }, () => block).join("\n");
  const out = foldUserMessage(message);
  assert.equal(message.split("\n").length, 700);
  assert.ok(out.split("\n").length <= 21);
  assert.ok(out.length < message.length);
  assert.equal((out.match(/```/g) ?? []).length % 2, 0);
  assert.ok(
    out.endsWith("… folded 683 lines · full content was sent to the model"),
  );
});

test("folding is pure: the input is untouched and repeat calls agree", () => {
  const snapshot = giantBlock;
  const first = foldUserMessage(giantBlock);
  const second = foldUserMessage(giantBlock);
  assert.equal(giantBlock, snapshot); // no mutation of the input
  assert.equal(first, second); // deterministic
  assert.notEqual(first, giantBlock); // but something was folded
  assert.ok(first.length < giantBlock.length);
});

test("the transformer only folds finalized user messages", () => {
  const message = numberedLines(21).join("\n");
  assert.notEqual(
    transformUserMarkdown(message, { messageType: "user", isStreaming: false }),
    message,
  );
  const untouched = [
    { messageType: "assistant", isStreaming: false },
    { messageType: "assistant-thinking", isStreaming: false },
    { messageType: "assistant", isStreaming: true },
    { messageType: "user", isStreaming: true },
  ];
  for (const context of untouched) {
    assert.equal(transformUserMarkdown(message, context), message);
  }
});

test("the marker always states that the model received the full content", () => {
  const out = foldUserMessage(giantBlock);
  assert.ok(out.includes(MARKER));
  assert.ok(out.includes("full content was sent to the model"));
});
