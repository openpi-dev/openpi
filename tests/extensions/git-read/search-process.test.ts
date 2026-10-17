import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { formatCapturedOutput } from "../../../extensions/git-read/src/output.ts";
import { executeSearchProcess } from "../../../extensions/git-read/src/search-process.ts";

test("oversized output stops at the capture cap and removes the partial artifact", async () => {
  const prefix = `pi-git-cap-${randomUUID()}-`;
  const result = await Effect.runPromise(
    executeSearchProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)',
      ],
      cwd: process.cwd(),
      tempPrefix: prefix,
      maxCaptureBytes: 1024,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const formatted = formatCapturedOutput(result.output);

  assert.equal(result.output.captureLimitExceeded, true);
  assert.equal(result.output.captureLimitBytes, 1024);
  assert.equal(result.output.totalBytes, 1024);
  assert.equal(result.output.preview, "x".repeat(1024));
  assert.equal(result.output.fullOutputPath, undefined);
  assert.equal(formatted.truncated, true);
  assert.match(
    formatted.text,
    /exceeded the 1\.0KB complete-output capture limit/,
  );
  assert.match(formatted.text, /partial temporary artifact was removed/);

  const leftovers = readdirSync(tmpdir()).filter((entry) =>
    entry.startsWith(prefix),
  );
  assert.deepEqual(leftovers, []);
});
