/** Adapted from DeepSeek Harness timeline.ts at d743267388; see LICENSE.dsh. */
import type { TrajectoryNode } from "./trajectory.ts";

/** Equal-width record positions are independent of execution wall-clock time. */
export function trajectoryTimeline(nodes: readonly TrajectoryNode[]) {
  return nodes.map((node, index) => ({
    key: node.key,
    start: index,
    end: index + 1,
    lane:
      node.kind === "call" || node.kind === "result"
        ? 2
        : node.kind === "assistant"
          ? 1
          : 0,
    error:
      node.outcome === "error" ||
      (node.kind === "assistant" &&
        (node.message?.stopReason === "error" ||
          node.message?.stopReason === "aborted")),
  }));
}

/** Inclusive intersection mirrors the upstream overview's range selection. */
export function trajectoryRangeKeys(
  nodes: readonly TrajectoryNode[],
  range: { start: number; end: number } | null,
) {
  return range === null
    ? null
    : new Set(
        trajectoryTimeline(nodes)
          .filter((span) => span.start <= range.end && span.end >= range.start)
          .map((span) => span.key),
      );
}
