import { projectToolEvidence } from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
  WebSessionProjection,
} from "../../../../protocol/types.ts";

type ChangeCall = Extract<WebMessagePart, { type: "toolCall" }>;

export function changeCalls(session: WebSessionProjection) {
  const results = new Map<string, WebLiveMessage[]>();
  for (const entry of session.entries) {
    const message = entry.message;
    if (message?.role !== "toolResult" || !message.toolCallId) continue;
    const matches = results.get(message.toolCallId) ?? [];
    matches.push(message);
    results.set(message.toolCallId, matches);
  }

  const calls: Array<{ key: string; turn: number; call: ChangeCall }> = [];
  let turn = 0;
  for (const entry of session.entries) {
    const message = entry.message;
    if (message?.role === "user") turn++;
    if (message?.role !== "assistant") continue;
    for (const [index, part] of (message.parts ?? []).entries()) {
      if (part.type !== "toolCall" || !["write", "edit"].includes(part.name))
        continue;
      calls.push({ key: `${entry.id}:${index}`, turn, call: part });
    }
  }

  const counts = new Map<string, number>();
  for (const { call } of calls)
    if (call.id) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
  return calls.map((row) => ({
    ...row,
    result:
      row.call.id &&
      !row.call.id.includes("[truncated]") &&
      counts.get(row.call.id) === 1 &&
      results.get(row.call.id)?.length === 1
        ? results.get(row.call.id)?.[0]
        : undefined,
  }));
}

export function changeLineCounts(
  call: ReturnType<typeof changeCalls>[number]["call"],
  result: ReturnType<typeof changeCalls>[number]["result"],
) {
  const diff = projectToolEvidence(call, result).diff;
  if (!diff) return undefined;
  let additions = 0;
  let deletions = 0;
  const lines = diff.split("\n");
  const hasHunks = lines.some((line) => line.startsWith("@@"));
  let inHunk = !hasHunks;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return additions || deletions ? { additions, deletions } : undefined;
}

export function summarizeChangeCalls(
  rows: ReturnType<typeof changeCalls>,
  turn: number,
) {
  const files = new Map<
    string,
    { path: string; additions: number; deletions: number; hasCounts: boolean }
  >();
  for (const row of rows) {
    if (row.turn !== turn || row.result?.isError !== false) continue;
    const evidence = projectToolEvidence(row.call, row.result);
    if (!evidence.path || evidence.change === "unchanged") continue;
    const counts = changeLineCounts(row.call, row.result);
    const file = files.get(evidence.path) ?? {
      path: evidence.path,
      additions: 0,
      deletions: 0,
      hasCounts: false,
    };
    if (counts) {
      file.additions += counts.additions;
      file.deletions += counts.deletions;
      file.hasCounts = true;
    }
    files.set(evidence.path, file);
  }
  const items = [...files.values()];
  if (items.length === 0) return undefined;
  return {
    files: items,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    hasCounts: items.some((item) => item.hasCounts),
  };
}
