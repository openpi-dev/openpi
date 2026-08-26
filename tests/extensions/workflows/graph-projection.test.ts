import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWorkflowGraph } from "../../../extensions/workflows/graph-projection.ts";

test("projects explicit result lineage into a stable directed graph", () => {
  const graph = projectWorkflowGraph([
    {
      callId: "build",
      index: 2,
      label: "Build",
      state: "running",
      admissionState: "admitted",
      executionState: "running",
      operatorKey: "map",
      inputCallIds: ["plan"],
      unrelatedPersistedField: "ignored",
    },
    {
      callId: "plan",
      index: 1,
      label: "Plan",
      state: "done",
      resultRef: "results/plan.json",
    },
  ]);

  assert.deepEqual(graph, {
    schemaVersion: 1,
    coverage: "explicit_result_refs_only",
    nodes: [
      {
        callId: "plan",
        index: 1,
        label: "Plan",
        state: "done",
        resultRef: "results/plan.json",
      },
      {
        callId: "build",
        index: 2,
        label: "Build",
        state: "running",
        admissionState: "admitted",
        executionState: "running",
        operatorKey: "map",
      },
    ],
    edges: [{ source: "plan", target: "build" }],
    roots: ["plan"],
    sinks: ["build"],
    diagnostics: [],
    omitted: { nodes: 0, edges: 0, diagnostics: 0 },
  });
});

test("diagnoses missing and duplicate references without throwing", () => {
  const graph = projectWorkflowGraph([
    { callId: "a", index: 3, label: "Legacy duplicate", state: "error" },
    { callId: "a", index: 1, label: "Canonical", state: "done" },
    {
      callId: "b",
      index: 2,
      label: "Consumer",
      state: "running",
      inputCallIds: ["missing", "a", "a"],
    },
  ]);

  assert.deepEqual(
    graph.nodes.map(({ callId, index, label }) => ({ callId, index, label })),
    [
      { callId: "a", index: 1, label: "Canonical" },
      { callId: "b", index: 2, label: "Consumer" },
    ],
  );
  assert.deepEqual(graph.edges, [{ source: "a", target: "b" }]);
  assert.deepEqual(graph.diagnostics, [
    {
      code: "duplicate_call_id",
      callId: "a",
      keptIndex: 1,
      duplicateIndex: 3,
    },
    { code: "missing_input_call", source: "missing", target: "b" },
    { code: "duplicate_input_call", source: "a", target: "b" },
  ]);
});

test("reports cycles while retaining their persisted edges", () => {
  const graph = projectWorkflowGraph([
    {
      callId: "c",
      index: 3,
      label: "C",
      state: "done",
      inputCallIds: ["b"],
    },
    {
      callId: "a",
      index: 1,
      label: "A",
      state: "done",
      inputCallIds: ["c"],
    },
    {
      callId: "b",
      index: 2,
      label: "B",
      state: "done",
      inputCallIds: ["a"],
    },
    { callId: "solo", index: 4, label: "Solo", state: "running" },
  ]);

  assert.deepEqual(graph.edges, [
    { source: "c", target: "a" },
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ]);
  assert.deepEqual(graph.roots, ["solo"]);
  assert.deepEqual(graph.sinks, ["solo"]);
  assert.deepEqual(graph.diagnostics, [
    { code: "cycle", callIds: ["a", "b", "c"] },
  ]);
});

test("bounds every collection and reports omitted graph data", () => {
  const graph = projectWorkflowGraph(
    [
      { callId: "a", index: 1, label: "A", state: "done" },
      {
        callId: "b",
        index: 2,
        label: "B",
        state: "done",
        inputCallIds: ["missing-1", "a", "missing-2"],
      },
      {
        callId: "c",
        index: 3,
        label: "C",
        state: "done",
        inputCallIds: ["b"],
      },
      {
        callId: "d",
        index: 4,
        label: "D",
        state: "done",
        inputCallIds: ["c"],
      },
    ],
    { maxNodes: 2, maxEdges: 1, maxDiagnostics: 1 },
  );

  assert.deepEqual(
    graph.nodes.map((node) => node.callId),
    ["a", "b"],
  );
  assert.deepEqual(graph.edges, [{ source: "a", target: "b" }]);
  assert.deepEqual(graph.roots, ["a"]);
  assert.deepEqual(graph.sinks, ["b"]);
  assert.deepEqual(graph.diagnostics, [
    { code: "missing_input_call", source: "missing-1", target: "b" },
  ]);
  assert.deepEqual(graph.omitted, { nodes: 2, edges: 2, diagnostics: 1 });
});
