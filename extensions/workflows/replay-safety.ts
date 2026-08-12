import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DefaultResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { effectiveChildToolAllowlist } from "../shared/child-session.ts";

const REPLAY_FILESYSTEM_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
]);
const REPLAY_BUILTIN_FILESYSTEM_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
]);
const REPLAY_PACKAGE_FILESYSTEM_TOOL_NAMES = new Set(["fd", "rg"]);
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
      REPLAY_FILESYSTEM_TOOL_NAMES.has(tool),
    ) === true
  );
}

interface ReplayFilesystemToolRegistry {
  getAllTools(): Array<{
    name: string;
    sourceInfo?: {
      path: string;
      source: string;
      origin: string;
    };
  }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

class ReplayFilesystemBoundaryViolation extends Error {}

interface ReplayFilesystemObservation {
  lexicalPath: string;
  canonicalPath: string;
  revision: string;
}

function pathIsWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function filesystemRevision(pathname: string) {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    return [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  } catch {
    throw new ReplayFilesystemBoundaryViolation();
  }
}

function observeReplayFilesystemPath(
  repositoryRoot: string,
  lexicalPath: string,
): ReplayFilesystemObservation {
  let canonical: string;
  try {
    canonical = canonicalPath(lexicalPath);
  } catch {
    throw new ReplayFilesystemBoundaryViolation();
  }
  if (!pathIsWithin(repositoryRoot, canonical)) {
    throw new ReplayFilesystemBoundaryViolation();
  }
  return {
    lexicalPath,
    canonicalPath: canonical,
    revision: filesystemRevision(canonical),
  };
}

function assertReplayFilesystemObservationStable(
  repositoryRoot: string,
  previous: ReplayFilesystemObservation,
) {
  const current = observeReplayFilesystemPath(
    repositoryRoot,
    previous.lexicalPath,
  );
  if (
    current.canonicalPath !== previous.canonicalPath ||
    current.revision !== previous.revision
  ) {
    throw new ReplayFilesystemBoundaryViolation();
  }
}

function normalizedObservationPath(raw: string) {
  let normalized = raw.trim();
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  normalized = normalized.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
  if (normalized === "~") return homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return path.join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      throw new ReplayFilesystemBoundaryViolation();
    }
  }
  return normalized;
}

function hasPathParameter(definition: ToolDefinition) {
  if (!definition.parameters || typeof definition.parameters !== "object") {
    return false;
  }
  const properties = (definition.parameters as { properties?: unknown })
    .properties;
  return (
    properties !== null &&
    typeof properties === "object" &&
    Object.hasOwn(properties, "path")
  );
}

function hasKnownReplayFilesystemImplementation(tool: {
  name: string;
  sourceInfo?: { path: string; source: string; origin: string };
}) {
  if (REPLAY_BUILTIN_FILESYSTEM_TOOL_NAMES.has(tool.name)) {
    return (
      tool.sourceInfo?.source === "builtin" &&
      tool.sourceInfo.path === `<builtin:${tool.name}>`
    );
  }
  if (!REPLAY_PACKAGE_FILESYSTEM_TOOL_NAMES.has(tool.name)) return false;
  return (
    tool.sourceInfo?.origin === "package" &&
    tool.sourceInfo.path
      .split(path.sep)
      .join("/")
      .endsWith("/extensions/file-search/index.ts")
  );
}

export interface ReplayFilesystemBoundaryOptions {
  repositoryRoot: string;
  cwd: string;
  onViolation?: () => void;
}

/**
 * Replayable filesystem tools are confined to existing canonical paths in the
 * repository. Lexical containment rejects absolute, ~, and ../ escapes before
 * they can observe the external filesystem; realpath containment rejects
 * in-repository symlinks that escape. Unknown tool implementations and paths
 * that cannot be canonicalized are denied rather than guessed safe.
 *
 * This is not an OS-atomic filesystem sandbox. The process-wide Workflow lease
 * excludes known in-process writers, and the before/after path revision check
 * rejects endpoint changes during execution. An unrelated external process can
 * still perform an undetectable ABA change between those checks.
 */
