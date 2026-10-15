import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import test from "node:test";
import {
  createWriteTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { ArtifactReader } from "../../web/host/artifacts.ts";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../../web/protocol/prompt-files.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("Web saves wait for the native Pi write lane and recheck its resulting revision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-native-web-save-"));
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd }));
  const entered = barrier();
  const proceed = barrier();
  try {
    await writeFile(join(cwd, "note.txt"), "original");
    const handle = await reader.resolveFile("s", "note.txt");
    const { preview } = await reader.read(handle, "s");
    const native = createWriteTool(cwd, {
      operations: {
        mkdir: async () => {
          entered.release();
          await proceed.promise;
        },
        writeFile: async (path, content) => {
          await writeFile(path, content);
        },
      },
    }).execute("native-write", { path: "note.txt", content: "native update" });
    await entered.promise;
    let reads = 0;
    const read = reader.read.bind(reader);
    reader.read = async (...args) => {
      reads++;
      return read(...args);
    };
    const saving = reader.save(
      handle,
      "s",
      preview.artifact.revision,
      "stale Web draft",
    );
    const settled = saving.then(
      () => ({ state: "saved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );
    // This separate lane drains the queue-registration tail, without unlocking note.txt.
    await withFileMutationQueue(
      join(cwd, "independent"),
      async () => undefined,
    );
    const readsWhileOwned = reads;
    proceed.release();
    await native;
    const result = await settled;
    assert.equal(
      readsWhileOwned,
      0,
      "Web must not read/stage while native write owns the lane",
    );
    assert.equal(result.state, "rejected");
    if (result.state === "rejected")
      assert.equal(
        (result.error as { code?: string }).code,
        "ARTIFACT_CHANGED",
      );
    assert.equal(
      await readFile(join(cwd, "note.txt"), "utf8"),
      "native update",
    );
    assert.deepEqual(await readdir(cwd), ["note.txt"]);
  } finally {
    proceed.release();
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace creation is explicit, single-parent, binary-preserving and never clobbers names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-workspace-create-"));
  const scope = { sessionId: "s", sessionPath: "/sessions/a.jsonl", cwd };
  const reader = new ArtifactReader(() => scope);
  try {
    const folder = await reader.mutateFile("s", scope.sessionPath, {
      kind: "create-directory",
      directory: ".",
      name: "资料",
    });
    assert.equal(folder.path, "资料");
    const empty = await reader.mutateFile("s", scope.sessionPath, {
      kind: "create-file",
      directory: "资料",
      name: "空 %20.txt",
    });
    assert.equal(empty.path, "资料/空 %20.txt");
    assert.equal((await readFile(join(cwd, empty.path))).length, 0);
    const bytes = Buffer.from([0, 255, 128, 13, 10, 239, 187, 191]);
    const imported = await reader.mutateFile("s", scope.sessionPath, {
      kind: "import-file",
      directory: "资料",
      name: "binary.dat",
      data: bytes.toString("base64"),
    });
    assert.equal(imported.bytes, bytes.length);
    assert.deepEqual(await readFile(join(cwd, imported.path)), bytes);
    for (const kind of ["create-file", "create-directory"] as const) {
      await assert.rejects(
        reader.mutateFile("s", scope.sessionPath, {
          kind,
          directory: "资料",
          name: "binary.dat",
        }),
        { code: "ARTIFACT_EXISTS" },
      );
    }
    await assert.rejects(
      reader.mutateFile("s", scope.sessionPath, {
        kind: "import-file",
        directory: "资料",
        name: "binary.dat",
        data: "d3Jvbmc=",
      }),
      { code: "ARTIFACT_EXISTS" },
    );
    assert.deepEqual(await readFile(join(cwd, imported.path)), bytes);
    for (const name of [
      "",
      ".",
      "..",
      "../outside",
      "/absolute",
      "a/b",
      "a\\b",
      "bad\u0000name",
      "bad\nname",
    ]) {
      await assert.rejects(
        reader.mutateFile("s", scope.sessionPath, {
          kind: "create-file",
          directory: ".",
          name,
        }),
        { code: "ARTIFACT_INVALID_NAME" },
      );
    }
    await assert.rejects(
      reader.mutateFile("s", scope.sessionPath, {
        kind: "create-file",
        directory: "missing/child",
        name: "note.txt",
      }),
      { code: "ARTIFACT_MISSING" },
    );
    assert.deepEqual(
      (await readdir(join(cwd, "资料"))).sort(),
      ["binary.dat", "空 %20.txt"].sort(),
    );
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace imports reject invalid/oversized data and competing same-name creates keep the winner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-workspace-import-"));
  const reader = new ArtifactReader(() => ({
    sessionId: "s",
    sessionPath: "a",
    cwd,
  }));
  try {
    for (const data of ["bad!", "YQ", "YQ=", "YQ==\n", "YR=="]) {
      await assert.rejects(
        reader.mutateFile("s", "a", {
          kind: "import-file",
          directory: ".",
          name: "invalid.bin",
          data,
        }),
        { code: "ARTIFACT_INVALID_DATA" },
      );
    }
    await assert.rejects(
      reader.mutateFile("s", "a", {
        kind: "import-file",
        directory: ".",
        name: "large.bin",
        data: Buffer.alloc(WEB_PROMPT_FILE_MAX_BYTES + 1).toString("base64"),
      }),
      { code: "ARTIFACT_TOO_LARGE" },
    );
    const results = await Promise.allSettled(
      ["first", "second"].map((text) =>
        reader.mutateFile("s", "a", {
          kind: "import-file",
          directory: ".",
          name: "winner.txt",
          data: Buffer.from(text).toString("base64"),
        }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const failed = results.find((result) => result.status === "rejected");
    assert.equal(
      failed?.status === "rejected" && failed.reason.code,
      "ARTIFACT_EXISTS",
    );
    assert.ok(
      ["first", "second"].includes(
        await readFile(join(cwd, "winner.txt"), "utf8"),
      ),
    );
    assert.deepEqual(await readdir(cwd), ["winner.txt"]);
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queued creation cannot survive exact Session change, revoke, or parent replacement", async () => {
  // Use the canonical parent for a not-yet-created native queue target.
  // macOS /var and /private/var aliases otherwise select different Pi lanes.
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "openpi-workspace-create-boundary-")),
  );
  let scope = { sessionId: "s", sessionPath: "a", cwd };
  let scopeReads = 0;
  let parentReady = barrier();
  const reader = new ArtifactReader(() => {
    if (++scopeReads === 2) parentReady.release();
    return scope;
  });
  try {
    await mkdir(join(cwd, "parent"));
    for (const condition of ["session", "revoke", "parent"] as const) {
      const entered = barrier();
      const proceed = barrier();
      const target = join(cwd, "parent", `${condition}.txt`);
      const held = withFileMutationQueue(target, async () => {
        entered.release();
        await proceed.promise;
      });
      await entered.promise;
      scopeReads = 0;
      parentReady = barrier();
      const writing = reader.mutateFile("s", "a", {
        kind: "create-file",
        directory: "parent",
        name: `${condition}.txt`,
      });
      const rejected = assert.rejects(writing, {
        code: condition === "parent" ? "ARTIFACT_CHANGED" : "ARTIFACT_DENIED",
      });
      await parentReady.promise;
      if (condition === "session")
        scope = { ...scope, sessionPath: "copied-session" };
      if (condition === "revoke") reader.revoke();
      if (condition === "parent") {
        await rename(join(cwd, "parent"), join(cwd, "original-parent"));
        await mkdir(join(cwd, "parent"));
      }
      proceed.release();
      await held;
      await rejected;
      assert.deepEqual(await readdir(join(cwd, "parent")), []);
      scope = { ...scope, sessionPath: "a" };
    }
    await assert.rejects(
      reader.mutateFile("s", "different", {
        kind: "create-file",
        directory: ".",
        name: "wrong-session",
      }),
      { code: "ARTIFACT_DENIED" },
    );
    await assert.rejects(
      reader.mutateFile("s", "a", {
        kind: "create-file",
        directory: "../",
        name: "outside",
      }),
      { code: "ARTIFACT_DENIED" },
    );
    if (process.platform !== "win32") {
      await symlink(tmpdir(), join(cwd, "outside"));
      await assert.rejects(
        reader.mutateFile("s", "a", {
          kind: "create-file",
          directory: "outside",
          name: "denied",
        }),
        { code: "ARTIFACT_DENIED" },
      );
      await symlink(join(cwd, "parent"), join(cwd, "linked"));
      await assert.rejects(
        reader.mutateFile("s", "a", {
          kind: "create-file",
          directory: "linked",
          name: "denied",
        }),
        { code: "ARTIFACT_DENIED" },
      );
    }
    assert.deepEqual(await readdir(join(cwd, "original-parent")), []);
    reader.dispose();
    await assert.rejects(
      reader.mutateFile("s", "a", {
        kind: "create-file",
        directory: ".",
        name: "after-dispose",
      }),
      { code: "ARTIFACT_DENIED" },
    );
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace import preserves files above preview size and cleans staging on final revocation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-workspace-large-import-"));
  const scope = { sessionId: "s", sessionPath: "a", cwd };
  let revokeAtCommit = false;
  let scopeReads = 0;
  let staged = false;
  const reader = new ArtifactReader(() => {
    if (revokeAtCommit && ++scopeReads === 4) {
      staged = readdirSync(cwd).some((name) =>
        name.startsWith(".openpi-create-"),
      );
      reader.revoke();
    }
    return scope;
  });
  try {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0x9f);
    const data = bytes.toString("base64");
    const result = await reader.mutateFile("s", "a", {
      kind: "import-file",
      directory: ".",
      name: "large.bin",
      data,
    });
    assert.equal(result.bytes, bytes.length);
    assert.deepEqual(await readFile(join(cwd, "large.bin")), bytes);
    const handle = await reader.resolveFile("s", "large.bin");
    await assert.rejects(reader.read(handle, "s"), {
      code: "ARTIFACT_TOO_LARGE",
    });
    revokeAtCommit = true;
    scopeReads = 0;
    await assert.rejects(
      reader.mutateFile("s", "a", {
        kind: "import-file",
        directory: ".",
        name: "revoked.bin",
        data,
      }),
      { code: "ARTIFACT_DENIED" },
    );
    assert.equal(
      staged,
      true,
      "the revocation actually happened after file staging",
    );
    assert.deepEqual(await readdir(cwd), ["large.bin"]);
  } finally {
    reader.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
