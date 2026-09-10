import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceWriteTool } from "../../web/runtime/write-evidence.ts";
import { projectMessage } from "../../web/protocol/types.ts";
import { projectToolEvidence } from "../../web/protocol/evidence.ts";

test("write never discloses previous contents or invents change evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-write-evidence-"));
  try {
    const path = join(cwd, "report.txt");
    await writeFile(path, "private old contents");
    const tool = createEvidenceWriteTool(cwd);
    for (const content of ["replacement", "replacement", ""]) {
      const result = await tool.execute(
        "write",
        { path, content },
        undefined,
        undefined,
        undefined!,
      );
      assert.equal(await readFile(path, "utf8"), content);
      assert.ok(result.details?.evidenceUnavailable);
      assert.doesNotMatch(JSON.stringify(result), /private old contents/);
      const view = projectToolEvidence(
        {
          type: "toolCall",
          name: "write",
          arguments: JSON.stringify({ path }),
        },
        projectMessage({ ...result, isError: false }),
      );
      assert.equal(view.diff, undefined);
      assert.equal(view.change, undefined);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounded evidence does not block large, binary or unreadable comparisons; native failure and cancellation survive", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-write-evidence-"));
  try {
    const tool = createEvidenceWriteTool(cwd);
    const path = join(cwd, "report.txt");
    const run = (content: string, signal?: AbortSignal) =>
      tool.execute("write", { path, content }, signal, undefined, undefined!);
    const large = "x".repeat(40_000);
    assert.ok((await run(large)).details?.evidenceUnavailable);
    assert.equal(await readFile(path, "utf8"), large);
    assert.ok((await run("small")).details?.evidenceUnavailable);
    await writeFile(path, Buffer.from([0xff, 0x00]));
    assert.ok((await run("text")).details?.evidenceUnavailable);
    await assert.rejects(run("cancelled", AbortSignal.abort()), /aborted/);
    assert.equal(await readFile(path, "utf8"), "text");
    await rm(path);
    await mkdir(path);
    await assert.rejects(run("failure"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent writes retain native queue behavior without old contents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-write-evidence-"));
  try {
    const path = join(cwd, "report.txt");
    const tool = createEvidenceWriteTool(cwd);
    const results = await Promise.all(
      ["first", "second"].map((content) =>
        tool.execute(
          content,
          { path, content },
          undefined,
          undefined,
          undefined!,
        ),
      ),
    );
    assert.equal(await readFile(path, "utf8"), "second");
    for (const result of results)
      assert.ok(result.details?.evidenceUnavailable);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
