import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "vite";
import { webBuildInfoPlugin } from "../../scripts/web-build-info.ts";

test("production page identity matches its manifest, is reproducible, and changes with content", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-build-info-"));
  try {
    const entry = join(root, "entry.js");
    await writeFile(entry, "console.log(__OPENPI_WEB_BUILD__);");
    const compile = async () => {
      const result = await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [webBuildInfoPlugin("1.2.3")],
        build: { write: false, minify: false, rollupOptions: { input: entry } },
      });
      if ("on" in result || Array.isArray(result))
        throw new Error("Expected one build");
      const manifest = result.output.find(
        (item) => item.fileName === "build-info.json",
      );
      assert.equal(manifest?.type, "asset");
      if (manifest?.type !== "asset") throw new Error("Missing manifest");
      const info = JSON.parse(String(manifest.source));
      assert.match(info.id, /^[a-f0-9]{64}$/u);
      assert.equal(info.version, "1.2.3");
      const code = result.output
        .filter((item) => item.type === "chunk")
        .map((item) => item.code)
        .join("\n");
      assert.ok(code.includes(info.id));
      assert.ok(!code.includes("__OPENPI_WEB_BUILD_ID_PLACEHOLDER__"));
      return info;
    };
    const first = await compile();
    assert.deepEqual(await compile(), first);
    await writeFile(entry, "console.log('changed', __OPENPI_WEB_BUILD__);");
    assert.notEqual((await compile()).id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
