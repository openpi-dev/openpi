import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const entrypoint = new URL("../../bin/openpi.js", import.meta.url);
const entrypointPath = fileURLToPath(entrypoint);

test("openpi is an executable standalone Web entrypoint", async () => {
  const info = await stat(entrypoint);
  assert.notEqual(info.mode & 0o100, 0);

  const { stdout } = await execFileAsync(process.execPath, [
    entrypointPath,
    "--help",
  ]);
  assert.match(stdout, /Usage:\s+openpi web \[workspace\]/u);
  assert.match(stdout, /never enter an interactive terminal Pi session/u);
});
