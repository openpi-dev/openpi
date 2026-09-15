import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const SHARED_DIR = join(import.meta.dirname, "../../../extensions/shared");
const FEATURE_IMPORT =
  /from\s+["'](?:\.\.\/(?!shared\/)[A-Za-z0-9._-]+|.*extensions\/(?!shared\/))/u;

test("shared modules do not import feature extension implementations", async () => {
  const files = (await readdir(SHARED_DIR)).filter((name) =>
    name.endsWith(".ts"),
  );
  assert.ok(files.includes("search-output.ts"));
  assert.ok(files.includes("search-process.ts"));
  const offenders: string[] = [];
  for (const name of files) {
    const source = await readFile(join(SHARED_DIR, name), "utf8");
    if (FEATURE_IMPORT.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
