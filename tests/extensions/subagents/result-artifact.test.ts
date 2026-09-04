import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_RESULT_ARTIFACT_BYTES,
  MAX_RESULT_ARTIFACT_FILES,
  pageResultText,
  persistResultArtifact,
  projectResult,
  readResultArtifact,
  resolveExactResultText,
  resultArtifactPath,
  resultArtifactRefMatchesContent,
} from "../../../extensions/subagents/src/result-artifact.ts";

const skipUnsupportedArtifactCache =
  process.platform !== "linux"
    ? "artifact cache requires Linux descriptor-relative no-follow filesystem APIs"
    : false;

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
    recoveryId: "sa-test",
    writeArtifact: (value) => {
      persisted = value;
      return "/tmp/final.txt";
    },
  });

  assert.equal(result.truncated, true);
  assert.equal(persisted, content);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 120);
  assert.match(result.text, /^BEGIN/);
  assert.match(result.text, /FINAL-VERDICT/);
  assert.match(result.text, /middle omitted|\.\.\./);
  assert.match(
    result.text,
    /Full final answer available via subagent_result\(id="sa-test", offset=1, limit=200\)/,
  );
  assert.doesNotMatch(result.text, /\/tmp\/final\.txt/);
});

test("a long artifact path is omitted without exceeding the output budget", () => {
  const result = projectResult("BEGIN\n" + "x\n".repeat(100) + "END", {
    maxBytes: 120,
    maxLines: 20,
    writeArtifact: () => `/${"x".repeat(10_000)}`,
  });

  assert.ok(Buffer.byteLength(result.text, "utf8") <= 120);
  assert.doesNotMatch(result.text, /x{1000}/);
});

test("the complete projection stays within its byte budget", () => {
  const content = `BEGIN\n${"middle-data\n".repeat(400)}FINAL-VERDICT`;
  const result = projectResult(content, {
    maxBytes: 512,
    maxLines: 100,
    recoveryId: "sa-budget",
    writeArtifact: () => "/tmp/final.txt",
  });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 512);
  assert.match(result.text, /^BEGIN/);
  assert.match(result.text, /FINAL-VERDICT/);
  assert.match(result.text, /\[\.\.\. middle omitted \.\.\.\]/);
  assert.match(
    result.text,
    /Full final answer available via subagent_result\(id="sa-budget"/,
  );
  assert.doesNotMatch(result.text, /\/tmp\/final\.txt/);
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

test("pathological byte budgets stay within the hard cap", () => {
  for (const maxBytes of [0, 1, 5, 17]) {
    const result = projectResult("BEGIN\n" + "x".repeat(200) + "\nEND", {
      maxBytes,
      maxLines: 10,
      writeArtifact: () => "/tmp/tiny.txt",
    });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= maxBytes);
    assert.doesNotMatch(result.text, /tmp[/\\]tiny\.txt/);
  }
});

test("maxLines: 1, empty text, a single long line, and a trailing newline stay bounded", () => {
  const cases = [
    { content: "", maxBytes: 10, maxLines: 1 },
    {
      content: "only-one-very-long-line-" + "x".repeat(200),
      maxBytes: 40,
      maxLines: 1,
    },
    {
      content: "head\n" + "mid\n".repeat(40) + "tail\n",
      maxBytes: 80,
      maxLines: 1,
    },
    { content: "line-0\nline-1\n", maxBytes: 10_000, maxLines: 1 },
  ];
  for (const sample of cases) {
    const result = projectResult(sample.content, {
      ...sample,
      writeArtifact: () => "/tmp/lines.txt",
    });
    assert.ok(Buffer.byteLength(result.text, "utf8") <= sample.maxBytes);
    assert.doesNotMatch(result.text, /tmp[/\\]lines\.txt/);
    if (
      sample.content.length > 0 &&
      Buffer.byteLength(sample.content, "utf8") > sample.maxBytes
    ) {
      assert.equal(result.truncated, true);
    }
  }
});

test("a multibyte character at the budget boundary is never split", () => {
  const content = `${"中".repeat(40)}\n${"证".repeat(40)}\n${"尾".repeat(10)}`;
  for (const maxBytes of [7, 8, 9, 16, 17]) {
    const result = projectResult(content, {
      maxBytes,
      maxLines: 10,
      writeArtifact: () => "/tmp/utf8.txt",
    });
    assert.ok(Buffer.byteLength(result.text, "utf8") <= maxBytes);
    assert.doesNotMatch(result.text, /�/);
    assert.doesNotMatch(result.text, /tmp[/\\]utf8\.txt/);
  }
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
  assert.equal(result.artifactPersisted, undefined);
  assert.equal(result.artifactSaveFailed, true);
  assert.match(result.text, /could not be saved/);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 80);
  assert.doesNotMatch(result.text, /Full final answer:/);
});

