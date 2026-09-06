import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  boundedArtifactTranscript,
  createWorkflowPersistence,
  loadJournal,
  persistWorkflowAgentResult,
  persistWorkflowJson,
  persistWorkflowTerminalState,
} from "../../../extensions/workflows/artifacts.ts";
import {
  createJournalAccumulator,
  JOURNAL_MAX_BYTES,
} from "../../../extensions/workflows/journal.ts";
import {
  emptyUsage,
  type TranscriptEntry,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

function workflowDetails(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "session_fixture",
    background: false,
    status: "running",
    startedAt: 1,
    phases: [],
    agents: [],
  };
}

test("artifact transcript keeps the initial prompt, marker, and newest entries", () => {
  const prompt = `initial:${"p".repeat(70)}`;
  const transcript = [
    { role: "user" as const, text: prompt },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "assistant" as const,
      text: `entry-${index}:${String(index).repeat(70)}`,
    })),
  ];

  const bounded = boundedArtifactTranscript(transcript, {
    maxBytes: 256,
    entryMaxBytes: 80,
  });

  assert.equal(bounded[0]?.role, "user");
  assert.equal(bounded[0]?.text, prompt);
  assert.match(bounded[1]?.text ?? "", /artifact transcript truncated/);
  assert.equal(bounded.at(-1)?.text, transcript.at(-1)?.text);
  assert.equal(
    bounded.some((entry) => entry.text.startsWith("entry-0:")),
    false,
  );
  assert.ok(
    bounded.reduce(
      (total, entry) => total + Buffer.byteLength(entry.text, "utf8"),
      0,
    ) <= 256,
  );
});

