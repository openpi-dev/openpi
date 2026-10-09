import assert from "node:assert/strict";
import test from "node:test";
import { readTurnChangesDetail } from "../../web/protocol/turn-changes.ts";

function record() {
  return {
    version: 2,
    source: "file-tools",
    sessionId: "session",
    promptEntryId: "prompt",
    state: "complete",
    fileCount: 1,
    files: [
      {
        path: "after.txt",
        previousPath: "before.txt",
        status: "renamed",
        diff: "",
        diffTruncated: false,
        additions: 0,
        deletions: 0,
      },
    ],
    additions: 0,
    deletions: 0,
  };
}

test("persisted turn-change enums require actual strings", () => {
  for (const state of [
    ["complete"],
    ["partial"],
    ["unavailable"],
    null,
    {},
    1,
  ]) {
    assert.equal(readTurnChangesDetail({ ...record(), state }), undefined);
  }
  for (const statsUnavailable of [
    ["content_limit"],
    ["before_unavailable"],
    ["concurrent_change"],
    null,
    {},
    1,
  ]) {
    const value = record();
    assert.equal(
      readTurnChangesDetail({
        ...value,
        state: "partial",
        files: [{ ...value.files[0], statsUnavailable }],
      }),
      undefined,
    );
  }
});

test("persisted previous paths obey the same nonempty and NUL boundary as paths", () => {
  for (const previousPath of ["", "before\0.txt", "x".repeat(2001)]) {
    const value = record();
    assert.equal(
      readTurnChangesDetail({
        ...value,
        files: [{ ...value.files[0], previousPath }],
      }),
      undefined,
    );
  }
});

test("retained previous-path UTF-8 bytes count toward the record budget", () => {
  const value = record();
  const files = Array.from({ length: 50 }, (_, index) => ({
    ...value.files[0],
    path: `${index}.txt`,
    previousPath: "中".repeat(1999),
  }));
  assert.equal(
    readTurnChangesDetail({
      ...value,
      state: "partial",
      fileCount: files.length,
      files,
    }),
    undefined,
  );
});

test("valid legacy and native turn-change records retain their fields", () => {
  const value = record();
  assert.ok(readTurnChangesDetail(value));
  assert.ok(readTurnChangesDetail({ ...value, version: 1 }));
  for (const state of ["partial", "unavailable"]) {
    for (const statsUnavailable of [
      "before_unavailable",
      "content_limit",
      "concurrent_change",
    ]) {
      const result = readTurnChangesDetail({
        ...value,
        state,
        files: [{ ...value.files[0], statsUnavailable }],
      });
      assert.equal(result?.state, state);
      assert.equal(result?.files[0]?.statsUnavailable, statsUnavailable);
    }
  }
});
