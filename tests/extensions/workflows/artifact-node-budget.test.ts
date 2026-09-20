import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boundedTranscriptsArtifact,
  persistWorkflowJson,
} from "../../../extensions/workflows/artifacts.ts";
import {
  buildWorkflowReport,
  normalizePersistedWorkflowDetails,
} from "../../../extensions/workflows/dashboard.ts";
import {
  type AgentRecord,
  emptyUsage,
  type TranscriptEntry,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

// The upstream ceiling for a single agent's transcript. A run of ordinary
// review agents each reaching this is what surfaced the silent node-budget
// truncation in issue #558.
const TRANSCRIPT_ENTRIES = 202;

function transcript(entries = TRANSCRIPT_ENTRIES): TranscriptEntry[] {
  return Array.from({ length: entries }, (_, index) => ({
    role: (index % 2 === 0 ? "tool" : "toolResult") as TranscriptEntry["role"],
    text: `Read src/module-${index}.ts`,
    name: "Read",
    toolCallId: `toolu_${index.toString(36).padStart(8, "0")}`,
    timestamp: 1_700_000_000_000 + index,
    startedAt: 1_700_000_000_000 + index,
    finishedAt: 1_700_000_000_120 + index,
    durationMs: 120,
  }));
}

function agent(index: number, entries: TranscriptEntry[]): AgentRecord {
  return {
    index,
    callId: `call-${index}`,
    label: `review:file-${index}`,
    phase: "Review",
    state: "done",
    model: "claude-opus-5",
    contextWindow: 400_000,
    startedAt: 1_700_000_000_000 + index,
    finishedAt: 1_700_000_050_000 + index,
    preview: "reviewed",
    usage: emptyUsage(),
    resultArtifact: `agent-results/agent-${String(index).padStart(4, "0")}.json`,
    transcript: entries,
  };
}

function details(agents: AgentRecord[]): WorkflowDetails {
  return {
    runId: "wf_deadbeef",
    sessionId: "sess-1",
    name: "review-changes",
    background: true,
    status: "completed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_900_000,
    phases: [{ title: "Review" }],
    agents,
    delivery: {
      id: "wf_deadbeef:1",
      ownerSessionId: "sess-1",
      ownerEpoch: 1,
      state: "pending",
      attempts: 0,
      updatedAt: 1_700_000_900_000,
    },
    result: { ok: true },
  };
}

function withRunDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wf-node-budget-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function transcriptKeys(dir: string) {
  const raw = JSON.parse(
    readFileSync(join(dir, "transcripts.json"), "utf8"),
  ) as Record<string, unknown>;
  return Object.keys(raw).filter((key) => /^\d+$/.test(key));
}

test("transcripts.json keeps every agent for a default-scale run (issue #558)", () => {
  // 12 agents x 202 entries used to stop at 11 agents (20_000-node default),
  // at ~28% of the byte cap, with no record that anything was dropped.
  withRunDir((dir) => {
    const source = details(
      Array.from({ length: 12 }, (_, index) => agent(index, transcript())),
    );
    persistWorkflowJson(dir, source);

    const keys = transcriptKeys(dir);
    assert.equal(keys.length, 12, "all 12 agent transcripts must be written");

    const parsed = JSON.parse(
      readFileSync(join(dir, "transcripts.json"), "utf8"),
    );
    for (let index = 0; index < 12; index++) {
      assert.equal(
        (parsed as Record<string, unknown[]>)[String(index)]?.length,
        TRANSCRIPT_ENTRIES,
        `agent ${index} must keep all ${TRANSCRIPT_ENTRIES} entries`,
      );
    }

    const back = normalizePersistedWorkflowDetails(
      "wf_deadbeef",
      JSON.parse(readFileSync(join(dir, "workflow.json"), "utf8")),
    );
    assert.equal(back?.status, "completed");
    assert.equal(back?.agents.length, 12);
    assert.equal(back?.delivery?.state, "pending");
    assert.equal(back?.transcriptArtifact, "transcripts.json");
    assert.equal(back?.transcriptsOmitted, undefined);
  });
});

test("transcripts.json keeps whole agents and reports the dropped tail on overflow", () => {
  // Enough full transcripts to exceed the 2 MiB byte budget so the byte cap,
  // not the node budget, becomes the binding limit.
  withRunDir((dir) => {
    const total = 80;
    const source = details(
      Array.from({ length: total }, (_, index) => agent(index, transcript())),
    );
    persistWorkflowJson(dir, source);

    const keys = transcriptKeys(dir);
    assert.ok(keys.length > 0, "at least one agent must survive");
    assert.ok(
      keys.length < total,
      "the tail must be dropped past the byte cap",
    );

    // Whole agents only: every written key holds a full transcript.
    const parsed = JSON.parse(
      readFileSync(join(dir, "transcripts.json"), "utf8"),
    ) as Record<string, unknown[]>;
    for (const key of keys) {
      assert.equal(parsed[key]?.length, TRANSCRIPT_ENTRIES);
    }
    // The file stays within its byte cap.
    assert.ok(
      Buffer.byteLength(readFileSync(join(dir, "transcripts.json"), "utf8")) <=
        2 * 1024 * 1024,
    );

    const back = normalizePersistedWorkflowDetails(
      "wf_deadbeef",
      JSON.parse(readFileSync(join(dir, "workflow.json"), "utf8")),
    );
    const omitted = back?.transcriptsOmitted;
    assert.ok(omitted, "transcriptsOmitted must be reported");
    assert.equal(omitted?.agents, total - keys.length);
    assert.equal(omitted?.entries, (total - keys.length) * TRANSCRIPT_ENTRIES);

    const report = buildWorkflowReport(back!);
    assert.match(
      report,
      /agent transcript\(s\).*omitted from transcripts\.json/,
    );
  });
});

test("boundedTranscriptsArtifact keeps whole agents in index order and counts the rest", () => {
  const agents = Array.from({ length: 40 }, (_, index) =>
    agent(index, transcript()),
  );
  const bounded = boundedTranscriptsArtifact(agents, {
    maxBytes: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(bounded.content) as Record<string, unknown[]>;
  const keptKeys = Object.keys(parsed)
    .map(Number)
    .sort((a, b) => a - b);

  // Kept keys are a contiguous prefix by index (0..K-1); the tail is omitted.
  assert.deepEqual(
    keptKeys,
    Array.from({ length: keptKeys.length }, (_, i) => i),
  );
  assert.equal(bounded.omitted.agents, 40 - keptKeys.length);
  assert.equal(
    bounded.omitted.entries,
    (40 - keptKeys.length) * TRANSCRIPT_ENTRIES,
  );

  const empty = boundedTranscriptsArtifact([]);
  assert.deepEqual(empty.omitted, { agents: 0, entries: 0 });
  assert.deepEqual(JSON.parse(empty.content), {});
});

test("workflow.json manifest survives the hard agent-call cap without losing terminal fields", () => {
  // At 500-1024 agents the 20_000-node default used to drop delivery / status /
  // transcriptArtifact from the tail of the manifest object.
  withRunDir((dir) => {
    const source = details(
      Array.from({ length: 1024 }, (_, index) => agent(index, [])),
    );
    persistWorkflowJson(dir, source);

    const raw = readFileSync(join(dir, "workflow.json"), "utf8");
    assert.equal(
      raw.includes("[truncated: node limit]"),
      false,
      "manifest must not be node-truncated within the valid agent range",
    );
    const back = normalizePersistedWorkflowDetails(
      "wf_deadbeef",
      JSON.parse(raw),
    );
    assert.equal(back?.status, "completed");
    assert.equal(back?.agents.length, 1024);
    assert.equal(back?.delivery?.state, "pending");
    assert.equal(back?.resultArtifact, "result.json");
    assert.equal(back?.transcriptArtifact, "transcripts.json");
  });
});

test("result.json overflow is reported honestly, not silently lossy", () => {
  withRunDir((dir) => {
    // Many mid-sized strings: each stays under maxStringBytes and the node
    // count stays far under the budget, so the *byte* cap is what binds — the
    // path the node-budget fix routes overflow through.
    const huge = {
      items: Array.from({ length: 50 }, (_, index) => ({
        id: index,
        blob: "x".repeat(40 * 1024),
      })),
    };
    const source = details([agent(0, [])]);
    source.result = huge;
    persistWorkflowJson(dir, source);

    const parsed = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    // The honest byte-cap fallback: a visible truncation marker, never a
    // valid-looking object missing its tail.
    assert.equal(parsed.truncated, true);
    assert.match(String(parsed.reason ?? ""), /exceeded/);
  });
});
