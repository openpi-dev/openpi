import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactReader } from "../../web/host/artifacts.ts";
import { ARTIFACT_EDIT_BYTES } from "../../web/protocol/artifacts.ts";

test("file saves preserve UTF-8, line endings and permissions and reject stale or overlapping saves", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-file-save-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd }));
  try {
    const path = join(cwd, "script.sh");
    await writeFile(path, "echo before\r\n");
    await chmod(path, 0o750);
    const handle = await reader.resolveFile("s", "script.sh");
    const original = await reader.read(handle, "s");
    const revision = original.preview.artifact.revision;
    assert.equal(original.preview.artifact.editable, true);
    const attempts = await Promise.allSettled([
      reader.save(handle, "s", revision, "echo 文件\r\n"),
      reader.save(handle, "s", revision, "losing write"),
    ]);
    assert.equal(attempts[0].status, "fulfilled");
    assert.equal(attempts[1].status, "rejected");
    assert.equal(await readFile(path, "utf8"), "echo 文件\r\n");
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o750);
    await assert.rejects(reader.save(handle, "s", revision, "old draft"), {
      code: "ARTIFACT_CHANGED",
    });
    const current = await reader.read(handle, "s");
    await writeFile(path, "external edit");
    await assert.rejects(
      reader.save(handle, "s", current.preview.artifact.revision, "draft"),
      { code: "ARTIFACT_CHANGED" },
    );
    assert.equal(await readFile(path, "utf8"), "external edit");
    assert.deepEqual(await readdir(cwd), ["script.sh"]);
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file saves cannot widen external read grants, follow links, write binary, exceed limits, or survive revocation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-file-save-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "openpi-file-save-outside-"));
  let scope = { sessionId: "s", sessionPath: "a", cwd };
  const reader = new ArtifactReader(() => scope);
  try {
    await writeFile(join(outside, "external.txt"), "external");
    const external = await reader.authorizeFile(
      "s",
      join(outside, "external.txt"),
    );
    const externalPreview = await reader.read(external, "s");
    assert.equal(externalPreview.preview.artifact.editable, false);
    await assert.rejects(
      reader.save(
        external,
        "s",
        externalPreview.preview.artifact.revision,
        "overwrite",
      ),
      { code: "ARTIFACT_DENIED" },
    );
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 255]));
    const binary = await reader.resolveFile("s", "binary.dat");
    const binaryPreview = await reader.read(binary, "s");
    await assert.rejects(
      reader.save(
        binary,
        "s",
        binaryPreview.preview.artifact.revision,
        "overwrite",
      ),
      { code: "ARTIFACT_DENIED" },
    );
    await writeFile(join(cwd, "text.txt"), "original");
    const handle = await reader.resolveFile("s", "text.txt");
    const { preview } = await reader.read(handle, "s");
    await assert.rejects(
      reader.save(
        handle,
        "s",
        preview.artifact.revision,
        "a".repeat(ARTIFACT_EDIT_BYTES + 1),
      ),
      { code: "ARTIFACT_TOO_LARGE" },
    );
    await assert.rejects(
      reader.save(handle, "s", preview.artifact.revision, "\0"),
      { code: "ARTIFACT_UNSUPPORTED" },
    );
    if (process.platform !== "win32") {
      await rm(join(cwd, "text.txt"));
      await symlink(join(outside, "external.txt"), join(cwd, "text.txt"));
      await assert.rejects(
        reader.save(handle, "s", preview.artifact.revision, "overwrite"),
        { code: "ARTIFACT_DENIED" },
      );
      assert.equal(
        await readFile(join(outside, "external.txt"), "utf8"),
        "external",
      );
    }
    scope = { ...scope, sessionPath: "another-session-file" };
    await assert.rejects(
      reader.save(handle, "s", preview.artifact.revision, "overwrite"),
      { code: "ARTIFACT_EXPIRED" },
    );
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("revoking access during a save leaves the original file and no staging file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-file-save-revoke-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd }));
  try {
    await writeFile(join(cwd, "text.txt"), "original");
    const handle = await reader.resolveFile("s", "text.txt");
    const { preview } = await reader.read(handle, "s");
    const saving = reader.save(
      handle,
      "s",
      preview.artifact.revision,
      "should not commit",
    );
    reader.revoke();
    await assert.rejects(saving, { code: "ARTIFACT_DENIED" });
    assert.equal(await readFile(join(cwd, "text.txt"), "utf8"), "original");
    assert.deepEqual(await readdir(cwd), ["text.txt"]);
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
