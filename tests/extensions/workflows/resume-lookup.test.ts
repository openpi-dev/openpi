import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// findRunDir resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-resume-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { findRunDir, resolveRunDir } = await import(
  "../../../extensions/workflows/index.ts"
);

const runs = join(agentDir, "workflows");
mkdirSync(join(runs, "wf_1a2b3c4d5e6f"), { recursive: true });
mkdirSync(join(runs, "wf_ffeeddcc5e6f"), { recursive: true });
mkdirSync(join(runs, "4d5e6f"), { recursive: true });
const invalidRunId =
  process.platform === "win32"
    ? "wf_not-generated-bad0"
    : "wf_\u001b]52;c;clipboard\u0007bad0";
mkdirSync(join(runs, invalidRunId), {
  recursive: true,
});

// A directory a traversal could reach, holding a journal a replay would trust.
const planted = join(agentDir, "planted");
mkdirSync(planted, { recursive: true });
writeFileSync(
  join(planted, "journal.json"),
  JSON.stringify({ version: 1, entries: [{ key: "x", output: "ATTACKER" }] }),
);

test("a run id is resolved by exact match or by hex suffix", () => {
  assert.equal(findRunDir("wf_1a2b3c4d5e6f"), join(runs, "wf_1a2b3c4d5e6f"));
  assert.equal(findRunDir("4d5e6f"), join(runs, "wf_1a2b3c4d5e6f"));
  assert.equal(
    findRunDir("  wf_1a2b3c4d5e6f  "),
    join(runs, "wf_1a2b3c4d5e6f"),
  );
  assert.equal(findRunDir("wf_nosuchrun"), undefined);
  assert.equal(findRunDir("bad0"), undefined);
});

test("an ambiguous short suffix cannot resume either matching run", () => {
  assert.equal(findRunDir("5e6f"), undefined);
  const collision = resolveRunDir("5e6f");
  assert.equal(collision.ok, false);
  assert.match(collision.error, /ambiguous/i);
  assert.equal(findRunDir("wf_1a2b3c4d5e6f"), join(runs, "wf_1a2b3c4d5e6f"));
  assert.equal(findRunDir("wf_ffeeddcc5e6f"), join(runs, "wf_ffeeddcc5e6f"));
});

test("a traversing run id cannot reach a journal outside the runs directory", () => {
  // resume_from_run_id is model-supplied, so it is reachable from injected
  // text the orchestrating model read. A planted journal replayed as genuine
  // agent output is the strongest form of a silent wrong replay: every hit
  // reports `ok (replayed)` with no agent having run and no artifact to audit.
  for (const hostile of [
    "../planted",
    "../../planted",
    "wf_1a2b3c4d5e6f/../../planted",
    "/etc",
    "..",
    ".",
    "",
    "   ",
  ]) {
    assert.equal(
      findRunDir(hostile),
      undefined,
      `${JSON.stringify(hostile)} must not resolve`,
    );
  }
});
