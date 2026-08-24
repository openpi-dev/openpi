export interface ParentContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
}

export interface ResultBudgetPolicy {
  readonly maxBatchBytes: number;
  readonly maxResultBytes: number;
  readonly minResultBytes: number;
  readonly headroomShare: number;
  readonly estimatedBytesPerToken: number;
  /** Batch metadata that consumes the same parent-context headroom. */
  readonly fixedBytes?: number;
}

export interface ResultBudgetAllocation {
  readonly budgets: readonly number[];
  readonly batchBytes: number;
  readonly source: "static" | "dynamic";
}

function validUsage(
  usage: ParentContextUsage | null | undefined,
): usage is { readonly tokens: number; readonly contextWindow: number } {
  return Boolean(
    usage &&
      typeof usage.tokens === "number" &&
      Number.isFinite(usage.tokens) &&
      usage.tokens >= 0 &&
      Number.isFinite(usage.contextWindow) &&
      usage.contextWindow > 0,
  );
}

function distribute(
  desired: readonly number[],
  batchBytes: number,
  minResultBytes: number,
) {
  const budgets = desired.map((bytes) => Math.min(bytes, minResultBytes));
  let remaining = Math.max(
    0,
    batchBytes - budgets.reduce((sum, bytes) => sum + bytes, 0),
  );
  let active = desired
    .map((bytes, index) => ({ bytes, index }))
    .filter(({ bytes, index }) => bytes > budgets[index]!);

  while (remaining > 0 && active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share === 0) {
      for (const { bytes, index } of active) {
        if (remaining === 0) break;
        if (budgets[index]! >= bytes) continue;
        budgets[index]! += 1;
        remaining--;
      }
      break;
    }

    const satisfied = active.filter(
      ({ bytes, index }) => bytes - budgets[index]! <= share,
    );
    if (satisfied.length > 0) {
      for (const { bytes, index } of satisfied) {
        const addition = bytes - budgets[index]!;
        budgets[index]! = bytes;
        remaining -= addition;
      }
      const settled = new Set(satisfied.map(({ index }) => index));
      active = active.filter(({ index }) => !settled.has(index));
      continue;
    }

    for (const { index } of active) budgets[index]! += share;
    remaining -= share * active.length;
  }

  return budgets;
}

/**
 * Allocate one bounded projection budget per result. Small results yield their
 * unused share to larger siblings. Parent context usage is optional: Pi marks
 * it unknown after compaction until a fresh response, in which case the
 * deterministic static batch cap remains the source of truth.
 */
export function allocateResultBudgets(
  resultBytes: readonly number[],
  usage: ParentContextUsage | null | undefined,
  policy: ResultBudgetPolicy,
): ResultBudgetAllocation {
  if (resultBytes.length === 0) {
    return { budgets: [], batchBytes: 0, source: "static" };
  }

  const desired = resultBytes.map((bytes) =>
    Math.min(policy.maxResultBytes, Math.max(0, Math.floor(bytes))),
  );
  const perResultFloor = Math.min(
    policy.minResultBytes,
    Math.floor(policy.maxBatchBytes / resultBytes.length),
  );
  const desiredTotal = desired.reduce((sum, bytes) => sum + bytes, 0);
  const staticBatchBytes = Math.min(policy.maxBatchBytes, desiredTotal);
  const minimumBatchBytes = desired.reduce(
    (sum, bytes) => sum + Math.min(bytes, perResultFloor),
    0,
  );

  let batchBytes = staticBatchBytes;
  let source: ResultBudgetAllocation["source"] = "static";
  if (validUsage(usage)) {
    const headroomTokens = Math.max(0, usage.contextWindow - usage.tokens);
    const dynamicBytes = Math.max(
      0,
      Math.floor(
        headroomTokens * policy.headroomShare * policy.estimatedBytesPerToken,
      ) - Math.max(0, policy.fixedBytes ?? 0),
    );
    const narrowed = Math.max(
      minimumBatchBytes,
      Math.min(staticBatchBytes, dynamicBytes),
    );
    if (narrowed < staticBatchBytes) source = "dynamic";
    batchBytes = narrowed;
  }

  return {
    budgets: distribute(desired, batchBytes, perResultFloor),
    batchBytes,
    source,
  };
}