export function createReplayFilesystemBoundary(
  options: ReplayFilesystemBoundaryOptions,
) {
  const repositoryRoot = canonicalPath(options.repositoryRoot);
  const cwd = canonicalPath(options.cwd);
  if (!pathIsWithin(repositoryRoot, cwd)) {
    throw new Error("Replay cwd is outside the canonical repository");
  }
  const wrapped = new WeakSet<ToolDefinition>();

  const deny = () => {
    options.onViolation?.();
    throw new Error(
      "Replay filesystem boundary blocked an external, changing, symlink-escaping, or unverifiable path.",
    );
  };

  const boundedParams = (toolName: string, params: unknown) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new ReplayFilesystemBoundaryViolation();
    }
    const input = params as Record<string, unknown>;
    const rawPath = input.path;
    if (rawPath === undefined) {
      if (toolName === "read") {
        throw new ReplayFilesystemBoundaryViolation();
      }
      return {
        params,
        observation: observeReplayFilesystemPath(repositoryRoot, cwd),
      };
    }
    if (typeof rawPath !== "string") {
      throw new ReplayFilesystemBoundaryViolation();
    }

    const normalized = normalizedObservationPath(rawPath);
    const lexicalPath = path.resolve(cwd, normalized);
    if (!pathIsWithin(repositoryRoot, lexicalPath)) {
      throw new ReplayFilesystemBoundaryViolation();
    }

    const observation = observeReplayFilesystemPath(
      repositoryRoot,
      lexicalPath,
    );
    return {
      params: {
        ...input,
        path: path.isAbsolute(normalized)
          ? observation.canonicalPath
          : path.relative(cwd, observation.canonicalPath) || ".",
      },
      observation,
    };
  };

  const wrap = (
    tool: ReturnType<ReplayFilesystemToolRegistry["getAllTools"]>[number],
    definition: ToolDefinition,
  ) => {
    if (wrapped.has(definition)) return;
    wrapped.add(definition);
    const knownImplementation =
      definition.name === tool.name &&
      hasPathParameter(definition) &&
      hasKnownReplayFilesystemImplementation(tool);
    const execute = definition.execute;
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      try {
        if (!knownImplementation) {
          throw new ReplayFilesystemBoundaryViolation();
        }
        const bounded = boundedParams(tool.name, params);
        try {
          return await execute.call(
            definition,
            toolCallId,
            bounded.params,
            signal,
            onUpdate,
            ctx,
          );
        } finally {
          assertReplayFilesystemObservationStable(
            repositoryRoot,
            bounded.observation,
          );
        }
      } catch (error) {
        if (error instanceof ReplayFilesystemBoundaryViolation) return deny();
        throw error;
      }
    };
  };

  return {
    apply(registry: ReplayFilesystemToolRegistry) {
      for (const tool of registry.getAllTools()) {
        if (!REPLAY_FILESYSTEM_TOOL_NAMES.has(tool.name)) continue;
        const definition = registry.getToolDefinition(tool.name);
        if (definition) wrap(tool, definition);
      }
    },
  };
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
 * from any Workflow agent in this process. Track every non-replay-safe call
 * across its whole scheduled lifetime and refuse hits/journaling across overlap.
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

// One process-global coordinator also survives duplicate extension module
// instances and hot reloads. It is deliberately conservative across unrelated
// repositories: correctness beats a replay hit, and this avoids another
// lifecycle-sensitive workspace registry.
const PROCESS_REPLAY_WORKSPACE_GUARD_KEY =
  "__ttA1iMyPiSetupReplayWorkspaceGuard" as const;
type ReplayProcessGlobal = typeof globalThis & {
  [PROCESS_REPLAY_WORKSPACE_GUARD_KEY]?: ReturnType<
    typeof createReplayWorkspaceGuard
  >;
};
const replayProcessGlobal = globalThis as ReplayProcessGlobal;
const processReplayWorkspaceGuard = (replayProcessGlobal[
  PROCESS_REPLAY_WORKSPACE_GUARD_KEY
] ??= createReplayWorkspaceGuard());

export function beginProcessReplayWorkspaceLease(replaySafe: boolean) {
  return processReplayWorkspaceGuard.begin(replaySafe);
}

interface ReplayResourceLoader
  extends Pick<
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

  return {
    root,
    fingerprint: digest(
      JSON.stringify({ root, head, diff: digest(diff), untracked }),
    ),
  };
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
    const repository = repositoryFingerprint(canonicalCwd);
    return {
      version: 3,
      cwd: canonicalCwd,
      repositoryRoot: repository.root,
      repository: repository.fingerprint,
      resources: resourceFingerprint(loader),
      projectTrusted,
    };
  } catch {
    return undefined;
  }
}
