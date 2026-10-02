import { isAbsolute, relative, resolve, sep } from "node:path";

const backgroundTerminalsRoot = resolve(
  "tests",
  "extensions",
  "background-terminals",
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
    (isBackgroundTerminalsTest(file) ? serial : parallel).push(file);
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
