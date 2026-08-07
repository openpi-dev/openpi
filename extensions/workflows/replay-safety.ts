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
  return effectiveChildToolAllowlist(options.tools)?.every((tool) =>
    REPLAY_SAFE_TOOL_NAMES.has(tool),
  );
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

function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function canonicalPath(value: string) {
  return fs.realpathSync.native(value);
}

function repositoryFingerprint(cwd: string) {
  const root = canonicalPath(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const diff = git(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  const untrackedOutput = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untrackedOutput.includes("\uFFFD")) {
    throw new Error("untracked paths are not valid UTF-8");
  }

  const untracked = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((relativePath) => {
      const filePath = path.join(root, relativePath);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        return [relativePath, "symlink", fs.readlinkSync(filePath)] as const;
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
  return { path: canonical, content: digest(fs.readFileSync(canonical)) };
}

function resourceFingerprint(loader: ReplayResourceLoader) {
  const agentsFiles = loader
    .getAgentsFiles()
    .agentsFiles.map((file) => ({
      path: canonicalPath(file.path),
      content: digest(file.content),
    }))
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
