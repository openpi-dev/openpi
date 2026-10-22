import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebBuildInfo, WebRuntimeInfo } from "../protocol/runtime-info.ts";

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (statSync(path).size > 16 * 1024) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function captureRuntimeInfo(packageRoot: string): WebRuntimeInfo {
  const capturedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const manifest = readJson(join(packageRoot, "package.json"));
  const version = typeof manifest?.version === "string" && manifest.version.length <= 128
    ? manifest.version : null;
  const build = readJson(join(packageRoot, "web/dist/build-info.json"));
  const frontendAtStartup: WebBuildInfo | null = build?.mode === "production" &&
    typeof build.id === "string" && /^[a-f0-9]{64}$/u.test(build.id) &&
    typeof build.version === "string" && build.version.length <= 128
      ? { id: build.id, version: build.version, mode: "production" } : null;
  // Inspect this package, never the selected workspace or an inherited Git directory.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    "-C", packageRoot, ...args,
  ], { env, encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  let source: WebRuntimeInfo["git"] = null;
  try {
    // An npm installation inside another repository is not that repository's source.
    if (realpathSync(git("rev-parse", "--show-toplevel")) === realpathSync(packageRoot)) {
      const revision = git("rev-parse", "HEAD");
      if (/^[a-f0-9]{40,64}$/u.test(revision)) {
        let dirty: boolean | null = null;
        try { dirty = git("status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty") !== ""; } catch { /* Unknown is not clean. */ }
        source = { revision, dirty };
      }
    }
  } catch { /* Distribution packages and unavailable Git have no source revision. */ }
  return { version, packageRoot, startedAt, capturedAt, git: source, frontendAtStartup };
}

// Captured before the runtime starts; subsequent diagnostics never re-read disk.
export const webRuntimeStartup = captureRuntimeInfo(fileURLToPath(new URL("../../", import.meta.url)));
