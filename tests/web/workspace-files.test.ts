import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactReader } from "../../web/host/artifacts.ts";
import { ARTIFACT_PREVIEW_BYTES } from "../../web/protocol/artifacts.ts";
import { parseDelimited } from "../../web/ui/src/features/files/preview-data.ts";

test("workspace pages reach every file, bind search and Session identity, and revoke cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-file-pages-"));
  let scope = { sessionId: "s", sessionPath: "/sessions/a", cwd: root };
  const reader = new ArtifactReader(() => scope);
  try {
    await mkdir(join(root, "nested"));
    await Promise.all(
      Array.from({ length: 270 }, (_, index) =>
        writeFile(join(root, `file-${index}.txt`), String(index)),
      ),
    );
    await writeFile(join(root, "nested", "file-child.txt"), "child");
    const first = await reader.listFiles("s", ".", "", scope.sessionPath);
    assert.equal(first.entries.length, 250);
    assert.ok(first.nextCursor);
    await assert.rejects(
      reader.listFiles(
        "s",
        ".",
        "different",
        scope.sessionPath,
        first.nextCursor,
      ),
      /expired/u,
    );
    const second = await reader.listFiles(
      "s",
      ".",
      "",
      scope.sessionPath,
      first.nextCursor,
    );
    assert.equal(second.entries.length, 21);
    assert.equal(second.nextCursor, undefined);
    assert.equal(
      new Set([...first.entries, ...second.entries].map((entry) => entry.path))
        .size,
      271,
    );
    await assert.rejects(
      reader.listFiles("s", ".", "", scope.sessionPath, first.nextCursor),
      /expired/u,
    );
    const matches: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.listFiles(
        "s",
        ".",
        "FILE-",
        scope.sessionPath,
        cursor,
      );
      matches.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(matches.length, 271);
    assert.ok(matches.includes("nested/file-child.txt"));
    const retained = await reader.listFiles("s", ".", "", scope.sessionPath);
    scope = { ...scope, sessionPath: "/sessions/copied" };
    await assert.rejects(
      reader.listFiles("s", ".", "", "/sessions/a"),
      /outside/u,
    );
    await assert.rejects(
      reader.listFiles("s", ".", "", scope.sessionPath, retained.nextCursor),
      /expired/u,
    );
    await assert.rejects(reader.listFiles("other", "."), /outside/u);
    await assert.rejects(reader.listFiles("s", "../"), /outside/u);
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("directory changes invalidate continuation, links stay visible without granting their target", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-file-boundary-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd: root }));
  try {
    await mkdir(join(root, "safe"));
    if (process.platform !== "win32")
      await symlink(tmpdir(), join(root, "outside"));
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        writeFile(join(root, `${index}.txt`), "data"),
      ),
    );
    const first = await reader.listFiles("s");
    await writeFile(join(root, "new-file.txt"), "new");
    await assert.rejects(
      reader.listFiles("s", ".", "", undefined, first.nextCursor),
      /Directory changed/u,
    );
    if (process.platform !== "win32") {
      await assert.rejects(reader.listFiles("s", "outside"), /outside/u);
      const search = await reader.listFiles("s", ".", "outside");
      assert.deepEqual(
        search.entries.map((entry) => entry.kind),
        ["symlink"],
      );
    }
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("text continuation preserves UTF-8 and line boundaries and rejects mixed revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-file-continuation-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd: root }));
  try {
    const source =
      "x".repeat(ARTIFACT_PREVIEW_BYTES - 1) +
      "中文\n" +
      "row\n".repeat(10_100);
    await writeFile(join(root, "readme.txt"), source);
    const handle = await reader.resolveFile("s", "readme.txt");
    let page = (await reader.read(handle, "s")).preview;
    const revision = page.artifact.revision;
    let text = page.text ?? "";
    let pages = 1;
    while (page.nextOffset !== undefined) {
      page = (await reader.read(handle, "s", revision, page.nextOffset))
        .preview;
      text += page.text ?? "";
      pages++;
    }
    assert.equal(text, source);
    assert.ok(pages > 2);
    await writeFile(join(root, "readme.txt"), "changed");
    await assert.rejects(
      reader.read(handle, "s", revision, 1),
      /newer version/u,
    );
    await assert.rejects(reader.read(handle, "s", undefined, 1), /outside/u);
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("CSV and TSV previews retain quoted separators, multiline cells and escaped quotes", () => {
  assert.deepEqual(
    parseDelimited('name,note\r\n"A, B","line 1\nline ""2"""\r\n', ",").rows,
    [
      ["name", "note"],
      ["A, B", 'line 1\nline "2"'],
    ],
  );
  assert.deepEqual(parseDelimited("name\tvalue\nA\t=1+1", "\t").rows, [
    ["name", "value"],
    ["A", "=1+1"],
  ]);
});