test("live artifact persistence includes current agents and transcripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-artifacts-"));
  try {
    const details = workflowDetails();
    details.agents.push({
      index: 1,
      label: "running-fixture",
      state: "running",
      startedAt: 2,
      preview: "working",
      usage: emptyUsage(),
      acceptance: {
        status: "accepted",
        criteria: [{ id: "tests", status: "accepted", evidence: ["npm test"] }],
        errors: [],
      },
      transcript: [
        { role: "user", text: "current prompt" },
        {
          role: "tool",
          name: "fixture",
          toolCallId: "call-fixture",
          text: "{}",
          startedAt: 10,
          finishedAt: 25,
          durationMs: 15,
        },
      ],
    });

    persistWorkflowJson(directory, details);

    const workflow = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    const transcripts = JSON.parse(
      readFileSync(join(directory, "transcripts.json"), "utf8"),
    ) as Record<string, TranscriptEntry[]>;
    assert.equal(workflow.agents.length, 1);
    assert.equal(workflow.agents[0]?.label, "running-fixture");
    assert.equal(workflow.agents[0]?.acceptance?.status, "accepted");
    assert.equal(transcripts["1"]?.[0]?.text, "current prompt");
    assert.deepEqual(
      {
        toolCallId: transcripts["1"]?.[1]?.toolCallId,
        startedAt: transcripts["1"]?.[1]?.startedAt,
        finishedAt: transcripts["1"]?.[1]?.finishedAt,
        durationMs: transcripts["1"]?.[1]?.durationMs,
      },
      {
        toolCallId: "call-fixture",
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent result artifacts are complete or fail without leaving a file", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-agent-result-"));
  try {
    const artifact = persistWorkflowAgentResult(directory, 1, {
      output: "complete",
      structured: { verdict: "accepted", emoji: "你好🙂" },
    });
    assert.equal(artifact, "agent-results/agent-0001.json");
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, artifact), "utf8")),
      {
        output: "complete",
        structured: { verdict: "accepted", emoji: "你好🙂" },
      },
    );

    assert.throws(
      () =>
        persistWorkflowAgentResult(directory, 2, {
          output: "too large",
          structured: "x".repeat(3 * 1024 * 1024),
        }),
      /agent result artifact exceeded the .* budget/i,
    );
    assert.throws(
      () => readFileSync(join(directory, "agent-results/agent-0002.json")),
      /ENOENT/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized replay journals fail closed before parsing", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-journal-read-"));
  try {
    writeFileSync(
      join(directory, "journal.json"),
      Buffer.alloc(JOURNAL_MAX_BYTES + 1, 0x20),
    );

    assert.equal(loadJournal(directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow persistence writes an accumulator's complete canonical journal", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-journal-write-"));
  try {
    const details = workflowDetails();
    const journal = createJournalAccumulator();
    journal.append({ key: "你好", output: "结果🙂" });
    journal.append({ key: "second", output: "complete" });

    persistWorkflowJson(directory, details, journal);

    const written = readFileSync(join(directory, "journal.json"), "utf8");
    assert.equal(written, journal.toJson());
    assert.deepEqual(JSON.parse(written), {
      version: 2,
      entries: [
        { key: "你好", output: "结果🙂" },
        { key: "second", output: "complete" },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow persistence keeps an empty journal artifact after all entries are evicted", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-empty-journal-"));
  try {
    const details = workflowDetails();
    const journal = createJournalAccumulator(1024);
    journal.append({ key: "too-big", output: "x".repeat(4 * 1024) });

    persistWorkflowJson(directory, details, journal);

    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "journal.json"), "utf8")),
      { version: 2, entries: [] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow persistence derives a non-authoritative graph from explicit result refs", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-graph-"));
  try {
    const details = workflowDetails();
    details.agents.push(
      {
        index: 1,
        callId: "wf_fixture:call:1",
        label: "source",
        state: "done",
        startedAt: 2,
        preview: "",
        usage: emptyUsage(),
        resultRef: "opaque-source",
        transcript: [],
      },
      {
        index: 2,
        callId: "wf_fixture:call:2",
        label: "target",
        state: "running",
        startedAt: 3,
        preview: "",
        usage: emptyUsage(),
        inputCallIds: ["wf_fixture:call:1"],
        transcript: [],
      },
    );

    persistWorkflowJson(directory, details);

    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.graph?.coverage, "explicit_result_refs_only");
    assert.deepEqual(stored.graph?.edges, [
      { source: "wf_fixture:call:1", target: "wf_fixture:call:2" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal persistence publishes status before dependent artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-terminal-commit-"));
  try {
    const details = workflowDetails();
    details.status = "failed";
    details.error = "artifact write failed";
    details.result = { partial: true };

    persistWorkflowJson(directory, details);

    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.status, "failed");
    assert.equal(stored.error, "artifact write failed");
    assert.equal(stored.resultArtifact, "result.json");
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "result.json"), "utf8")),
      { partial: true },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a dependent artifact write failure cannot leave the prior running manifest", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-workflow-terminal-failure-"),
  );
  try {
    const details = workflowDetails();
    details.status = "completed";
    details.finishedAt = 2;
    // The terminal manifest commits before this dependent artifact write.
    // A directory cannot be atomically replaced by the file writer.
    mkdirSync(join(directory, "transcripts.json"));

    assert.throws(
      () => persistWorkflowJson(directory, details),
      /EISDIR|EPERM|directory/i,
    );

    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.status, "completed");
    assert.equal(stored.resultArtifact, undefined);
    assert.equal(stored.transcriptArtifact, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal recovery state remains explained when dependent artifact writing fails", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-workflow-terminal-recovery-"),
  );
  try {
    const details = workflowDetails();
    details.status = "failed";
    details.error = "Artifact persistence failed: disk unavailable";
    persistWorkflowTerminalState(directory, details);

    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.status, "failed");
    assert.equal(stored.error, details.error);
    assert.equal(stored.resultArtifact, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal recovery preserves an aborted status while recording persistence failure", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-workflow-terminal-aborted-recovery-"),
  );
  try {
    const details = workflowDetails();
    details.status = "aborted";
    details.error = "Workflow was aborted by the user";
    persistWorkflowTerminalState(directory, details);

    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(stored.status, "aborted");
    assert.equal(stored.error, "Workflow was aborted by the user");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow checkpoints throttle updates and support immediate/final flushes", async () => {
  const details = workflowDetails();
  const snapshots: WorkflowDetails[] = [];
  const persistence = createWorkflowPersistence("fixture", details, {
    intervalMs: 15,
    persist: (_runDir, current) => snapshots.push(structuredClone(current)),
  });

  details.currentPhase = "Scan";
  persistence.checkpoint();
  details.currentPhase = "Review";
  persistence.checkpoint();
  assert.equal(snapshots.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.currentPhase, "Review");

  details.status = "completed";
  persistence.checkpoint({ immediate: true });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]?.status, "completed");

  details.finishedAt = 3;
  persistence.flush();
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[2]?.finishedAt, 3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(snapshots.length, 3);
});
