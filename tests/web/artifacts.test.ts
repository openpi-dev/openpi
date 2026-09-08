import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactError, ArtifactReader } from "../../web/host/artifacts.ts";
import { ARTIFACT_MAX_BYTES } from "../../web/protocol/artifacts.ts";

function code(value: string) {
  return (error: unknown) =>
    error instanceof ArtifactError && error.code === value;
}

test("artifact reads bind Session, canonical file, content revision and explicit release", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-artifacts-"));
  let sessionId = "session";
  const reader = new ArtifactReader(() => ({ sessionId, cwd: root }));
  try {
    const path = join(root, "report space.md");
    await writeFile(path, "# revision one");
    const handle = await reader.resolveFile(sessionId, "./report%20space.md");
    const first = await reader.read(handle, sessionId);
    assert.equal(first.preview.text, "# revision one");
    assert.equal(first.preview.artifact.path, path);
    assert.equal(
      first.preview.artifact.revision,
      createHash("sha256").update(first.bytes).digest("hex"),
    );
    await writeFile(path, "# revision two");
    await assert.rejects(
      reader.read(handle, sessionId, first.preview.artifact.revision),
      code("ARTIFACT_CHANGED"),
    );
    const next = await reader.read(handle, sessionId);
    assert.equal(next.preview.text, "# revision two");
    assert.notEqual(
      next.preview.artifact.revision,
      first.preview.artifact.revision,
    );
    await assert.rejects(
      reader.read(handle, "other"),
      code("ARTIFACT_EXPIRED"),
    );
    reader.release(handle, sessionId);
    await assert.rejects(
      reader.read(handle, sessionId),
      code("ARTIFACT_EXPIRED"),
    );
    const old = await reader.resolveFile(sessionId, path);
    sessionId = "new";
    await assert.rejects(reader.read(old, "session"), code("ARTIFACT_EXPIRED"));
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact paths reject traversal, encodings, junctions, directories and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-artifacts-boundary-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "private");
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd: workspace }));
  try {
    for (const path of [
      "../outside/secret.md",
      "%2e%2e/outside/secret.md",
      join(outside, "secret.md"),
      "\\\\server\\share",
      "report.md:stream",
      "%00",
      "%XX",
    ])
      await assert.rejects(
        reader.resolveFile("s", path),
        code("ARTIFACT_DENIED"),
      );
    await symlink(
      outside,
      join(workspace, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      reader.resolveFile("s", "link/secret.md"),
      code("ARTIFACT_DENIED"),
    );
    await assert.rejects(
      reader.resolveFile("s", "missing.md"),
      code("ARTIFACT_MISSING"),
    );
    await mkdir(join(workspace, "directory"));
    const directory = await reader.resolveFile("s", "directory");
    await assert.rejects(
      reader.read(directory, "s"),
      code("ARTIFACT_UNSUPPORTED"),
    );
    await assert.rejects(
      reader.resolveFile("other", "missing.md"),
      code("ARTIFACT_DENIED"),
    );
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact previews bound content and resolve nested references without widening grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-artifacts-preview-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd: root }));
  try {
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "report.md"), "row\n".repeat(8_000));
    await writeFile(join(root, "out", "image.pdf"), Buffer.from([0, 1, 2]));
    const parent = await reader.resolveFile("s", "out/report.md");
    const preview = await reader.read(parent, "s");
    assert.equal(preview.preview.truncated, true);
    assert.ok((preview.preview.text?.split("\n").length ?? 0) <= 5_000);
    const child = await reader.resolveFile("s", "./image.pdf", parent);
    assert.equal(
      (await reader.read(child, "s")).preview.artifact.preview,
      "unsupported",
    );
    await writeFile(
      join(root, "huge.txt"),
      Buffer.alloc(ARTIFACT_MAX_BYTES + 1),
    );
    const huge = await reader.resolveFile("s", "huge.txt");
    await assert.rejects(reader.read(huge, "s"), code("ARTIFACT_TOO_LARGE"));
    await rm(join(root, "out", "report.md"));
    await assert.rejects(reader.read(parent, "s"), code("ARTIFACT_MISSING"));
    reader.dispose();
    await assert.rejects(reader.read(child, "s"), code("ARTIFACT_DENIED"));
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
