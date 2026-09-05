import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistResultArtifact,
  projectResult,
} from "../../../extensions/subagents/src/result-artifact.ts";

test("short results pass through without creating an artifact", () => {
  let writes = 0;
  const result = projectResult("short report", {
    maxBytes: 100,
    maxLines: 10,
    writeArtifact: () => {
      writes++;
      return "/unused";
    },
  });

  assert.deepEqual(result, { text: "short report", truncated: false });
  assert.equal(writes, 0);
});

test("byte truncation keeps head and tail and points to the exact artifact", () => {
  const content = `BEGIN\n${"middle-data\n".repeat(40)}FINAL-VERDICT`;
  let persisted = "";
  const result = projectResult(content, {
    maxBytes: 120,
    maxLines: 100,
    writeArtifact: (value) => {
      persisted = value;
      return "/tmp/final.txt";
    },
  });

  assert.equal(result.truncated, true);
  assert.equal(result.artifactPath, "/tmp/final.txt");
  assert.equal(persisted, content);
  assert.match(result.text, /^BEGIN/);
  assert.match(result.text, /FINAL-VERDICT/);
  assert.match(result.text, /\[\.\.\. middle omitted \.\.\.\]/);
  assert.match(result.text, /Full final answer: "\/tmp\/final\.txt"/);
  assert.match(result.text, /offset=\d+, limit=200/);
  assert.match(result.text, /\d+ total lines/);
});

test("the complete projection stays within its byte budget", () => {
  const content = `BEGIN\n${"middle-data\n".repeat(400)}FINAL-VERDICT`;
  const result = projectResult(content, {
    maxBytes: 512,
    maxLines: 100,
    writeArtifact: () => "/tmp/final.txt",
  });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 512);
  assert.match(result.text, /^BEGIN/);
  assert.match(result.text, /FINAL-VERDICT/);
  assert.match(result.text, /Full final answer:/);
});

test("projection budgets remain hard caps across UTF-8 sizes", () => {
  const content = `开头\n${"中间证据-abcdef\n".repeat(1000)}最终结论`;
  for (const maxBytes of [512, 768, 1024, 2048, 16 * 1024]) {
    const result = projectResult(content, {
      maxBytes,
      maxLines: 600,
      writeArtifact: () => "/tmp/final.txt",
    });
    assert.ok(
      Buffer.byteLength(result.text, "utf8") <= maxBytes,
      `projection exceeded ${maxBytes} bytes`,
    );
    assert.match(result.text, /^开头/);
    assert.match(result.text, /最终结论/);
  }
});

test("line truncation keeps both ends even below the byte ceiling", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
  const result = projectResult(content, {
    maxBytes: 10_000,
    maxLines: 8,
    writeArtifact: () => "/tmp/lines.txt",
  });

  assert.equal(result.truncated, true);
  assert.match(result.text, /^line-0/);
  assert.match(result.text, /line-19/);
});

test("a long UTF-8 line keeps valid characters at both ends", () => {
  const content = `开头-${"中".repeat(100)}-结尾`;
  const result = projectResult(content, {
    maxBytes: 80,
    maxLines: 10,
    writeArtifact: () => "/tmp/chinese.txt",
  });

  assert.equal(result.truncated, true);
  assert.match(result.text, /^开头-/);
  assert.match(result.text, /-结尾/);
  assert.doesNotMatch(result.text, /�/);
});

test("artifact failure is explicit and never advertises a false path", () => {
  const result = projectResult("start\n" + "x\n".repeat(100) + "end", {
    maxBytes: 80,
    maxLines: 10,
    writeArtifact: () => {
      throw new Error("disk full");
    },
  });

  assert.equal(result.truncated, true);
  assert.equal(result.artifactPath, undefined);
  assert.equal(result.artifactSaveFailed, true);
  assert.match(result.text, /could not be saved/);
  assert.doesNotMatch(result.text, /Full final answer:/);
});

test("content-addressed artifacts are exact, private, and reusable", async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-artifact-"),
  );
  try {
    const content = "complete final answer\nwith verdict";
    const first = persistResultArtifact(agentDir, content);
    const second = persistResultArtifact(agentDir, content);

    assert.equal(first, second);
    assert.equal(await readFile(first, "utf8"), content);
    if (process.platform !== "win32") {
      assert.equal((await lstat(first)).mode & 0o777, 0o600);
    }
    assert.equal(path.basename(first).length, 68);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("artifact persistence refuses a symlinked cache component", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "openpi-result-symlink-"));
  const outside = await mkdtemp(path.join(tmpdir(), "openpi-result-outside-"));
  try {
    await symlink(
      outside,
      path.join(agentDir, "cache"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => persistResultArtifact(agentDir, "do not write outside"),
      /Unsafe result artifact directory/,
    );
    assert.deepEqual(
      await readFile(path.join(outside, "sentinel"), "utf8").catch(
        () => undefined,
      ),
      undefined,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("artifact persistence refuses an existing file with the wrong content", async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-collision-"),
  );
  try {
    const content = "original final answer";
    const artifactPath = persistResultArtifact(agentDir, content);
    await writeFile(artifactPath, "tampered", "utf8");
    assert.throws(
      () => persistResultArtifact(agentDir, content),
      /Result artifact collision/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
