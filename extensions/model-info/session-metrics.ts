import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

type SessionMetricsManager = {
  getSessionId(): string;
  getLeafId(): string | null;
  getEntry(id: string): SessionEntry | undefined;
};

type PrefixMetrics = Readonly<{
  cost: number;
  cacheRead: number;
  promptTokens: number;
}>;

const EMPTY_PREFIX: PrefixMetrics = Object.freeze({
  cost: 0,
  cacheRead: 0,
  promptTokens: 0,
});

function getUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message") {
    return entry.message.role === "assistant" ||
      entry.message.role === "toolResult"
      ? entry.message.usage
      : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
}

function addUsage(prefix: PrefixMetrics, entry: SessionEntry): PrefixMetrics {
  const usage = getUsage(entry);
  if (!usage) return prefix;
  return Object.freeze({
    cost: prefix.cost + usage.cost.total,
    cacheRead: prefix.cacheRead + usage.cacheRead,
    promptTokens:
      prefix.promptTokens + usage.input + usage.cacheRead + usage.cacheWrite,
  });
}

function toMetrics(prefix: PrefixMetrics) {
  return {
    cost: prefix.cost,
    cachePercent:
      prefix.promptTokens > 0
        ? (prefix.cacheRead / prefix.promptTokens) * 100
        : null,
  };
}

export function createSessionMetricsTracker() {
  let sessionId: string | undefined;
  let prefixes = new Map<string, PrefixMetrics>();

  const reset = () => {
    sessionId = undefined;
    prefixes = new Map();
  };

  const sync = (manager: SessionMetricsManager) => {
    const nextSessionId = manager.getSessionId();
    if (sessionId !== nextSessionId) reset();
    sessionId = nextSessionId;

    const leafId = manager.getLeafId();
    if (!leafId) return toMetrics(EMPTY_PREFIX);

    const cachedLeaf = prefixes.get(leafId);
    if (cachedLeaf) return toMetrics(cachedLeaf);

    const suffix: SessionEntry[] = [];
    let currentId: string | null = leafId;
    while (currentId && !prefixes.has(currentId)) {
      const entry = manager.getEntry(currentId);
      if (!entry) break;
      suffix.push(entry);
      currentId = entry.parentId;
    }

    let prefix = currentId
      ? (prefixes.get(currentId) ?? EMPTY_PREFIX)
      : EMPTY_PREFIX;
    for (const entry of suffix.reverse()) {
      prefix = addUsage(prefix, entry);
      prefixes.set(entry.id, prefix);
    }

    return toMetrics(prefixes.get(leafId) ?? EMPTY_PREFIX);
  };

  return { sync, reset };
}
