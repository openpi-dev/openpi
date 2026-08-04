import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// findRunDir resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-resume-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { findRunDir } = await import("./index.ts");

const runs = join(agentDir, "workflows");
mkdirSync(join(runs, "wf_1a2b3c4d5e6f"), { recursive: true });

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
