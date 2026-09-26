import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
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
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  WEB_MAX_GIT_REVIEW_DIFF_BYTES,
  WEB_MAX_GIT_REVIEW_FILES,
  WEB_MAX_SNAPSHOT_BYTES,
  type WebGitReviewFile,
  type WebGitReviewFileStatus,
  type WebGitReviewResult,
  type WebGitReviewSnapshot,
  type WebGitReviewSource,
  jsonByteLength,
} from "../protocol/types.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GIT_REVIEW_BASELINE_VERSION = 2;
export const GIT_REVIEW_MAX_BASELINES = 64;
export const GIT_REVIEW_MAX_BASELINE_BYTES = 4 * 1024 * 1024;
export const GIT_REVIEW_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type GitEnvironment = Record<string, string | undefined>;

interface GitReviewBaselineMetadata {
  version: typeof GIT_REVIEW_BASELINE_VERSION;
  sessionPath: string;
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
  read(sessionPath: string, cwd: string, options?: GitReviewReadOptions): Promise<WebGitReviewResult>;
  dispose?(): Promise<void>;
}

/** An isolated, pre-turn worktree state. Never falls back to a later capture. */
export interface GitTurnChangeCapture {
  read(): Promise<WebGitReviewResult>;
  dispose(): Promise<void>;
}

