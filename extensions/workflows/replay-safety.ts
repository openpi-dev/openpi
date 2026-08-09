import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { effectiveChildToolAllowlist } from "../shared/child-session.ts";

const REPLAY_SAFE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
]);
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const REPLAY_IDENTITY_TIMEOUT_MS = 5_000;
const REPLAY_RESOURCE_FILE_LIMIT = 8 * 1024 * 1024;

/**
 * Replay is an allowlist, not a best guess. An omitted tool list inherits the
 * normal write-capable child tools, and an unfamiliar custom tool has unknown
 * effects, so both are non-replayable.
 */
export function isReplaySafeAgentCall(options: {
  tools?: readonly string[];
  isolation?: unknown;
}) {
  if (options.isolation !== undefined || options.tools === undefined) {
    return false;
  }
  return (
    effectiveChildToolAllowlist(options.tools)?.every((tool) =>
      REPLAY_SAFE_TOOL_NAMES.has(tool),
    ) === true
  );
}

export interface ReplayWorkspaceLease {
  /** A cache lookup is safe at this instant. */
  readonly canReplay: boolean;
  /** True only if no unsafe call overlapped this call's full execution. */
  canJournal(): boolean;
  end(): void;
}

/**
 * Endpoint fingerprints cannot detect an ABA write (change, observe, restore)
 * from a sibling workflow agent. Track every non-replay-safe call across its
 * whole scheduled lifetime and refuse hits/journaling across any overlap.
 */
export function createReplayWorkspaceGuard() {
  let epoch = 0;
  let activeUnsafe = 0;
  return {
    begin(replaySafe: boolean): ReplayWorkspaceLease {
      const startEpoch = epoch;
      const canReplay = replaySafe && activeUnsafe === 0;
      let ended = false;
      if (!replaySafe) {
        activeUnsafe += 1;
        epoch += 1;
      }
      return {
        canReplay,
        canJournal: () =>
          !ended &&
          replaySafe &&
          canReplay &&
          activeUnsafe === 0 &&
          epoch === startEpoch,
        end: () => {
          if (ended) return;
          ended = true;
          if (!replaySafe) {
            activeUnsafe -= 1;
            epoch += 1;
          }
        },
      };
    },
  };
}

interface ReplayResourceLoader extends Pick<
  DefaultResourceLoader,
  | "getAgentsFiles"
  | "getAppendSystemPrompt"
  | "getExtensions"
  | "getSkills"
  | "getSystemPrompt"
> {}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedGit(cwd: string, args: readonly string[], deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Replay identity deadline exceeded");
  const output = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: Math.min(remaining, REPLAY_IDENTITY_TIMEOUT_MS),
  });
  if (output.includes("\uFFFD")) {
    throw new Error("Git output contains a path that is not valid UTF-8");
  }
  return output;
}

function canonicalPath(value: string) {
  return fs.realpathSync.native(value);
}

function repositoryFingerprint(cwd: string) {
  const deadline = Date.now() + REPLAY_IDENTITY_TIMEOUT_MS;
  const git = (gitCwd: string, args: readonly string[]) =>
    boundedGit(gitCwd, args, deadline);
  const root = canonicalPath(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const diff = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "HEAD",
    "--",
  ]);
  const trackedModes = git(root, ["ls-files", "-s", "-z"]);
  // Tracked symlinks can expose changing content outside Git, while gitlinks
  // can expose submodule state absent from the parent diff. Neither has a
  // complete bounded identity here, so execute instead of replaying.
  if (
    trackedModes
      .split("\0")
      .some(
        (entry) => entry.startsWith("120000 ") || entry.startsWith("160000 "),
      )
  ) {
    throw new Error("symlinks and gitlinks make replay identity incomplete");
  }
  // Ignored files are observable to a read-capable child but are commonly too
  // large or secret-bearing to hash (node_modules, .env, build output). A
  // complete identity cannot pretend they do not exist, so disable replay.
  const ignoredOutput = git(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (ignoredOutput.length > 0) {
    throw new Error("ignored files make the replay identity incomplete");
  }
  const untrackedOutput = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untrackedOutput.includes("\uFFFD")) {
    throw new Error("untracked paths are not valid UTF-8");
  }

  let untrackedBytes = 0;
  const untracked = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((relativePath) => {
      const filePath = path.join(root, relativePath);
      const stat = fs.lstatSync(filePath);
      untrackedBytes += stat.size;
      if (untrackedBytes > GIT_OUTPUT_LIMIT) {
        throw new Error("untracked files exceed replay fingerprint limit");
      }
      if (stat.isSymbolicLink()) {
        throw new Error(
          `untracked symlink makes replay identity incomplete: ${relativePath}`,
        );
      }
      if (!stat.isFile()) {
        throw new Error(`unsupported untracked resource: ${relativePath}`);
      }
      return [relativePath, "file", digest(fs.readFileSync(filePath))] as const;
    });

  return digest(JSON.stringify({ root, head, diff: digest(diff), untracked }));
}

function resourceFile(pathname: string) {
  const canonical = canonicalPath(pathname);
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error(`resource is not a file: ${canonical}`);
  if (stat.size > REPLAY_RESOURCE_FILE_LIMIT) {
    throw new Error(`resource exceeds replay fingerprint limit: ${canonical}`);
  }
  return { path: canonical, content: digest(fs.readFileSync(canonical)) };
}

function resourceFingerprint(loader: ReplayResourceLoader) {
  const agentsFiles = loader
    .getAgentsFiles()
    .agentsFiles.map((file) => {
      if (
        Buffer.byteLength(file.content, "utf8") > REPLAY_RESOURCE_FILE_LIMIT
      ) {
        throw new Error(
          `agent resource exceeds replay fingerprint limit: ${file.path}`,
        );
      }
      return {
        path: canonicalPath(file.path),
        content: digest(file.content),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const skills = loader
    .getSkills()
    .skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      disabled: skill.disableModelInvocation,
      file: resourceFile(skill.filePath),
    }))
    .sort((left, right) =>
      `${left.name}\0${left.file.path}`.localeCompare(
        `${right.name}\0${right.file.path}`,
      ),
    );
  const extensions = loader
    .getExtensions()
    .extensions.map((extension) => resourceFile(extension.resolvedPath))
    .sort((left, right) => left.path.localeCompare(right.path));

  return digest(
    JSON.stringify({
      systemPrompt: loader.getSystemPrompt(),
      appendSystemPrompt: loader.getAppendSystemPrompt(),
      agentsFiles,
      skills,
      extensions,
    }),
  );
}

/**
 * Bind a replayable result to the actual project and prompt/resource inputs a
 * read-only child can observe. Any inability to prove that identity disables
 * replay and journaling for the call; execution itself still proceeds.
 */
export function createReplayIdentity(
  cwd: string,
  loader: ReplayResourceLoader,
  projectTrusted: boolean,
) {
  try {
    const canonicalCwd = canonicalPath(cwd);
    return {
      cwd: canonicalCwd,
      repository: repositoryFingerprint(canonicalCwd),
      resources: resourceFingerprint(loader),
      projectTrusted,
    };
  } catch {
    return undefined;
  }
}
