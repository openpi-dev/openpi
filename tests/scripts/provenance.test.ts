import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectReportedPaths,
  evaluateOpenPiProvenance,
  OPENPI_PACKAGE_NAME,
} from "../../scripts/provenance.mjs";

const checkout = resolve(".");

function packageDir(root: string, name: string, folder: string) {
  const dir = join(root, folder);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name })}\n`);
  return dir;
}

test("pi list lines keep absolute package paths", () => {
  assert.deepEqual(
    collectReportedPaths("User packages:\n  /workspace\n    /workspace\n"),
    ["/workspace", "/workspace"],
  );
  assert.deepEqual(collectReportedPaths("No packages installed.\n"), []);
});

test("the checkout matches by realpath even when the directory is not named openpi", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-provenance-"));
  try {
    const source = packageDir(root, OPENPI_PACKAGE_NAME, "checkout");
    const linked = join(root, "link");
    symlinkSync(source, linked);
    const match = evaluateOpenPiProvenance(
      [linked, source, `${source}/`],
      source,
    );
    assert.equal(match.matches, true);
    assert.deepEqual(match.openPiSources, [match.checkoutPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated packages are not OpenPI sources", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-provenance-"));
  try {
    const source = packageDir(root, OPENPI_PACKAGE_NAME, "checkout");
    const notes = packageDir(root, "notes", "openpi-notes");
    const other = packageDir(root, "pi-intercom", "intercom");
    const match = evaluateOpenPiProvenance([notes, other, source], source);
    assert.equal(match.matches, true);
    assert.deepEqual(match.openPiSources, [match.checkoutPath]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero, foreign, and multiple OpenPI sources do not match", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-provenance-"));
  try {
    const source = packageDir(root, OPENPI_PACKAGE_NAME, "checkout");
    const foreign = packageDir(root, OPENPI_PACKAGE_NAME, "foreign");
    const second = packageDir(root, OPENPI_PACKAGE_NAME, "second");
    assert.equal(evaluateOpenPiProvenance([], source).matches, false);
    assert.equal(evaluateOpenPiProvenance([foreign], source).matches, false);
    assert.equal(
      evaluateOpenPiProvenance([source, foreign], source).matches,
      false,
    );
    assert.equal(
      evaluateOpenPiProvenance([foreign, second], source).matches,
      false,
    );
    assert.equal(
      evaluateOpenPiProvenance([foreign], source).openPiSources.length,
      1,
    );
    assert.notEqual(
      evaluateOpenPiProvenance([foreign], source).openPiSources[0],
      evaluateOpenPiProvenance([foreign], source).checkoutPath,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runProvenance(packages: string[]) {
  const agent = mkdtempSync(join(tmpdir(), "openpi-provenance-agent-"));
  writeFileSync(
    join(agent, "settings.json"),
    `${JSON.stringify({ packages })}\n`,
  );
  try {
    return spawnSync(process.execPath, ["scripts/provenance.mjs"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    });
  } finally {
    rmSync(agent, { recursive: true, force: true });
  }
}

test("provenance accepts this checkout when pi list reports only its real path", () => {
  const result = runProvenance([checkout]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Provenance match: yes/);
  assert.match(result.stdout, /Checkout revision: [0-9a-f]{40}/);
});

test("provenance rejects a single foreign OpenPI package", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-provenance-"));
  try {
    const created = packageDir(root, OPENPI_PACKAGE_NAME, "foreign");
    const foreign = realpathSync.native(created);
    const result = runProvenance([created]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Provenance match: no/);
    assert.match(
      result.stdout,
      new RegExp(
        `OpenPI source reported by pi list: ${foreign.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance rejects an empty package list", () => {
  const result = runProvenance([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OpenPI source reported by pi list: none/);
  assert.match(result.stdout, /Provenance match: no/);
});
