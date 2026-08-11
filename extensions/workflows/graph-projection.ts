/**
 * Read-only workflow lineage derived from persisted agent-like records.
 * This projection is descriptive only; it must not drive admission or execution.
 */

export interface WorkflowGraphRecord {
  readonly callId: string;
  readonly index: number;
  readonly label: string;
  readonly state: string;
  readonly admissionState?: string;
  readonly executionState?: string;
  readonly operatorKey?: string;
  readonly inputCallIds?: readonly string[];
  readonly resultRef?: string;
}

export interface WorkflowGraphNode {
  callId: string;
  index: number;
  label: string;
  state: string;
  admissionState?: string;
  executionState?: string;
  operatorKey?: string;
  resultRef?: string;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
}

export type WorkflowGraphDiagnostic =
  | {
      code: "duplicate_call_id";
      callId: string;
      keptIndex: number;
      duplicateIndex: number;
    }
  | { code: "missing_input_call"; source: string; target: string }
  | { code: "duplicate_input_call"; source: string; target: string }
  | { code: "cycle"; callIds: string[] };

export interface WorkflowGraphProjectionLimits {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxDiagnostics?: number;
}

export const WORKFLOW_GRAPH_MAX_NODES = 1_000;
export const WORKFLOW_GRAPH_MAX_EDGES = 4_000;
export const WORKFLOW_GRAPH_MAX_DIAGNOSTICS = 256;

function boundedLimit(value: number | undefined, maximum: number) {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function compareRecords(left: WorkflowGraphRecord, right: WorkflowGraphRecord) {
  const byIndex = left.index - right.index;
  if (byIndex !== 0) return byIndex;
  return left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0;
}

function toNode(record: WorkflowGraphRecord): WorkflowGraphNode {
  return {
    callId: record.callId,
    index: record.index,
    label: record.label,
    state: record.state,
    ...(record.admissionState !== undefined
      ? { admissionState: record.admissionState }
      : {}),
    ...(record.executionState !== undefined
      ? { executionState: record.executionState }
      : {}),
    ...(record.operatorKey !== undefined
      ? { operatorKey: record.operatorKey }
      : {}),
    ...(record.resultRef !== undefined ? { resultRef: record.resultRef } : {}),
  };
}

function findCycles(
  nodes: readonly WorkflowGraphNode[],
  edges: readonly WorkflowGraphEdge[],
) {
  const order = new Map(nodes.map((node, index) => [node.callId, index]));
  const adjacency = new Map(nodes.map((node) => [node.callId, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (callId: string) => {
    const index = nextIndex++;
    indexes.set(callId, index);
    lowLinks.set(callId, index);
    stack.push(callId);
    onStack.add(callId);

    for (const target of adjacency.get(callId) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(
          callId,
          Math.min(lowLinks.get(callId)!, lowLinks.get(target)!),
        );
      } else if (onStack.has(target)) {
        lowLinks.set(
          callId,
          Math.min(lowLinks.get(callId)!, indexes.get(target)!),
        );
      }
    }

    if (lowLinks.get(callId) !== indexes.get(callId)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== callId);

    const selfLoop =
      component.length === 1 && adjacency.get(callId)?.includes(callId);
    if (component.length > 1 || selfLoop) {
      component.sort((left, right) => order.get(left)! - order.get(right)!);
      cycles.push(component);
    }
  };

  for (const node of nodes) {
    if (!indexes.has(node.callId)) visit(node.callId);
  }
  cycles.sort((left, right) => order.get(left[0]!)! - order.get(right[0]!)!);
  return cycles.map((callIds): WorkflowGraphDiagnostic => ({
    code: "cycle",
    callIds,
  }));
}

export function projectWorkflowGraph<Record extends WorkflowGraphRecord>(
  records: readonly Record[],
  limits: WorkflowGraphProjectionLimits = {},
) {
  const maxNodes = boundedLimit(limits.maxNodes, WORKFLOW_GRAPH_MAX_NODES);
  const maxEdges = boundedLimit(limits.maxEdges, WORKFLOW_GRAPH_MAX_EDGES);
  const maxDiagnostics = boundedLimit(
    limits.maxDiagnostics,
    WORKFLOW_GRAPH_MAX_DIAGNOSTICS,
  );
  const sorted = [...records].sort(compareRecords);
  const diagnostics: WorkflowGraphDiagnostic[] = [];
  let diagnosticCount = 0;
  const addDiagnostic = (diagnostic: WorkflowGraphDiagnostic) => {
    diagnosticCount++;
    if (diagnostics.length < maxDiagnostics) diagnostics.push(diagnostic);
  };
  const canonical = new Map<string, WorkflowGraphRecord>();
  for (const record of sorted) {
    const kept = canonical.get(record.callId);
    if (kept) {
      addDiagnostic({
        code: "duplicate_call_id",
        callId: record.callId,
        keptIndex: kept.index,
        duplicateIndex: record.index,
      });
    } else {
      canonical.set(record.callId, record);
    }
  }

  const uniqueRecords = [...canonical.values()];
  const nodes = uniqueRecords.slice(0, maxNodes).map(toNode);
  const visibleCallIds = new Set(nodes.map((node) => node.callId));
  const edges: WorkflowGraphEdge[] = [];
  let edgeCount = 0;
  for (const record of uniqueRecords) {
    const seenInputs = new Set<string>();
    for (const source of record.inputCallIds ?? []) {
      if (seenInputs.has(source)) {
        addDiagnostic({
          code: "duplicate_input_call",
          source,
          target: record.callId,
        });
      } else if (!canonical.has(source)) {
        addDiagnostic({
          code: "missing_input_call",
          source,
          target: record.callId,
        });
      } else {
        edgeCount++;
        if (
          edges.length < maxEdges &&
          visibleCallIds.has(source) &&
          visibleCallIds.has(record.callId)
        ) {
          edges.push({ source, target: record.callId });
        }
      }
      seenInputs.add(source);
    }
  }
  for (const cycle of findCycles(nodes, edges)) addDiagnostic(cycle);
  const hasIncoming = new Set(edges.map((edge) => edge.target));
  const hasOutgoing = new Set(edges.map((edge) => edge.source));

  return {
    schemaVersion: 1 as const,
    coverage: "explicit_result_refs_only" as const,
    nodes,
    edges,
    roots: nodes
      .filter((node) => !hasIncoming.has(node.callId))
      .map((node) => node.callId),
    sinks: nodes
      .filter((node) => !hasOutgoing.has(node.callId))
      .map((node) => node.callId),
    diagnostics,
    omitted: {
      nodes: uniqueRecords.length - nodes.length,
      edges: edgeCount - edges.length,
      diagnostics: diagnosticCount - diagnostics.length,
    },
  };
}

export type WorkflowGraphProjection = ReturnType<typeof projectWorkflowGraph>;
