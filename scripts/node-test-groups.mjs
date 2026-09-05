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
