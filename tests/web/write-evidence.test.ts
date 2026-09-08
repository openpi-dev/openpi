import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceWriteTool } from "../../web/runtime/write-evidence.ts";
import { projectMessage } from "../../web/protocol/types.ts";
import { projectToolEvidence } from "../../web/protocol/evidence.ts";

test("write records creation, overwrite and unchanged evidence in canonical results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-write-evidence-"));
  try {
    const tool = createEvidenceWriteTool(cwd);
    const path = join(cwd, "new", "report.txt");
    const run = (content: string) =>
      tool.execute(
        "write",
        { path, content },
        undefined,
        undefined,
        undefined!,
      );
    const created = await run("apple\nbanana\ncherry\n");
    assert.equal(created.details?.change, "created");
    assert.match(created.details?.diff ?? "", /\+1 apple/);
    const overwritten = await run("apple\norange\ncherry\n");
    assert.equal(overwritten.details?.change, "overwritten");
    assert.match(overwritten.details?.diff ?? "", /-2 banana/);
    assert.match(overwritten.details?.diff ?? "", /\+2 orange/);
    assert.equal(await readFile(path, "utf8"), "apple\norange\ncherry\n");
    const unchanged = await run("apple\norange\ncherry\n");
    assert.equal(unchanged.details?.change, "unchanged");
    assert.equal(unchanged.details?.diff, "");
    const call = projectMessage({
      content: [
        { type: "toolCall", id: "write", name: "write", arguments: { path } },
      ],
    }).parts![0];
    assert.equal(call.type, "toolCall");
    if (call.type !== "toolCall") throw new Error("missing call");
    const persisted = JSON.parse(
      JSON.stringify({
        role: "toolResult",
        toolCallId: "write",
        toolName: "write",
        ...overwritten,
        isError: false,
      }),
    );
    assert.equal(
      projectToolEvidence(call, projectMessage(persisted)).diff,
      overwritten.details?.diff,
    );
    await run("");
    assert.equal((await run("")).details?.change, "unchanged");
    const controls = await run("\u001b[31mred\u001b[0m\n");
    assert.match(controls.details?.diff ?? "", /\u001b\[31m/);
    const controlView = projectToolEvidence(
      call,
      projectMessage({ ...controls, isError: false }),
    );
    assert.doesNotMatch(controlView.diff ?? "", /\u001b/);
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

test("concurrent writes capture the previous queued write, not a shared before-image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-write-evidence-"));
  try {
    const tool = createEvidenceWriteTool(cwd);
    const path = join(cwd, "report.txt");
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
    assert.equal(results[0].details?.change, "created");
    assert.equal(results[1].details?.change, "overwritten");
    assert.match(results[1].details?.diff ?? "", /-1 first/);
    assert.match(results[1].details?.diff ?? "", /\+1 second/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
