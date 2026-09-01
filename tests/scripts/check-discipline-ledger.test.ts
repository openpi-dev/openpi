import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error The checker is a JavaScript module without declarations.
import { assertLedger } from "../../scripts/check-discipline-ledger.mjs";

test("append-only ledger rejects deleted and renumbered historical rows", () => {
  const ledgerSource = readFileSync("docs/disciplines.md", "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\|\s*OP-05\b/.test(line))
    .map((line) =>
      line.replace(/^\|\s*OP-(0[6-9]|1[0-2])\b/, (_, id) => {
        return `| OP-${String(Number(id) - 1).padStart(2, "0")}`;
      }),
    )
    .join("\n");

  assert.throws(
    () =>
      assertLedger({
        ledgerSource,
        packageSource: readFileSync("package.json", "utf8"),
        workflowSource: readFileSync(".github/workflows/ci.yml", "utf8"),
      }),
    /OP-05/,
  );
});