test("content-addressed artifacts are exact, private, and reusable", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-artifact-"),
  );
  try {
    const content = "complete final answer\nwith verdict";
    const firstRef = persistResultArtifact(agentDir, content);
    const secondRef = persistResultArtifact(agentDir, content);
    const first = resultArtifactPath(agentDir, firstRef);
    const second = resultArtifactPath(agentDir, secondRef);

    assert.equal(first, second);
    assert.equal(await readFile(first, "utf8"), content);
    assert.equal(readResultArtifact(agentDir, firstRef), content);
    assert.deepEqual(
      (await readdir(path.dirname(first))).filter((name) =>
        name.endsWith(".tmp"),
      ),
      [],
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(first)).mode & 0o777, 0o600);
    }
    assert.equal(path.basename(first).length, 68);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("artifact retention evicts the oldest owned files under count and byte caps", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-retention-"),
  );
  const limits = { maxFiles: 2, maxBytes: 11 };
  try {
    const firstRef = persistResultArtifact(agentDir, "first", limits);
    const first = resultArtifactPath(agentDir, firstRef);
    await utimes(first, new Date(1_000), new Date(1_000));
    const secondRef = persistResultArtifact(agentDir, "second", limits);
    const second = resultArtifactPath(agentDir, secondRef);
    await utimes(second, new Date(2_000), new Date(2_000));
    const thirdRef = persistResultArtifact(agentDir, "third", limits);
    const third = resultArtifactPath(agentDir, thirdRef);

    await assert.rejects(access(first));
    assert.equal(await readFile(second, "utf8"), "second");
    assert.equal(await readFile(third, "utf8"), "third");
    assert.deepEqual(
      persistResultArtifact(agentDir, "second", limits),
      secondRef,
    );

    const directory = path.dirname(third);
    const retained = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.txt$/.test(name),
    );
    assert.equal(retained.length, 2);
    const totalBytes = (
      await Promise.all(
        retained.map(
          async (name) => (await lstat(path.join(directory, name))).size,
        ),
      )
    ).reduce((total, size) => total + size, 0);
    assert.ok(totalBytes <= limits.maxBytes);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("an artifact too large for the cache leaves no partial file and later writes recover", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-oversized-"),
  );
  const limits = { maxFiles: 2, maxBytes: 5 };
  try {
    assert.throws(
      () => persistResultArtifact(agentDir, "too large", limits),
      /exceeds the 5-byte cache capacity/,
    );
    const recoveredRef = persistResultArtifact(agentDir, "small", limits);
    const recovered = resultArtifactPath(agentDir, recoveredRef);
    assert.equal(await readFile(recovered, "utf8"), "small");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("custom cache limits reject zero, negative, and over-cap maxBytes", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-tiny-limit-"),
  );
  try {
    for (const maxBytes of [0, -1, MAX_RESULT_ARTIFACT_BYTES + 1]) {
      assert.throws(
        () =>
          persistResultArtifact(agentDir, "small", { maxFiles: 1, maxBytes }),
        /maxBytes must be a positive safe integer|maxBytes must not exceed/,
      );
    }
    const recovered = persistResultArtifact(agentDir, "ok", {
      maxFiles: 1,
      maxBytes: 2,
    });
    assert.equal(readResultArtifact(agentDir, recovered), "ok");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("artifact references reject path-bearing extra fields", () => {
  const digest = createHash("sha256").update("content", "utf8").digest("hex");
  assert.equal(
    resultArtifactRefMatchesContent(
      { version: 1, digest, path: "C:/secret/cache/result.txt" },
      "content",
    ),
    false,
  );
});

test("custom cache limits cannot exceed the reader limit", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-limit-validation-"),
  );
  try {
    assert.throws(
      () =>
        persistResultArtifact(agentDir, "small", {
          maxFiles: MAX_RESULT_ARTIFACT_FILES + 1,
          maxBytes: 32,
        }),
      /maxFiles must not exceed 64 files/,
    );
    assert.throws(
      () =>
        persistResultArtifact(agentDir, "small", {
          maxFiles: 1,
          maxBytes: 64 * 1024 * 1024 + 1,
        }),
      /maxBytes must not exceed 67108864 bytes/,
    );
    assert.equal(
      await access(path.join(agentDir, "cache"))
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("stale crash metadata is reclaimed under the cache lock", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-stale-metadata-"),
  );
  try {
    const seed = persistResultArtifact(agentDir, "seed metadata cleanup");
    const directory = path.dirname(resultArtifactPath(agentDir, seed));
    const old = new Date(1_000);
    const tempName = `.${"a".repeat(64)}.${randomUUID()}.tmp`;
    const ownerName = `.retention-lock.owner.999999.${randomUUID()}`;
    const recoveryName = `.retention-lock.recovery.${randomUUID()}`;
    for (const [name, content] of [
      [tempName, "abandoned payload"],
      [ownerName, "abandoned owner"],
      [recoveryName, "abandoned recovery"],
    ] as const) {
      const file = path.join(directory, name);
      await writeFile(file, content, "utf8");
      await utimes(file, old, old);
    }

    persistResultArtifact(agentDir, "run metadata cleanup");
    const remaining = await readdir(directory);
    assert.doesNotMatch(
      remaining.join("\n"),
      /retention-lock\.(owner|recovery)|\.tmp/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("artifact persistence refuses a symlinked cache component", {
  skip: skipUnsupportedArtifactCache,
}, async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "openpi-result-symlink-"));
  const outside = await mkdtemp(path.join(tmpdir(), "openpi-result-outside-"));
  try {
    try {
      await symlink(outside, path.join(agentDir, "cache"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires an enabled Windows developer mode");
        return;
      }
      throw error;
    }
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

test("artifact references cannot read an external digest-named file", async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-external-ref-"),
  );
  const outside = await mkdtemp(path.join(tmpdir(), "openpi-result-external-"));
  try {
    const content = "external content must not be accepted";
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    await writeFile(path.join(outside, `${digest}.txt`), content, "utf8");
    assert.equal(
      readResultArtifact(agentDir, { version: 1, digest }),
      undefined,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("cache lock contention fails closed without bypassing retention", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-lock-contention-"),
  );
  try {
    const limits = { maxFiles: 1, maxBytes: 32 };
    const existing = persistResultArtifact(agentDir, "existing", limits);
    const directory = path.dirname(resultArtifactPath(agentDir, existing));
    const lockPath = path.join(directory, ".retention-lock");
    await writeFile(lockPath, "uncertain lock\n", "utf8");

    assert.throws(
      () => persistResultArtifact(agentDir, "new result", limits),
      /busy or has uncertain ownership/,
    );
    assert.equal(await readFile(lockPath, "utf8"), "uncertain lock\n");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a live lock owner is never stolen by age and stays fail-closed", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-live-lock-"),
  );
  try {
    const limits = { maxFiles: 1, maxBytes: 32 };
    persistResultArtifact(agentDir, "seed live lock", limits);
    const directory = path.join(
      agentDir,
      "cache",
      "openpi",
      "subagent-results",
    );
    const owner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: 1,
    };
    const claim = path.join(
      directory,
      `.retention-lock.owner.${owner.pid}.${owner.token}`,
    );
    const lock = path.join(directory, ".retention-lock");
    await writeFile(claim, `${JSON.stringify(owner)}\n`, "utf8");
    await utimes(claim, new Date(1_000), new Date(1_000));
    try {
      await rm(lock, { force: true });
    } catch {
      // The previous publication already released the lock.
    }
    await link(claim, lock);
    await utimes(lock, new Date(1_000), new Date(1_000));
    assert.throws(
      () => persistResultArtifact(agentDir, "must not steal live lock", limits),
      /busy or has uncertain ownership/,
    );
    assert.equal(await readFile(lock, "utf8"), `${JSON.stringify(owner)}\n`);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a lock left by a dead owner is reclaimed only after ownership checks", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-stale-lock-"),
  );
  try {
    const limits = { maxFiles: 1, maxBytes: 32 };
    persistResultArtifact(agentDir, "seed", limits);
    const directory = path.join(
      agentDir,
      "cache",
      "openpi",
      "subagent-results",
    );
    const dead = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
    });
    const deadPid = dead.pid;
    assert.ok(deadPid);
    await new Promise<void>((resolve, reject) => {
      dead.once("error", reject);
      dead.once("close", () => resolve());
    });
    const owner = {
      version: 1,
      pid: deadPid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    const claim = path.join(
      directory,
      `.retention-lock.owner.${owner.pid}.${owner.token}`,
    );
    const lock = path.join(directory, ".retention-lock");
    await writeFile(claim, `${JSON.stringify(owner)}\n`, "utf8");
    await link(claim, lock);

    const recovered = persistResultArtifact(agentDir, "recovered", limits);
    assert.equal(readResultArtifact(agentDir, recovered), "recovered");
    assert.equal(
      await access(lock)
        .then(() => true)
        .catch(() => false),
      false,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("cooperating processes keep retention caps under concurrent writes", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-concurrent-retention-"),
  );
  try {
    const moduleUrl = new URL(
      "../../../extensions/subagents/src/result-artifact.ts",
      import.meta.url,
    ).href;
    const source =
      `import { persistResultArtifact } from ${JSON.stringify(moduleUrl)};\n` +
      `try { persistResultArtifact(process.env.OPENPI_RESULT_DIR, process.env.OPENPI_RESULT_CONTENT, { maxFiles: 2, maxBytes: 32 }); process.exit(0); } catch { process.exit(2); }`;
    const children = Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--experimental-strip-types",
              "--input-type=module",
              "--eval",
              source,
            ],
            {
              env: {
                ...process.env,
                OPENPI_RESULT_DIR: agentDir,
                OPENPI_RESULT_CONTENT: `concurrent-${index}`,
              },
              stdio: ["ignore", "ignore", "ignore"],
            },
          );
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        }),
    );
    const statuses = await Promise.all(children);
    assert.ok(statuses.includes(0));

    const directory = path.join(
      agentDir,
      "cache",
      "openpi",
      "subagent-results",
    );
    const retained = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.txt$/u.test(name),
    );
    assert.ok(retained.length <= 2);
    const totalBytes = (
      await Promise.all(
        retained.map(
          async (name) => (await lstat(path.join(directory, name))).size,
        ),
      )
    ).reduce((total, size) => total + size, 0);
    assert.ok(totalBytes <= 32);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("artifact persistence refuses an existing file with the wrong content", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-collision-"),
  );
  try {
    const content = "original final answer";
    const artifactRef = persistResultArtifact(agentDir, content);
    const artifactPath = resultArtifactPath(agentDir, artifactRef);
    await writeFile(artifactPath, "tampered", "utf8");
    assert.equal(readResultArtifact(agentDir, artifactRef), undefined);
    assert.throws(
      () => persistResultArtifact(agentDir, content),
      /Result artifact collision/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a syntactically valid ResultArtifactRef is rejected when the digest is wrong", () => {
  const content = "settled exact result";
  const wrong = {
    version: 1 as const,
    digest: createHash("sha256").update("other", "utf8").digest("hex"),
  };
  assert.equal(resultArtifactRefMatchesContent(wrong, content), false);
  assert.equal(
    resultArtifactRefMatchesContent(
      {
        version: 1,
        digest: createHash("sha256").update(content, "utf8").digest("hex"),
      },
      content,
    ),
    true,
  );
});

test("exact result paging is 0-based and never treats a projection as canonical", () => {
  const lines = Array.from({ length: 5 }, (_, i) => `line-${i}`).join("\n");
  const first = pageResultText(lines, { offset: 0, limit: 2 });
  assert.equal(first.text, "line-0\nline-1");
  assert.equal(first.hasMore, true);
  const middle = pageResultText(lines, { offset: 3, limit: 2 });
  assert.equal(middle.text, "line-3\nline-4");
  assert.equal(middle.hasMore, false);
  const empty = pageResultText(lines, { offset: 8, limit: 2 });
  assert.match(empty.text, /No result lines at offset 8/);
  const truncated = pageResultText("x".repeat(200), { maxBytes: 40, limit: 1 });
  assert.equal(truncated.truncated, true);
  assert.match(truncated.text, /page truncated/);
  assert.ok((truncated.nextByteOffset ?? 0) > 0);
  assert.ok(Buffer.byteLength(truncated.text, "utf8") <= 40);

  const longLine = `${"a".repeat(20 * 1024)}SENTINEL`;
  let cursor = 0;
  let recovered = "";
  for (let i = 0; i < 30; i++) {
    const page = pageResultText(longLine, {
      byteOffset: cursor,
      maxBytes: 1024,
    });
    assert.ok(Buffer.byteLength(page.text, "utf8") <= 1024);
    assert.equal(page.text.includes("�"), false);
    recovered += page.text.replace(/\n\[page truncated; next \d+\]$/u, "");
    if (!page.hasMore) break;
    assert.ok(
      page.nextByteOffset !== undefined && page.nextByteOffset > cursor,
    );
    cursor = page.nextByteOffset;
  }
  assert.match(recovered, /SENTINEL$/);
  assert.equal(pageResultText(longLine, { byteOffset: cursor }).hasMore, false);
  assert.throws(
    () => pageResultText("a😀b", { byteOffset: 2 }),
    /code-point boundary/,
  );
  assert.throws(
    () => pageResultText("abc", { offset: 0, byteOffset: 0 }),
    /either offset or byteOffset/,
  );

  assert.equal(
    resolveExactResultText({
      artifactText: undefined,
      retainedFinalText: "projected only",
      resultIsCanonical: false,
      omittedFinalTextBytes: 100,
    }),
    undefined,
  );
  assert.equal(
    resolveExactResultText({
      artifactText: undefined,
      retainedFinalText: "canonical retained",
      resultIsCanonical: true,
      omittedFinalTextBytes: 100,
    }),
    "canonical retained",
  );
  assert.equal(
    resolveExactResultText({
      artifactText: undefined,
      retainedFinalText: "truncated prefix",
      resultIsCanonical: true,
      finalTextTruncated: true,
      omittedFinalTextBytes: 100,
    }),
    undefined,
  );
  assert.equal(
    resolveExactResultText({
      artifactText: "from artifact",
      retainedFinalText: "canonical retained",
      resultIsCanonical: false,
      omittedFinalTextBytes: 100,
    }),
    "from artifact",
  );
});

test("line paging hands off an oversized Unicode line to byte paging", () => {
  const content = `first\n${"开".repeat(10 * 1024)}\nlast`;
  const first = pageResultText(content, {
    offset: 1,
    limit: 1,
    maxBytes: 256,
  });
  assert.equal(first.offset, 1);
  assert.equal(first.truncated, true);
  assert.ok(first.nextByteOffset !== undefined);

  let cursor = first.nextByteOffset;
  let recovered = first.text.replace(/\n\[page truncated; next \d+\]$/u, "");
  for (let attempt = 0; attempt < 200; attempt++) {
    const page = pageResultText(content, {
      byteOffset: cursor,
      maxBytes: 256,
    });
    recovered += page.text.replace(/\n\[page truncated; next \d+\]$/u, "");
    if (!page.hasMore) break;
    assert.ok(
      page.nextByteOffset !== undefined && page.nextByteOffset > cursor,
    );
    cursor = page.nextByteOffset;
  }

  assert.equal(recovered, content.slice("first\n".length));
  assert.equal(recovered.includes("�"), false);
});

test("uncertain recovery entries are never relinked as the published lock", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-poisoned-lock-"),
  );
  try {
    const seed = persistResultArtifact(agentDir, "seed lock recovery");
    const directory = path.dirname(resultArtifactPath(agentDir, seed));
    const lock = path.join(directory, ".retention-lock");
    const outside = path.join(agentDir, "outside-target");
    await writeFile(outside, "not a lock\n", "utf8");
    await rm(lock, { force: true });
    try {
      await symlink(outside, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
    assert.throws(
      () => persistResultArtifact(agentDir, "must not poison lock"),
      /(?:busy or has uncertain ownership|Unsafe result artifact file)/,
    );
    assert.equal((await lstat(lock)).isSymbolicLink(), true);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("stale metadata cleanup skips symlink and unknown entries", {
  skip: skipUnsupportedArtifactCache,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-skip-unknown-"),
  );
  try {
    const seed = persistResultArtifact(agentDir, "seed skip unknown");
    const directory = path.dirname(resultArtifactPath(agentDir, seed));
    const old = new Date(1_000);
    const unknown = path.join(directory, "not-an-owned-name.bin");
    await writeFile(unknown, "keep me", "utf8");
    await utimes(unknown, old, old);
    const linkName = path.join(
      directory,
      `.retention-lock.recovery.${randomUUID()}`,
    );
    try {
      await symlink(unknown, linkName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    persistResultArtifact(agentDir, "cleanup after unknown");
    assert.equal(await readFile(unknown, "utf8"), "keep me");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("non-Linux artifact cache fails closed before touching the filesystem", {
  skip: process.platform === "linux" ? "non-Linux-only" : false,
}, async () => {
  const agentDir = await mkdtemp(
    path.join(tmpdir(), "openpi-result-windows-disabled-"),
  );
  try {
    assert.throws(
      () =>
        persistResultArtifact(agentDir, "must not write", {
          maxFiles: 1,
          maxBytes: 32,
        }),
      /cache is unavailable/,
    );
    assert.equal(
      await access(path.join(agentDir, "cache"))
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      readResultArtifact(agentDir, {
        version: 1,
        digest: createHash("sha256")
          .update("must not write", "utf8")
          .digest("hex"),
      }),
      undefined,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
