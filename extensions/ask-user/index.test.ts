import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { formatAnswers, formatPreviewLine } from "./index.ts";
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
