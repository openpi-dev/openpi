import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  WEB_MAX_GIT_REVIEW_DIFF_BYTES,
  WEB_MAX_GIT_REVIEW_FILES,
  WEB_MAX_SNAPSHOT_BYTES,
  type WebGitReviewFile,
  type WebGitReviewFileStatus,
  type WebGitReviewResult,
  type WebGitReviewSnapshot,
  jsonByteLength,
} from "../protocol/types.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GIT_REVIEW_BASELINE_VERSION = 1;

type GitEnvironment = Record<string, string | undefined>;

interface GitReviewBaselineMetadata {
  version: typeof GIT_REVIEW_BASELINE_VERSION;
  cwd: string;
  repositoryRoot?: string;
  repositoryObjects?: string;
  status:
    | "ready"
    | "not_git_repository"
    | "unborn_repository"
    | "git_failed";
}

export interface GitReviewService {
  capture(sessionPath: string, cwd: string): Promise<void>;
  read(sessionPath: string, cwd: string): Promise<WebGitReviewResult>;
}

async function git(cwd: string, args: string[], environment?: GitEnvironment) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        ...environment,
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "diff.external",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "diff.trustExitCode",
        GIT_CONFIG_VALUE_1: "false",
      },
    },
  );
  return stdout;
}

function cleanLine(value: string) {
  return value.trim() || null;
}

async function refExists(root: string, revision: string) {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", revision]);
    return true;
  } catch {
    return false;
  }
}

async function baseBranch(root: string, current: string | null) {
  const remoteHead = cleanLine(
    await git(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).catch(() => ""),
  );
  const candidates = [
    remoteHead,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (candidate === current) continue;
    if (await refExists(root, candidate)) return candidate;
  }
  return null;
}

function fileStatus(code: string): WebGitReviewFileStatus {
  if (code === "A") return "added";
  if (code === "M" || code === "T") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "unknown";
}

function parseNameStatus(output: string) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: Array<
    Pick<WebGitReviewFile, "path" | "previousPath" | "status">
  > = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++]?.charAt(0) ?? "";
    if (code === "R" || code === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) break;
      files.push({ path, previousPath, status: fileStatus(code) });
      continue;
    }
    const path = fields[index++];
    if (!path) break;
    files.push({ path, status: fileStatus(code) });
  }
  return files;
}

function splitDiff(diff: string) {
  if (!diff.trim()) return [];
  const starts: number[] = [];
  for (const match of diff.matchAll(/^diff --git /gmu)) starts.push(match.index);
  if (starts.length === 0) return [diff];
  return starts.map((start, index) =>
    diff.slice(start, starts[index + 1] ?? diff.length),
  );
}

export function countGitDiffLines(diff: string) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function dedupe(files: WebGitReviewFile[]) {
  const byPath = new Map<string, WebGitReviewFile>();
  for (const file of files) {
    const previous = byPath.get(file.path);
    if (!previous) {
      byPath.set(file.path, file);
      continue;
    }
    const diff = `${previous.diff}${file.diff}`;
    byPath.set(file.path, {
      ...file,
      previousPath: file.previousPath ?? previous.previousPath,
      diff,
      diffTruncated: file.diffTruncated || previous.diffTruncated,
      additions: previous.additions + file.additions,
      deletions: previous.deletions + file.deletions,
    });
  }
  return [...byPath.values()];
}

async function trackedChanges(
  root: string,
  comparisons: string[][],
  environment?: GitEnvironment,
) {
  const files: WebGitReviewFile[] = [];
  let diffBytes = 0;
  let truncated = false;
  for (const comparison of comparisons) {
    const [status, diff] = await Promise.all([
      git(root, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        ...comparison,
      ], environment),
      git(root, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--find-renames",
        "--full-index",
        ...comparison,
      ], environment),
    ]);
    const entries = parseNameStatus(status);
    const chunks = splitDiff(diff);
    for (const [index, entry] of entries.entries()) {
      const body = chunks[index] ?? "";
      if (files.length >= WEB_MAX_GIT_REVIEW_FILES) {
        truncated = true;
        break;
      }
      const bodyBytes = jsonByteLength(body);
      const includeDiff =
        diffBytes + bodyBytes <= WEB_MAX_GIT_REVIEW_DIFF_BYTES;
      files.push({
        ...entry,
        diff: includeDiff ? body : "",
        diffTruncated: !includeDiff,
        ...countGitDiffLines(body),
      });
      if (includeDiff) diffBytes += bodyBytes;
      else truncated = true;
    }
  }
  return { files: dedupe(files), diffBytes, truncated };
}

