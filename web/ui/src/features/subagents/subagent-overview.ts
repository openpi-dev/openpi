import type { WebSubagentActivity } from "../../../../../extensions/shared/web-observer-registry.ts";
import type { RecordedSubagent } from "./recorded-subagents.ts";

/** One display projection for the summary and list; saved running receipts are not live evidence. */
export function subagentOverview(
  items: readonly WebSubagentActivity[],
  records: readonly RecordedSubagent[],
) {
  const liveIds = new Set(items.map((item) => item.id));
  return [
    ...items.map((item) => ({
      id: item.id,
      title: item.title,
      state:
        item.outcome === "interrupted" ? ("interrupted" as const) : item.status,
      timestamp: item.settledAt ?? item.createdAt,
      saved: false,
    })),
    ...records
      .filter((record) => !liveIds.has(record.id))
      .map((record) => ({
        id: record.id,
        title: record.title,
        state: record.state === "running" ? undefined : record.state,
        timestamp: undefined,
        saved: true,
      })),
  ].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}
