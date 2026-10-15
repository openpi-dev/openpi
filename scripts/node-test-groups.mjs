import { isAbsolute, relative, resolve, sep } from "node:path";

const backgroundTerminalsRoot = resolve(
  "tests",
  "extensions",
  "background-terminals",
);

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

function isBackgroundTerminalsTest(file) {
  const relativePath = relative(backgroundTerminalsRoot, file);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

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
    (isBackgroundTerminalsTest(file) ||
    file === setupIntegrationTest ||
    file === workflowExecutionTest ||
    file === gitInfoProcessTest
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
  return files.filter((_, fileIndex) => fileIndex % total === index - 1);
}