function untrackedDiff(path: string, bytes: Buffer) {
  const header = [`diff --git a/${path} b/${path}`, "new file mode 100644"];
  if (bytes.includes(0))
    return [...header, `Binary files /dev/null and b/${path} differ`, ""].join(
      "\n",
    );
  const text = bytes.toString("utf8").replace(/\r\n/gu, "\n");
  if (text.includes("\uFFFD"))
    return [...header, `Binary files /dev/null and b/${path} differ`, ""].join(
      "\n",
    );
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0)
    return [...header, "--- /dev/null", `+++ b/${path}`, ""].join("\n");
  return [
    ...header,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(text.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
    "",
  ].join("\n");
}

async function untrackedChanges(
  root: string,
  room: number,
  diffByteRoom: number,
  environment?: GitEnvironment,
) {
  const paths = (await git(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ], environment))
    .split("\0")
    .filter(Boolean);
  const files: WebGitReviewFile[] = [];
  let diffBytes = 0;
  let truncated = paths.length > room;
  for (const path of paths.slice(0, Math.max(0, room))) {
    const target = resolve(root, path);
    const child = relative(root, target);
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      truncated = true;
      continue;
    }
    let bytes: Buffer | null = null;
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile()) {
        truncated = true;
        continue;
      }
      if (metadata.size <= WEB_MAX_GIT_REVIEW_DIFF_BYTES)
        bytes = await readFile(target);
    } catch {
      truncated = true;
      continue;
    }
    const fullDiff = bytes ? untrackedDiff(path, bytes) : "";
    const fullDiffBytes = jsonByteLength(fullDiff);
    const includeDiff =
      bytes !== null && diffBytes + fullDiffBytes <= diffByteRoom;
    files.push({
      path,
      status: "untracked",
      diff: includeDiff ? fullDiff : "",
      diffTruncated: !includeDiff,
      ...countGitDiffLines(fullDiff),
    });
    if (includeDiff) diffBytes += fullDiffBytes;
    else truncated = true;
  }
  return { files, diffBytes, truncated };
}

function boundSnapshot(snapshot: WebGitReviewSnapshot) {
  while (
    jsonByteLength({ ok: true, snapshot }) > WEB_MAX_SNAPSHOT_BYTES &&
    snapshot.files.some((file) => file.diff)
  ) {
    let file: WebGitReviewFile | undefined;
    for (let index = snapshot.files.length - 1; index >= 0; index--) {
      const candidate = snapshot.files[index];
      if (!candidate?.diff) continue;
      file = candidate;
      break;
    }
    if (!file) break;
    file.diff = "";
    file.diffTruncated = true;
    snapshot.truncated = true;
  }
  while (
    jsonByteLength({ ok: true, snapshot }) > WEB_MAX_SNAPSHOT_BYTES &&
    snapshot.files.length > 0
  ) {
    snapshot.files.pop();
    snapshot.truncated = true;
  }
  snapshot.additions = snapshot.files.reduce(
    (total, file) => total + file.additions,
    0,
  );
  snapshot.deletions = snapshot.files.reduce(
    (total, file) => total + file.deletions,
    0,
  );
  return snapshot;
}

