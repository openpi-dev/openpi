import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizePath(value, base) {
  const absolute = isAbsolute(value) ? value : resolve(base, value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return resolve(absolute);
  }
}

const checkoutRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

const localPi = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pi.exe" : "pi",
);
const piCommand = existsSync(localPi)
  ? localPi
  : (process.env.OPENPI_PI_BIN ??
    (process.platform === "win32" ? "pi.exe" : "pi"));
const piResult = spawnSync(piCommand, ["list"], {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
});
if (piResult.error || piResult.status !== 0) {
  throw new Error(
    `pi list failed: ${piResult.error?.message ?? piResult.stderr ?? "unknown error"}`,
  );
}

const reportedLines = [
  ...(piResult.stdout ?? "").split(/\r?\n/),
  ...(piResult.stderr ?? "").split(/\r?\n/),
].map((line) => line.trim());
const absoluteLines = reportedLines.filter((line) => isAbsolute(line));
const reportedPaths = (absoluteLines.length > 0 ? absoluteLines : reportedLines)
  .map((line) => line.trim())
  .filter(
    (line) =>
      line.length > 0 &&
      !/^(user|project) packages:$/i.test(line) &&
      /[\\/]/.test(line),
  )
  .map((line) => normalizePath(line, ROOT));
const sources = [...new Set(reportedPaths)];
const openPiSources = sources.filter((source) => /openpi/i.test(source));
const checkoutPath = normalizePath(ROOT, ROOT);
const matches = openPiSources.length === 1 && openPiSources[0] === checkoutPath;

process.stdout.write(`Checkout revision: ${checkoutRevision}\n`);
process.stdout.write(
  `OpenPI source reported by pi list: ${openPiSources.join(", ") || "none"}\n`,
);
process.stdout.write(`Provenance match: ${matches ? "yes" : "no"}\n`);
if (!matches) process.exitCode = 1;