export async function captureGitTurnChanges(sessionPath: string, cwd: string, maxBaselineBytes = GIT_REVIEW_MAX_TOTAL_BYTES): Promise<GitTurnChangeCapture> {
  const directory = await mkdtemp(join(tmpdir(), "openpi-turn-changes-"));
  const store = new GitReviewBaselineStore(directory, join(directory, "baseline"), {
    maxBaselines: 1,
    maxBaselineBytes,
  });
  try {
    await store.capture(sessionPath, cwd);
    const captured = await store.readCaptured(sessionPath, cwd, { summary: true });
    if (!captured.ok) throw new Error(`Turn baseline unavailable: ${captured.reason}`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    read: () => disposed
      ? Promise.resolve({ ok: false, reason: "baseline_unavailable" })
      : store.readCaptured(sessionPath, cwd),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface GitReviewReadOptions {
  source?: WebGitReviewSource;
  filePath?: string;
  summary?: boolean;
}

interface GitReviewBaselineLimits {
  maxBaselines?: number;
  maxBaselineBytes?: number;
  maxTotalBytes?: number;
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

function canonicalSessionPath(path: string) {
  return path.startsWith("current:") ? path : resolve(path);
}

async function pathBytes(path: string, limit = Number.POSITIVE_INFINITY) {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    return 0;
  }
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    total += await pathBytes(join(path, entry.name), limit - total);
    if (total > limit) break;
  }
  return total;
}

async function dirtyWorkingTreeBytes(root: string, limit: number) {
  const hasHead = await refExists(root, "HEAD");
  const tracked = await git(
    root,
    hasHead
      ? ["diff", "--name-only", "-z", "HEAD", "--"]
      : ["ls-files", "-z", "--cached"],
  );
  const untracked = await git(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  const paths = new Set(
    `${tracked}${untracked}`.split("\0").filter(Boolean),
  );
  let total = 0;
  for (const path of paths) {
    const target = resolve(root, path);
    const child = relative(root, target);
    if (!child || child.startsWith("..") || isAbsolute(child)) continue;
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile()) continue;
      total += metadata.size;
      if (total >= limit) break;
    } catch {
      // Deleted files do not add objects to the isolated baseline.
    }
  }
  return total;
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

function parseRawStatus(output: string) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: Array<
    Pick<WebGitReviewFile, "path" | "previousPath" | "status">
  > = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++]?.split(" ").at(-1)?.charAt(0) ?? "";
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
  options: GitReviewReadOptions = {},
) {
  const files: WebGitReviewFile[] = [];
  let diffBytes = 0;
  let truncated = false;
  const identity = createHash("sha256");
  for (const comparison of comparisons) {
    const flags = [
      "--no-color", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--full-index", "--no-abbrev", "-z",
    ];
    const raw = () => git(root, ["diff", ...flags, "--raw", ...comparison, "--"], environment);
    let status: string;
    let diff: string;
    if (options.summary) {
      [status, diff] = await Promise.all([
        raw(),
        git(root, ["diff", ...flags, "--numstat", ...comparison, "--"], environment),
      ]);
    } else {
      let paths: string[] = [];
      if (options.filePath) {
        // Discover renames before applying a pathspec: filtering to the new
        // path first removes the source from Git's rename detection.
        const selected = parseRawStatus(await raw()).filter(file => file.path === options.filePath);
        paths = [...new Set(selected.flatMap(file => file.previousPath ? [file.previousPath, file.path] : [file.path]))];
        if (paths.length === 0) continue;
      }
      const output = await git(root, [
        "diff", ...flags, "--raw", "--patch", ...comparison, "--",
        ...paths.map(path => `:(literal)${path}`),
      ], environment);
      // Git separates NUL-delimited raw records from the patch with an extra
      // NUL. Both projections now describe the same native diff invocation.
      const separator = output.indexOf("\0\0");
      if (output && separator < 0) throw new Error("Missing Git raw/patch boundary");
      status = separator < 0 ? "" : output.slice(0, separator + 1);
      diff = separator < 0 ? "" : output.slice(separator + 2);
    }
    identity.update(JSON.stringify(comparison)).update("\0").update(status).update("\0");
    const entries = parseRawStatus(status);
    const chunks = options.summary ? [] : splitDiff(diff);
    const stats = new Map<string, { additions: number; deletions: number }>();
    if (options.summary) {
      const records = diff.split("\0");
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        const first = record.indexOf("\t");
        const second = record.indexOf("\t", first + 1);
        if (first < 0 || second < 0) continue;
        let path = record.slice(second + 1);
        if (!path) { index++; path = records[++index] ?? ""; }
        stats.set(path, { additions: Number(record.slice(0, first)) || 0, deletions: Number(record.slice(first + 1, second)) || 0 });
      }
    }
    for (const [index, entry] of entries.entries()) {
      if (options.filePath && entry.path !== options.filePath) continue;
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
        ...(options.summary ? { diffLoaded: false } : { diffLoaded: true }),
        diff: includeDiff ? body : "",
        diffTruncated: !includeDiff,
        ...(options.summary ? stats.get(entry.path) ?? { additions: 0, deletions: 0 } : countGitDiffLines(body)),
      });
      if (includeDiff) diffBytes += bodyBytes;
      else truncated = true;
    }
  }
  return { files: dedupe(files), diffBytes, truncated, identity: identity.digest("hex") };
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
  options: GitReviewReadOptions = {},
) {
  const paths = (await git(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ], environment))
    .split("\0")
    .filter((path) => Boolean(path) && (!options.filePath || path === options.filePath));
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
    if (options.summary) {
      files.push({ path, status: "untracked", diff: "", diffLoaded: false, diffTruncated: false, additions: 0, deletions: 0 });
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
  } & GitReviewReadOptions,
): Promise<WebGitReviewResult> {
  try {
    const root = cleanLine(
      await git(cwd, ["rev-parse", "--show-toplevel"]),
    );
    if (!root) return { ok: false, reason: "not_git_repository" };
    if (options?.filePath) {
      const child = relative(root, resolve(root, options.filePath));
      if (isAbsolute(options.filePath) || !child || child === ".." || child.startsWith("../") || child.startsWith("..\\") || options.filePath.includes("\0"))
        return { ok: false, reason: "git_failed" };
    }
    const source = options?.baseline ? "session" : options?.source ?? "branch";
    const currentBranch = cleanLine(
      await git(root, ["branch", "--show-current"]),
    );
    const head = cleanLine(await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ""));
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
      source === "branch" && head
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
        : source === "unstaged"
          ? [[]]
          : source === "staged"
            ? [head ? ["--cached", head] : ["--cached", "--root"]]
        : mergeBase
          ? [[mergeBase]]
          : [head ? ["--cached", head] : ["--cached", "--root"], []],
      environment,
      options,
    );
    const untracked = source === "staged" ? { files: [], diffBytes: 0, truncated: false } : await untrackedChanges(
      root,
      WEB_MAX_GIT_REVIEW_FILES - tracked.files.length,
      WEB_MAX_GIT_REVIEW_DIFF_BYTES - tracked.diffBytes,
      environment,
      options,
    );
    const snapshot = boundSnapshot({
      repositoryRoot: root,
      currentBranch,
      baseBranch: base,
      comparison: source,
      revision: "0".repeat(64),
      files: dedupe([...tracked.files, ...untracked.files]),
      additions: 0,
      deletions: 0,
      truncated: tracked.truncated || untracked.truncated,
    });
    const fileIdentities = options?.summary && source !== "staged" ? await Promise.all(snapshot.files.map(async file => {
      try {
        const info = await lstat(resolve(root, file.path), { bigint: true });
        return [file.path, String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
      } catch { return [file.path, "missing"]; }
    })) : undefined;
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          root,
          source,
          trackedIdentity: tracked.identity,
          fileIdentities,
          currentBranch,
          base,
          files: snapshot.files.map(
            ({ path, previousPath, status, diff, diffTruncated, additions, deletions }) => ({
              path,
              previousPath,
              status,
              diff,
              diffTruncated,
              additions,
              deletions,
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
  private readonly maxBaselines: number;
  private readonly maxBaselineBytes: number;
  private readonly maxTotalBytes: number;
  private readonly captures = new Map<string, Promise<void>>();
  private maintenance = Promise.resolve();

  constructor(
    sessionDirectory: string,
    baselineDirectory = join(
      dirname(resolve(sessionDirectory)),
      ".openpi-git-review-baselines",
    ),
    limits: GitReviewBaselineLimits = {},
  ) {
    this.directory = baselineDirectory;
    this.maxBaselines =
      limits.maxBaselines ?? GIT_REVIEW_MAX_BASELINES;
    this.maxBaselineBytes =
      limits.maxBaselineBytes ?? GIT_REVIEW_MAX_BASELINE_BYTES;
    this.maxTotalBytes =
      limits.maxTotalBytes ?? GIT_REVIEW_MAX_TOTAL_BYTES;
    for (const [name, value] of [
      ["maxBaselines", this.maxBaselines],
      ["maxBaselineBytes", this.maxBaselineBytes],
      ["maxTotalBytes", this.maxTotalBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`Git review ${name} must be a positive integer`);
    }
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
        typeof value.sessionPath !== "string" ||
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
    const capture = this.serialize(async () => {
      if (await this.metadata(paths.metadata)) return;
      const usage = await this.cleanup([sessionPath]);
      if (usage.baselines >= this.maxBaselines) return;
      const canonicalCwd = resolve(cwd);
      let repositoryRoot: string | undefined;
      try {
        repositoryRoot =
          cleanLine(await git(canonicalCwd, ["rev-parse", "--show-toplevel"])) ??
          undefined;
      } catch {
        // createBaseline records the canonical Git failure reason.
      }
      if (repositoryRoot) {
        const dirtyBytes = await dirtyWorkingTreeBytes(
          repositoryRoot,
          this.maxBaselineBytes,
        );
        if (
          dirtyBytes >= this.maxBaselineBytes ||
          usage.bytes + dirtyBytes > this.maxTotalBytes
        ) {
          return;
        }
      }
      await this.createBaseline(
        paths,
        sessionPath,
        cwd,
        usage.bytes,
      );
    }).finally(() => {
      this.captures.delete(paths.key);
    });
    this.captures.set(paths.key, capture);
    return capture;
  }

  private async createBaseline(
    paths: ReturnType<GitReviewBaselineStore["paths"]>,
    sessionPath: string,
    cwd: string,
    existingBytes: number,
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
      const bytes =
        (await pathBytes(paths.index, this.maxBaselineBytes)) +
        (await pathBytes(paths.objects, this.maxBaselineBytes));
      if (
        bytes > this.maxBaselineBytes ||
        existingBytes + bytes > this.maxTotalBytes
      ) {
        await rm(paths.index, { force: true });
        await rm(paths.objects, { recursive: true, force: true });
        return;
      }
      await this.writeMetadata(paths.metadata, {
        version: GIT_REVIEW_BASELINE_VERSION,
        sessionPath: canonicalSessionPath(sessionPath),
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
        sessionPath: canonicalSessionPath(sessionPath),
        cwd: canonicalCwd,
        ...(repositoryRoot ? { repositoryRoot } : {}),
        status: this.failureReason(error),
      });
    }
  }

  async read(sessionPath: string, cwd: string, options: GitReviewReadOptions = {}): Promise<WebGitReviewResult> {
    if (options.source && options.source !== "session") return readGitReview(cwd, options);
    await this.capture(sessionPath, cwd);
    return this.readCaptured(sessionPath, cwd, options);
  }

  async readCaptured(sessionPath: string, cwd: string, options: GitReviewReadOptions = {}): Promise<WebGitReviewResult> {
    const paths = this.paths(sessionPath, cwd);
    const metadata = await this.metadata(paths.metadata);
    if (!metadata || metadata.status !== "ready") {
      const reason =
        metadata?.status === "not_git_repository" ||
        metadata?.status === "unborn_repository"
          ? metadata.status
          : "baseline_unavailable";
      return {
        ok: false,
        reason,
      };
    }
    try {
      await Promise.all([access(paths.index), access(paths.objects)]);
    } catch {
      return { ok: false, reason: "baseline_unavailable" };
    }
    const result = await readGitReview(cwd, {
      ...options,
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

  async dispose() {
    await Promise.allSettled([...this.captures.values()]);
    await this.serialize(async () => {
      await this.cleanup([]);
    });
  }

  private serialize<T>(operation: () => Promise<T>) {
    const result = this.maintenance.then(operation, operation);
    this.maintenance = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async cleanup(preservedSessionPaths: string[]) {
    let entries: Dirent<string>[];
    try {
      await chmod(this.directory, 0o700);
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { baselines: 0, bytes: 0 };
      }
      throw error;
    }
    const preserved = new Set(
      preservedSessionPaths.map(canonicalSessionPath),
    );
    const metadataEntries = entries.filter(
      (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name),
    );
    const retainedKeys = new Set<string>();
    let baselines = 0;
    let bytes = 0;
    for (const entry of metadataEntries) {
      const key = entry.name.slice(0, -".json".length);
      const paths = {
        key,
        index: join(this.directory, `${key}.index`),
        objects: join(this.directory, `${key}.objects`),
        metadata: join(this.directory, entry.name),
      };
      const metadata = await this.metadata(paths.metadata);
      let retained = false;
      if (metadata) {
        const sessionPath = canonicalSessionPath(metadata.sessionPath);
        if (preserved.has(sessionPath)) retained = true;
        else if (!sessionPath.startsWith("current:")) {
          retained = await access(sessionPath).then(
            () => true,
            () => false,
          );
        }
      }
      if (!metadata || !retained) {
        await this.removeBaseline(paths);
        continue;
      }
      if (metadata.status === "ready") {
        const actualBytes =
          (await pathBytes(paths.index, this.maxBaselineBytes)) +
          (await pathBytes(paths.objects, this.maxBaselineBytes));
        if (
          actualBytes === 0 ||
          actualBytes > this.maxBaselineBytes
        ) {
          await this.removeBaseline(paths);
          continue;
        }
        bytes += actualBytes;
      }
      retainedKeys.add(key);
      baselines++;
    }
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.(?:index|objects)$/u.exec(entry.name);
      if (match && !retainedKeys.has(match[1]!)) {
        await rm(join(this.directory, entry.name), {
          recursive: entry.isDirectory(),
          force: true,
        });
      } else if (/\.tmp$|\.lock$/u.test(entry.name)) {
        await rm(join(this.directory, entry.name), {
          recursive: entry.isDirectory(),
          force: true,
        });
      }
    }
    return { baselines, bytes };
  }

  private async removeBaseline(
    paths: ReturnType<GitReviewBaselineStore["paths"]>,
  ) {
    await Promise.all([
      rm(paths.index, { force: true }),
      rm(paths.objects, { recursive: true, force: true }),
      rm(paths.metadata, { force: true }),
    ]);
  }
}
