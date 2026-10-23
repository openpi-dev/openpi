import { resolve } from "node:path";

// This fixture starts a real Pi host in a subprocess with an 8-second bound.
// Under the Windows parallel suite, cold extension loading can consume that
// bound. Reuse the isolated-process group without extending test deadlines.
const setupIntegrationTest = resolve(
  "tests",
  "extensions",
  "setup",
  "integration.test.ts",
);
// Real sandbox subprocesses have short execution watchdogs. Keep their cold
// Windows startup isolated without increasing the runtime's timeout budget.
const workflowExecutionTest = resolve(
  "tests",
  "extensions",
  "workflows",
  "execute.e2e.test.ts",
);
// These real Node subprocesses also use a one-second execution watchdog.
const gitInfoProcessTest = resolve(
  "tests",
  "extensions",
  "git-info",
  "process.test.ts",
);
// This real Pi fixture launches PowerShell and Node behind a socket gate.
// Keep cold Windows startup out of the parallel shards without weakening its
// ordering assertions or extending its 15-second watchdog.
const postEditLifecycleTest = resolve(
  "tests",
  "extensions",
  "post-edit",
  "lifecycle.test.ts",
);

// Approximate top-level case seconds from the successful Windows Node 22.19
// run on b2a82fc6 (Actions 39896318175). These are scheduling hints, never
// selection rules: new/unmeasured files still run with weight 1. Start expensive
// files first and spread their cost across VMs instead of depending on parity
// in the discovery list. Keep watchdog-sensitive process fixtures isolated.
const windowsTestCosts = new Map(
  [
    ["tests/web/session-worktree.test.ts", 151],
    ["tests/web/session-fork.test.ts", 81],
    ["tests/extensions/shared/setup-config.test.ts", 67],
    ["tests/web/git-review.test.ts", 32],
    ["tests/extensions/workflows/worktree-handoff.test.ts", 31],
    ["tests/web/pi-adapter.test.ts", 27],
    ["tests/extensions/shared/worktree.test.ts", 19],
    ["tests/extensions/workflows/replay-safety.test.ts", 19],
    ["tests/extensions/shared/child-session.test.ts", 15],
    ["tests/extensions/workflows/sandbox.test.ts", 15],
    ["tests/web/turn-changes.test.ts", 14],
    ["tests/extensions/shared/native-skills.test.ts", 13],
  ].map(([file, cost]) => [resolve(file), cost]),
);

export function partitionNodeTestsByPlatform(
  files,
  platform = process.platform,
) {
  if (platform !== "win32") {
    return { parallel: files, serial: [] };
  }

  const parallel = [];
  const serial = [];
  for (const file of files) {
    (file === setupIntegrationTest ||
    file === workflowExecutionTest ||
    file === gitInfoProcessTest ||
    file === postEditLifecycleTest
      ? serial
      : parallel
    ).push(file);
  }
  return { parallel, serial };
}

export function selectNodeTestShard(files, shard) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index > total ||
    total > files.length
  ) {
    throw new Error(
      "Invalid Node test shard: expected index/total with no empty shards.",
    );
  }
  const weighted = files
    .map((file) => ({ file, cost: windowsTestCosts.get(file) ?? 1 }))
    .sort((a, b) => b.cost - a.cost);
  const shards = Array.from({ length: total }, () => ({ files: [], cost: 0 }));
  for (const { file, cost } of weighted) {
    const target = shards.reduce((best, shard) =>
      shard.cost < best.cost ? shard : best,
    );
    target.files.push(file);
    target.cost += cost;
  }
  return shards[index - 1].files;
}
