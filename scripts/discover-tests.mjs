import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TEST_FILE_PATTERN = /\.(test|spec)\.ts$/;
const compareNames = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

export function discoverTestFiles(root = resolve("tests")) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => compareNames(a.name, b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        files.push(path);
      }
    }
  }

  visit(root);
  return files.sort((a, b) =>
    compareNames(relative(root, a), relative(root, b)),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.stdout.write(`${JSON.stringify(discoverTestFiles())}\n`);
}
