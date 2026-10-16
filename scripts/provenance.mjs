import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const OPENPI_PACKAGE_NAME = "@tt-a1i/openpi";

export function normalizePath(value, base = ROOT) {
  const absolute = isAbsolute(value) ? value : resolve(base, value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return resolve(absolute);
  }
}

function readPackageName(directory) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    return typeof parsed?.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function collectReportedPaths(stdout = "", stderr = "") {
  const reportedLines = [
    ...stdout.split(/\r?\n/),
    ...stderr.split(/\r?\n/),
  ].map((line) => line.trim());
  const absoluteLines = reportedLines.filter((line) => isAbsolute(line));
  return (absoluteLines.length > 0 ? absoluteLines : reportedLines).filter(
    (line) =>
      line.length > 0 &&
      !/^(user|project) packages:$/i.test(line) &&
      /[\\/]/.test(line),
  );
}

export function evaluateOpenPiProvenance(
  reportedPaths,
  checkoutPath = ROOT,
  options = {},
) {
  const normalize = options.normalize ?? normalizePath;
  const packageName = options.packageName ?? OPENPI_PACKAGE_NAME;
  const readName = options.readPackageName ?? readPackageName;
  const checkout = normalize(checkoutPath);
  const sources = [];
  for (const reported of reportedPaths) {
    const source = normalize(reported);
    if (!sources.includes(source)) sources.push(source);
  }
  const openPiSources = sources.filter(
    (source) => source === checkout || readName(source) === packageName,
  );
  return {
    checkoutPath: checkout,
    openPiSources,
    matches: openPiSources.length === 1 && openPiSources[0] === checkout,
  };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return normalizePath(fileURLToPath(import.meta.url)) === normalizePath(entry);
}

if (invokedDirectly()) {
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

  const provenance = evaluateOpenPiProvenance(
    collectReportedPaths(piResult.stdout ?? "", piResult.stderr ?? ""),
    ROOT,
  );
  process.stdout.write(`Checkout revision: ${checkoutRevision}\n`);
  process.stdout.write(
    `OpenPI source reported by pi list: ${provenance.openPiSources.join(", ") || "none"}\n`,
  );
  process.stdout.write(
    `Provenance match: ${provenance.matches ? "yes" : "no"}\n`,
  );
  if (!provenance.matches) process.exitCode = 1;
}