export async function readGitReview(
  cwd: string,
  options?: {
    baseline?: {
      index: string;
      objects: string;
      repositoryObjects: string;
    };
  },
): Promise<WebGitReviewResult> {
  try {
    const root = cleanLine(
      await git(cwd, ["rev-parse", "--show-toplevel"]),
    );
    if (!root) return { ok: false, reason: "not_git_repository" };
    const currentBranch = cleanLine(
      await git(root, ["branch", "--show-current"]),
    );
    const hasHead = await refExists(root, "HEAD");
    const environment = options?.baseline
      ? {
          GIT_INDEX_FILE: options.baseline.index,
          GIT_OBJECT_DIRECTORY: options.baseline.objects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: [
            options.baseline.repositoryObjects,
            process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
          ]
            .filter(Boolean)
            .join(delimiter),
        }
      : undefined;
    const base =
      !options?.baseline && hasHead
        ? await baseBranch(root, currentBranch)
        : null;
    const mergeBase =
      base && !options?.baseline
        ? cleanLine(await git(root, ["merge-base", base, "HEAD"]))
        : null;
    const tracked = await trackedChanges(
      root,
      options?.baseline
        ? [[]]
        : mergeBase
          ? [[mergeBase]]
          : [hasHead ? ["--cached"] : ["--cached", "--root"], []],
      environment,
    );
    const untracked = await untrackedChanges(
      root,
      WEB_MAX_GIT_REVIEW_FILES - tracked.files.length,
      WEB_MAX_GIT_REVIEW_DIFF_BYTES - tracked.diffBytes,
      environment,
    );
    const snapshot = boundSnapshot({
      repositoryRoot: root,
      currentBranch,
      baseBranch: base,
      comparison: options?.baseline ? "session" : "branch",
      revision: "0".repeat(64),
      files: dedupe([...tracked.files, ...untracked.files]),
      additions: 0,
      deletions: 0,
      truncated: tracked.truncated || untracked.truncated,
    });
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          root,
          currentBranch,
          base,
          files: snapshot.files.map(
            ({ path, previousPath, status, diff, diffTruncated }) => ({
              path,
              previousPath,
              status,
              diff,
              diffTruncated,
            }),
          ),
        }),
      )
      .digest("hex");
    snapshot.revision = revision;
    return {
      ok: true,
      snapshot,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/iu.test(message))
      return { ok: false, reason: "not_git_repository" };
    if (/bad revision|unknown revision|ambiguous argument 'HEAD'/iu.test(message))
      return { ok: false, reason: "unborn_repository" };
    return { ok: false, reason: "git_failed" };
  }
}

export class GitReviewBaselineStore implements GitReviewService {
  private readonly directory: string;
  private readonly captures = new Map<string, Promise<void>>();

  constructor(
    sessionDirectory: string,
    baselineDirectory = join(
      dirname(resolve(sessionDirectory)),
      ".openpi-git-review-baselines",
    ),
  ) {
    this.directory = baselineDirectory;
  }

  private key(sessionPath: string, cwd: string) {
    return createHash("sha256")
      .update(`${resolve(cwd)}\0${sessionPath}`)
      .digest("hex");
  }

  private paths(sessionPath: string, cwd: string) {
    const key = this.key(sessionPath, cwd);
    return {
      key,
      index: join(this.directory, `${key}.index`),
      objects: join(this.directory, `${key}.objects`),
      metadata: join(this.directory, `${key}.json`),
    };
  }

  private async metadata(path: string) {
    try {
      const value = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<GitReviewBaselineMetadata>;
      if (
        value.version !== GIT_REVIEW_BASELINE_VERSION ||
        typeof value.cwd !== "string" ||
        ![
          "ready",
          "not_git_repository",
          "unborn_repository",
          "git_failed",
        ].includes(value.status ?? "")
      ) {
        return undefined;
      }
      if (
        value.status === "ready" &&
        (typeof value.repositoryRoot !== "string" ||
          typeof value.repositoryObjects !== "string")
      ) {
        return undefined;
      }
      return value as GitReviewBaselineMetadata;
    } catch {
      return undefined;
    }
  }

