import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createOwnerFileResourceRef,
  isOpenPiResourceRef,
  resolveOwnerFileResourceRef,
} from "../../../extensions/shared/resource-reference.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openpi-resource-ref-"));
  const file = path.join(root, "result.txt");
  writeFileSync(file, "complete owner value");
  const owner = {
    kind: "subagent" as const,
    id: "subagent-1",
    generation: "123",
  };
  const ref = createOwnerFileResourceRef({
    owner,
    resourceId: "final-result",
    root,
    file,
    mediaType: "text/plain",
    completeness: "complete-owner-value",
    sourceCoverage: "manager-bounded-final",
    lifetime: "session-cache",
  });
  return { root, file, owner, ref };
}

function failure(result: ReturnType<typeof resolveOwnerFileResourceRef>) {
  assert.equal(result.ok, false);
  return result.ok ? undefined : result.failure;
}

test("an owner-bound file reference resolves only through its owner adapter", () => {
  const item = fixture();
  try {
    assert.equal(isOpenPiResourceRef(item.ref), true);
    assert.deepEqual(
      resolveOwnerFileResourceRef(item.ref, {
        owner: item.owner,
        root: item.root,
        ownerAlive: true,
        authorized: true,
      }),
      { ok: true, path: item.file },
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("owner, generation, liveness, and authorization failures stay distinct", () => {
  const item = fixture();
  try {
    const resolve = (
      patch: Partial<Parameters<typeof resolveOwnerFileResourceRef>[1]>,
    ) =>
      resolveOwnerFileResourceRef(item.ref, {
        owner: item.owner,
        root: item.root,
        ownerAlive: true,
        authorized: true,
        ...patch,
      });
    assert.equal(
      failure(resolve({ owner: { ...item.owner, id: "subagent-2" } })),
      "owner-mismatch",
    );
    assert.equal(
      failure(resolve({ owner: { ...item.owner, generation: "124" } })),
      "stale-generation",
    );
    assert.equal(failure(resolve({ ownerAlive: false })), "owner-lost");
    assert.equal(failure(resolve({ authorized: false })), "unauthorized");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("traversal, symlink substitution, missing bytes, and revision drift fail closed", () => {
  const item = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "openpi-resource-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside");
  const resolve = (value: unknown) =>
    resolveOwnerFileResourceRef(value, {
      owner: item.owner,
      root: item.root,
      ownerAlive: true,
      authorized: true,
    });
  try {
    assert.equal(
      failure(
        resolve({
          ...item.ref,
          resource: { ...item.ref.resource, path: outsideFile },
        }),
      ),
      "unsafe-path",
    );

    unlinkSync(item.file);
    symlinkSync(outsideFile, item.file);
    assert.equal(failure(resolve(item.ref)), "symlink-substitution");

    unlinkSync(item.file);
    assert.equal(failure(resolve(item.ref)), "missing");

    writeFileSync(item.file, "changed owner value with another length");
    assert.equal(failure(resolve(item.ref)), "stale-resource");
    assert.equal(failure(resolve({})), "invalid-reference");
  } finally {
    rmSync(item.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("publication refuses an artifact outside the owner root", () => {
  const item = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "openpi-resource-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside");
  try {
    assert.throws(
      () =>
        createOwnerFileResourceRef({
          owner: item.owner,
          resourceId: "escape",
          root: item.root,
          file: outsideFile,
          mediaType: "text/plain",
          completeness: "complete-owner-value",
          sourceCoverage: "fixture",
          lifetime: "session-cache",
        }),
      /unsafe-path/,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