  private async writeMetadata(
    path: string,
    metadata: GitReviewBaselineMetadata,
  ) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private failureReason(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/iu.test(message))
      return "not_git_repository" as const;
    if (/bad revision|unknown revision|ambiguous argument 'HEAD'/iu.test(message))
      return "unborn_repository" as const;
    return "git_failed" as const;
  }

  async capture(sessionPath: string, cwd: string) {
    const paths = this.paths(sessionPath, cwd);
    if (await this.metadata(paths.metadata)) return;
    const pending = this.captures.get(paths.key);
    if (pending) return pending;
    const capture = this.createBaseline(paths, cwd).finally(() => {
      this.captures.delete(paths.key);
    });
    this.captures.set(paths.key, capture);
    return capture;
  }

  private async createBaseline(
    paths: ReturnType<GitReviewBaselineStore["paths"]>,
    cwd: string,
  ) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const canonicalCwd = resolve(cwd);
    let repositoryRoot: string | undefined;
    let repositoryObjects: string | undefined;
    try {
      repositoryRoot =
        cleanLine(await git(canonicalCwd, ["rev-parse", "--show-toplevel"])) ??
        undefined;
      if (!repositoryRoot) throw new Error("not a git repository");
      const commonDirectory = cleanLine(
        await git(repositoryRoot, ["rev-parse", "--git-common-dir"]),
      );
      if (!commonDirectory) throw new Error("Git common directory unavailable");
      repositoryObjects = join(
        resolve(repositoryRoot, commonDirectory),
        "objects",
      );
      await mkdir(paths.objects, { recursive: true, mode: 0o700 });
      await chmod(paths.objects, 0o700);
      const temporaryIndex = `${paths.index}.${randomUUID()}.tmp`;
      try {
        const environment = {
          GIT_INDEX_FILE: temporaryIndex,
          GIT_OBJECT_DIRECTORY: paths.objects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: [
            repositoryObjects,
            process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
          ]
            .filter(Boolean)
            .join(delimiter),
        };
        if (await refExists(repositoryRoot, "HEAD"))
          await git(repositoryRoot, ["read-tree", "HEAD"], environment);
        else await git(repositoryRoot, ["read-tree", "--empty"], environment);
        await git(repositoryRoot, ["add", "-A", "--", "."], environment);
        await chmod(temporaryIndex, 0o600);
        await rename(temporaryIndex, paths.index);
      } finally {
        await rm(temporaryIndex, { force: true });
        await rm(`${temporaryIndex}.lock`, { force: true });
      }
      await this.writeMetadata(paths.metadata, {
        version: GIT_REVIEW_BASELINE_VERSION,
        cwd: canonicalCwd,
        repositoryRoot,
        repositoryObjects,
        status: "ready",
      });
    } catch (error) {
      await rm(paths.index, { force: true });
      await rm(paths.objects, { recursive: true, force: true });
      await this.writeMetadata(paths.metadata, {
        version: GIT_REVIEW_BASELINE_VERSION,
        cwd: canonicalCwd,
        ...(repositoryRoot ? { repositoryRoot } : {}),
        status: this.failureReason(error),
      });
    }
  }

  async read(sessionPath: string, cwd: string): Promise<WebGitReviewResult> {
    await this.capture(sessionPath, cwd);
    const paths = this.paths(sessionPath, cwd);
    const metadata = await this.metadata(paths.metadata);
    if (!metadata || metadata.status !== "ready") {
      const reason =
        metadata?.status === "not_git_repository" ||
        metadata?.status === "unborn_repository"
          ? metadata.status
          : "git_failed";
      return {
        ok: false,
        reason,
      };
    }
    try {
      await Promise.all([access(paths.index), access(paths.objects)]);
    } catch {
      return { ok: false, reason: "git_failed" };
    }
    const result = await readGitReview(cwd, {
      baseline: {
        index: paths.index,
        objects: paths.objects,
        repositoryObjects: metadata.repositoryObjects!,
      },
    });
    if (
      result.ok &&
      resolve(result.snapshot.repositoryRoot) !==
        resolve(metadata.repositoryRoot!)
    ) {
      return { ok: false, reason: "git_failed" };
    }
    return result;
  }
}
