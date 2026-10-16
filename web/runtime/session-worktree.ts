import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  delimiter,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type { WebWorktreeReleaseTarget } from "./types.ts";

const execFileAsync = promisify(execFile);
const PATCH_BYTES = 32 * 1024 * 1024;
const FILE_BYTES = 128 * 1024 * 1024;
const FILE_COUNT = 20_000;
const OPERATION_MS = 90_000;
const OWNER_FILE = "openpi-session-worktree.json";

export class SessionWorktreeError extends Error {
  readonly code: string;
  readonly preservedPath?: string;

  constructor(code: string, message: string, preservedPath?: string) {
    super(message);
    this.name = "SessionWorktreeError";
    this.code = code;
    this.preservedPath = preservedPath;
  }
}

export interface SessionWorktreeCleanupReceipt {
  version: 1;
  path: string;
  gitDir: string;
  commonDir: string;
  sourceRoot: string;
  baseSha: string;
  token: string;
  directoryIdentity: string;
  gitDirectoryIdentity: string;
  gitFileDigest: string;
  fingerprint: string;
  indexDigest: string;
  /** Native child identity, recorded privately before successful activation. */
  ownerSession?: { sessionId: string; sessionPath: string };
  /** Terminal resource barrier: a destructive attempt may already have happened. */
  releaseState?: "uncertain";
}

// deadline is a monotonic performance.now() instant, never a wall timestamp.
type Context = { deadline: number; signal?: AbortSignal };
type Inspection =
  | {
      available: true;
      sourceRoot: string;
      sourceCwd: string;
      relativeCwd: string;
      commonDir: string;
      baseSha: string;
    }
  | { available: false; reason: string };

function check(context: Context) {
  if (context.signal?.aborted)
    throw new SessionWorktreeError("cancelled", "Worktree fork was cancelled.");
  const remaining = context.deadline - performance.now();
  if (remaining <= 0)
    throw new SessionWorktreeError(
      "limit",
      "Worktree snapshot exceeded its 90 second deadline.",
    );
  return Math.ceil(remaining);
}

async function git(
  cwd: string,
  args: string[],
  context: Context,
  environment: NodeJS.ProcessEnv = {},
) {
  const remaining = check(context);
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: Math.min(10_000, remaining),
        maxBuffer: PATCH_BYTES,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          ...environment,
        },
      },
    );
    return result.stdout;
  } catch (error) {
    throw new SessionWorktreeError(
      "git",
      error instanceof Error ? error.message : "Git worktree operation failed.",
    );
  }
}

function within(root: string, target: string) {
  const suffix = relative(root, target);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function paths(output: string) {
  const result = output.split("\0").filter(Boolean);
  if (result.length > FILE_COUNT)
    throw new SessionWorktreeError(
      "limit",
      "Worktree snapshot exceeds 20,000 files.",
    );
  for (const value of result) {
    if (
      isAbsolute(value) ||
      value.split("/").some((part) => part === ".." || part === ".git")
    )
      throw new SessionWorktreeError(
        "path",
        "Git returned an unsafe snapshot path.",
      );
  }
  return [...new Set(result)].sort();
}

async function inspect(cwd: string, context: Context) {
  const sourceCwd = await realpath(cwd);
  if (
    (
      await git(sourceCwd, ["rev-parse", "--is-inside-work-tree"], context)
    ).trim() !== "true"
  )
    throw new SessionWorktreeError(
      "unavailable",
      "The conversation directory is not a Git working tree.",
    );
  const sourceRoot = await realpath(
    (await git(sourceCwd, ["rev-parse", "--show-toplevel"], context)).trim(),
  );
  if (!within(sourceRoot, sourceCwd))
    throw new SessionWorktreeError(
      "path",
      "The conversation directory is outside its Git root.",
    );
  const commonDir = await realpath(
    resolve(
      sourceRoot,
      (
        await git(sourceRoot, ["rev-parse", "--git-common-dir"], context)
      ).trim(),
    ),
  );
  const baseSha = (
    await git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"], context)
  ).trim();
  if (!/^[a-f0-9]{40,64}$/.test(baseSha))
    throw new SessionWorktreeError(
      "unavailable",
      "The repository needs an existing commit before it can be forked.",
    );
  const sparse = await git(
    sourceRoot,
    ["config", "--bool", "--default", "false", "core.sparseCheckout"],
    context,
  );
  if (sparse.trim() === "true")
    throw new SessionWorktreeError(
      "unsupported",
      "Worktree fork does not yet support sparse checkouts.",
    );
  const entries = await git(sourceRoot, ["ls-files", "--stage", "-z"], context);
  validateIndex(entries);
  return {
    available: true as const,
    sourceRoot,
    sourceCwd,
    relativeCwd: relative(sourceRoot, sourceCwd),
    commonDir,
    baseSha,
  };
}

function validateIndex(entries: string) {
  for (const entry of entries.split("\0").filter(Boolean)) {
    if (entry.startsWith("160000 "))
      throw new SessionWorktreeError(
        "unsupported",
        "Worktree fork does not yet support repositories containing submodules or embedded repositories.",
      );
    if (!/^\d{6} [a-f0-9]+ 0\t/.test(entry))
      throw new SessionWorktreeError(
        "unsupported",
        "Resolve the repository's merge conflicts before creating a worktree fork.",
      );
  }
}

export async function inspectSessionWorktree(cwd: string): Promise<Inspection> {
  try {
    return await inspect(cwd, { deadline: performance.now() + OPERATION_MS });
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error ? error.message : "Git worktree is unavailable.",
    };
  }
}

async function digestFile(
  file: string,
  budget: { bytes: number },
  context: Context,
  expectedIdentity?: string,
) {
  const hash = createHash("sha256");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (expectedIdentity && `${info.dev}:${info.ino}` !== expectedIdentity)
    )
      throw new SessionWorktreeError(
        "changed",
        "A snapshot file was replaced during inspection.",
      );
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      check(context);
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      budget.bytes += bytesRead;
      if (budget.bytes > FILE_BYTES)
        throw new SessionWorktreeError(
          "limit",
          "Worktree contents exceed the 128 MiB inspection limit.",
        );
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

// Includes ignored files, empty directories and link targets. Git status alone
// cannot establish that deleting a copied dirty checkout would preserve user work.
async function fingerprint(root: string, context: Context) {
  const hash = createHash("sha256");
  const budget = { bytes: 0 };
  let count = 0;
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      if (directory === root && name === ".git") continue;
      check(context);
      if (++count > FILE_COUNT)
        throw new SessionWorktreeError(
          "limit",
          "Worktree contents exceed the 20,000 entry inspection limit.",
        );
      const file = join(directory, name);
      const info = await lstat(file);
      hash.update(JSON.stringify([relative(root, file), info.mode & 0o777]));
      if (info.isSymbolicLink()) hash.update(`link:${await readlink(file)}`);
      else if (info.isDirectory()) {
        hash.update("directory");
        await visit(file);
      } else if (info.isFile()) {
        if (!within(root, await realpath(file)))
          throw new SessionWorktreeError(
            "changed",
            "A snapshot file moved outside the worktree.",
          );
        hash.update(
          await digestFile(file, budget, context, `${info.dev}:${info.ino}`),
        );
      } else
        throw new SessionWorktreeError(
          "unsupported",
          "Worktree contains a special file that cannot be safely copied or removed.",
        );
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function indexDigest(cwd: string, context: Context) {
  const indexPath = resolve(
    cwd,
    (await git(cwd, ["rev-parse", "--git-path", "index"], context)).trim(),
  );
  return digestFile(indexPath, { bytes: 0 }, context);
}

async function includedIgnored(sourceRoot: string, context: Context) {
  const selected = new Set(
    paths(
      await git(
        sourceRoot,
        [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
          "--",
          ":(glob)**/AGENTS.override.md",
        ],
        context,
      ),
    ),
  );
  const include = await lstat(join(sourceRoot, ".worktreeinclude")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (include) {
    if (!include.isFile())
      throw new SessionWorktreeError(
        "unsupported",
        ".worktreeinclude must be a regular file inside the source repository.",
      );
    const candidates = paths(
      await git(
        sourceRoot,
        [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-from=.worktreeinclude",
          "-z",
        ],
        context,
      ),
    );
    // Intersect with Git's standard ignore rules without enumerating an entire
    // dependency/build tree just to select a handful of explicit include files.
    for (let start = 0; start < candidates.length; start += 100) {
      for (const file of paths(
        await git(
          sourceRoot,
          [
            "--literal-pathspecs",
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            ...candidates.slice(start, start + 100),
          ],
          context,
        ),
      ))
        selected.add(file);
    }
  }
  const files: {
    path: string;
    digest: string;
    mode: number;
    identity: string;
  }[] = [];
  const budget = { bytes: 0 };
  for (const file of [...selected].sort()) {
    const location = join(sourceRoot, file);
    const info = await lstat(location);
    // Codex's explicit ignored-file copier only copies regular files. Following
    // a symlink here would import data outside the requested working tree.
    if (!info.isFile()) continue;
    if (!within(sourceRoot, await realpath(location)))
      throw new SessionWorktreeError(
        "path",
        "An included ignored file resolves outside the source repository.",
      );
    files.push({
      path: file,
      digest: await digestFile(
        location,
        budget,
        context,
        `${info.dev}:${info.ino}`,
      ),
      mode: info.mode & 0o777,
      identity: `${info.dev}:${info.ino}`,
    });
  }
  return files;
}

async function snapshot(
  source: Extract<Inspection, { available: true }>,
  scratch: string,
  context: Context,
  forceTracked: string[] = [],
) {
  const candidates = paths(
    await git(
      source.sourceRoot,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      context,
    ),
  );
  let bytes = 0;
  for (const file of candidates) {
    check(context);
    const info = await lstat(join(source.sourceRoot, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
          return undefined;
        throw error;
      },
    );
    if (info?.isFile()) bytes += info.size;
    if (bytes > FILE_BYTES)
      throw new SessionWorktreeError(
        "limit",
        "Worktree contents exceed the 128 MiB snapshot limit.",
      );
  }
  const index = join(scratch, `index-${randomUUID()}`);
  const objects = join(scratch, "objects");
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const environment = {
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [
      join(source.commonDir, "objects"),
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    ]
      .filter(Boolean)
      .join(delimiter),
  };
  try {
    await git(
      source.sourceRoot,
      ["read-tree", source.baseSha],
      context,
      environment,
    );
    await git(
      source.sourceRoot,
      ["add", "-A", "--", "."],
      context,
      environment,
    );
    // A newly staged file may also match .gitignore. It is still source-tracked.
    const ignoredTracked = [
      ...new Set([
        ...forceTracked,
        ...paths(
          await git(
            source.sourceRoot,
            ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
            context,
          ),
        ),
      ]),
    ].sort();
    const existing: string[] = [];
    for (const file of ignoredTracked) {
      const info = await lstat(join(source.sourceRoot, file)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return undefined;
          throw error;
        },
      );
      if (info) existing.push(file);
    }
    if (existing.length) {
      const pathspec = join(scratch, `paths-${randomUUID()}`);
      await writeFile(pathspec, `${existing.join("\0")}\0`, { mode: 0o600 });
      await git(
        source.sourceRoot,
        [
          "--literal-pathspecs",
          "add",
          "-f",
          `--pathspec-from-file=${pathspec}`,
          "--pathspec-file-nul",
        ],
        context,
        environment,
      );
    }
    validateIndex(
      await git(
        source.sourceRoot,
        ["ls-files", "--stage", "-z"],
        context,
        environment,
      ),
    );
    const tree = (
      await git(source.sourceRoot, ["write-tree"], context, environment)
    ).trim();
    const patch = await git(
      source.sourceRoot,
      [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--full-index",
        source.baseSha,
        "--",
      ],
      context,
      environment,
    );
    const ignored = await includedIgnored(source.sourceRoot, context);
    return { tree, patch, ignored, ignoredTracked: existing };
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

async function identity(worktreePath: string, context: Context) {
  const gitDir = await realpath(
    (
      await git(worktreePath, ["rev-parse", "--absolute-git-dir"], context)
    ).trim(),
  );
  const commonDir = await realpath(
    resolve(
      worktreePath,
      (
        await git(worktreePath, ["rev-parse", "--git-common-dir"], context)
      ).trim(),
    ),
  );
  const baseSha = (
    await git(worktreePath, ["rev-parse", "HEAD"], context)
  ).trim();
  const branch = (
    await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], context)
  ).trim();
  return { gitDir, commonDir, baseSha, branch };
}

async function directoryIdentity(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory())
    throw new SessionWorktreeError(
      "identity",
      "A managed worktree directory was replaced.",
    );
  return `${info.dev}:${info.ino}`;
}

async function safeParent(root: string, file: string) {
  const parent = dirname(join(root, file));
  if (!within(root, parent))
    throw new SessionWorktreeError("path", "Unsafe included-file destination.");
  let directory = root;
  for (const segment of relative(root, parent).split(sep).filter(Boolean)) {
    directory = join(directory, segment);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new SessionWorktreeError(
        "path",
        "An included-file destination crosses a symbolic link.",
      );
  }
}

async function copyIncludedFile(
  sourceRoot: string,
  worktreePath: string,
  file: Awaited<ReturnType<typeof includedIgnored>>[number],
  context: Context,
) {
  const source = await open(
    join(sourceRoot, file.path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await source.stat();
    if (!info.isFile() || `${info.dev}:${info.ino}` !== file.identity)
      throw new SessionWorktreeError(
        "changed",
        "An included ignored file was replaced during the fork.",
      );
    await safeParent(worktreePath, file.path);
    const target = await open(join(worktreePath, file.path), "wx", file.mode);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        check(context);
        const { bytesRead } = await source.read(buffer);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > FILE_BYTES)
          throw new SessionWorktreeError(
            "limit",
            "An included file exceeded the 128 MiB snapshot limit.",
          );
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await target.writeFile(chunk);
      }
      await target.chmod(file.mode);
      if (hash.digest("hex") !== file.digest)
        throw new SessionWorktreeError(
          "changed",
          "An included ignored file changed while the worktree was being copied.",
        );
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

export async function createSessionWorktree(
  cwd: string,
  commandId: string,
  signal?: AbortSignal,
) {
  const context: Context = { deadline: performance.now() + OPERATION_MS, signal };
  const source = await inspect(cwd, context);
  const scratch = await mkdtemp(join(tmpdir(), "openpi-session-worktree-"));
  let receipt: SessionWorktreeCleanupReceipt | undefined;
  let createdPath: string | undefined;
  try {
    const originalIndex = await indexDigest(source.sourceRoot, context);
    const frozen = await snapshot(source, scratch, context);
    const parent = join(source.commonDir, "pi-worktrees");
    await mkdir(parent, { recursive: true });
    if (
      (await realpath(parent)) !== parent ||
      !(await lstat(parent)).isDirectory()
    )
      throw new SessionWorktreeError(
        "path",
        "The managed worktree directory must not be a symbolic link.",
      );
    const token = randomUUID();
    const name = `session-${createHash("sha256").update(commandId).digest("hex").slice(0, 12)}-${token}`;
    const worktreePath = join(parent, name);
    createdPath = worktreePath;
    await git(
      source.sourceRoot,
      ["worktree", "add", "--quiet", "--detach", worktreePath, source.baseSha],
      context,
    );
    // Finish recording each mutation before observing cancellation. An aborted
    // child process could otherwise leave a checkout with no cleanup identity.
    const mutationContext = { deadline: context.deadline };
    const current = await identity(worktreePath, mutationContext);
    if (
      current.commonDir !== source.commonDir ||
      current.baseSha !== source.baseSha ||
      current.branch !== "HEAD" ||
      !within(join(source.commonDir, "worktrees"), current.gitDir)
    )
      throw new SessionWorktreeError(
        "identity",
        "The created worktree identity could not be verified.",
      );
    receipt = {
      version: 1,
      path: worktreePath,
      gitDir: current.gitDir,
      commonDir: source.commonDir,
      sourceRoot: source.sourceRoot,
      baseSha: source.baseSha,
      token,
      directoryIdentity: await directoryIdentity(worktreePath),
      gitDirectoryIdentity: await directoryIdentity(current.gitDir),
      gitFileDigest: await digestFile(
        join(worktreePath, ".git"),
        { bytes: 0 },
        mutationContext,
      ),
      fingerprint: await fingerprint(worktreePath, mutationContext),
      indexDigest: await indexDigest(worktreePath, mutationContext),
    };
    await writeFile(join(current.gitDir, OWNER_FILE), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    check(context);
    if (frozen.patch) {
      const patchFile = join(scratch, "working-tree.patch");
      await writeFile(patchFile, frozen.patch, { mode: 0o600 });
      // Keep copied changes unstaged, even when the source staged them.
      await git(
        worktreePath,
        ["apply", "--binary", "--whitespace=nowarn", patchFile],
        mutationContext,
      );
    }
    for (const file of frozen.ignored) {
      await copyIncludedFile(
        source.sourceRoot,
        worktreePath,
        file,
        mutationContext,
      );
    }
    const childCwd = join(worktreePath, source.relativeCwd);
    if (
      !(await lstat(childCwd)).isDirectory() ||
      !within(worktreePath, await realpath(childCwd))
    )
      throw new SessionWorktreeError(
        "path",
        "The conversation's subdirectory is unavailable in the new worktree.",
      );
    // Index integrity is independent of working-tree contents: an external
    // git add must also prevent cancellation from deleting someone's staging.
    if (
      (await indexDigest(worktreePath, mutationContext)) !== receipt.indexDigest
    )
      throw new SessionWorktreeError(
        "changed",
        "The new worktree index changed during creation.",
      );
    const child = await snapshot(
      { ...source, sourceRoot: worktreePath, sourceCwd: childCwd },
      scratch,
      mutationContext,
      frozen.ignoredTracked,
    );
    if (child.tree !== frozen.tree)
      throw new SessionWorktreeError(
        "changed",
        "The new worktree does not match the captured source contents.",
      );
    const allowedIgnored = new Set([
      ...frozen.ignored.map((file) => file.path),
      ...frozen.ignoredTracked,
    ]);
    const childIgnored = paths(
      await git(
        worktreePath,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        mutationContext,
      ),
    );
    if (childIgnored.some((file) => !allowedIgnored.has(file)))
      throw new SessionWorktreeError(
        "changed",
        "Unexpected ignored files appeared in the new worktree.",
      );
    receipt.fingerprint = await fingerprint(worktreePath, mutationContext);
    await writeFile(join(current.gitDir, OWNER_FILE), JSON.stringify(receipt), {
      mode: 0o600,
    });
    check(context);
    const after = await snapshot(source, scratch, context);
    if (
      after.tree !== frozen.tree ||
      JSON.stringify(after.ignored) !== JSON.stringify(frozen.ignored) ||
      (await indexDigest(source.sourceRoot, context)) !== originalIndex ||
      (await git(source.sourceRoot, ["rev-parse", "HEAD"], context)).trim() !==
        source.baseSha
    )
      throw new SessionWorktreeError(
        "changed",
        "The source HEAD, index, or working tree changed during the fork. Retry when those files are stable.",
      );
    if (
      (await fingerprint(worktreePath, context)) !== receipt.fingerprint ||
      (await indexDigest(worktreePath, context)) !== receipt.indexDigest
    )
      throw new SessionWorktreeError(
        "changed",
        "The new worktree changed before the fork completed.",
      );
    check(context);
    return {
      cwd: childCwd,
      worktree: {
        path: worktreePath,
        baseSha: source.baseSha,
        sourceRoot: source.sourceRoot,
      },
      cleanupReceipt: receipt,
    };
  } catch (error) {
    const cleanup = receipt ? await cleanupSessionWorktree(receipt) : undefined;
    const checkoutExists =
      createdPath &&
      (await lstat(createdPath).then(
        () => true,
        (failure: NodeJS.ErrnoException) => failure.code !== "ENOENT",
      ));
    const preservedPath =
      checkoutExists && !cleanup?.removed ? createdPath : undefined;
    const message =
      error instanceof Error ? error.message : "Worktree fork failed.";
    throw new SessionWorktreeError(
      error instanceof SessionWorktreeError ? error.code : "failed",
      preservedPath
        ? `${message} The checkout was preserved at ${preservedPath}: ${cleanup?.reason ?? "creation could not be fully verified"}`
        : message,
      preservedPath,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function bindSessionWorktree(
  receipt: SessionWorktreeCleanupReceipt,
  ownerSession: { sessionId: string; sessionPath: string },
) {
  const marker = join(receipt.gitDir, OWNER_FILE);
  if (receipt.releaseState || await hasReleaseClaim(receipt.gitDir))
    throw new SessionWorktreeError("identity", "A terminal worktree release receipt cannot be rebound.");
  if (await readOwnershipMarker(marker) !== JSON.stringify(receipt))
    throw new SessionWorktreeError("identity", "The worktree ownership receipt changed before native binding.");
  const bound = { ...receipt, ownerSession: { ...ownerSession } };
  if (Buffer.byteLength(JSON.stringify(bound)) > 16 * 1024)
    throw new SessionWorktreeError("limit", "The native worktree ownership binding exceeds its byte limit.");
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(bound), { flag: "wx", mode: 0o600 });
    await rename(temporary, marker);
    receipt.ownerSession = bound.ownerSession;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function hasReleaseClaim(gitDir: string) {
  try { await lstat(join(gitDir, `${OWNER_FILE}.release-lock`)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

async function readOwnershipMarker(marker: string) {
  const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024)
      throw new SessionWorktreeError("identity", "The worktree ownership marker is unavailable or oversized.");
    const buffer = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16 * 1024) throw new SessionWorktreeError("identity", "The worktree ownership marker grew during inspection.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/** A browser path is only a locator. Authority is recovered from the private Git marker. */
export async function readSessionWorktreeReceipt(worktreePath: string, sessionDirectory: string) {
  let claimed = false;
  try {
    const context = { deadline: performance.now() + OPERATION_MS };
    if (!isAbsolute(worktreePath) || await realpath(worktreePath) !== worktreePath)
      throw new SessionWorktreeError("identity", "The managed worktree path changed.");
    const current = await identity(worktreePath, context);
    if (dirname(worktreePath) !== join(current.commonDir, "pi-worktrees") ||
        !within(join(current.commonDir, "worktrees"), current.gitDir))
      throw new SessionWorktreeError("identity", "This is not a privately owned managed worktree.");
    claimed = await hasReleaseClaim(current.gitDir);
    let value: unknown;
    try { value = JSON.parse(await readOwnershipMarker(join(current.gitDir, OWNER_FILE))); }
    catch { throw new SessionWorktreeError("identity", "The private worktree ownership marker could not be read or validated."); }
    if (!value || typeof value !== "object") throw new SessionWorktreeError("identity", "Invalid worktree ownership marker.");
    const receipt = value as Partial<SessionWorktreeCleanupReceipt>;
    const strings = [receipt.path, receipt.gitDir, receipt.commonDir, receipt.sourceRoot, receipt.baseSha, receipt.token,
      receipt.directoryIdentity, receipt.gitDirectoryIdentity, receipt.gitFileDigest, receipt.fingerprint, receipt.indexDigest];
    const owner = receipt.ownerSession;
    if (receipt.version !== 1 || (receipt.releaseState !== undefined && receipt.releaseState !== "uncertain") || strings.some((entry) => typeof entry !== "string" || !entry || entry.length > 4096) ||
        receipt.path !== worktreePath || receipt.gitDir !== current.gitDir || receipt.commonDir !== current.commonDir ||
        !isAbsolute(receipt.sourceRoot ?? "") || await realpath(receipt.sourceRoot!) !== receipt.sourceRoot ||
        !basename(worktreePath).endsWith(`-${receipt.token}`) || !/^[a-f0-9]{40,64}$/u.test(receipt.baseSha ?? "") ||
        [receipt.gitFileDigest, receipt.fingerprint, receipt.indexDigest].some((digest) => !/^[a-f0-9]{64}$/u.test(digest ?? "")) ||
        !owner || typeof owner.sessionId !== "string" || !owner.sessionId || owner.sessionId.length > 128 ||
        typeof owner.sessionPath !== "string" || owner.sessionPath.length > 4096 ||
        dirname(owner.sessionPath) !== resolve(sessionDirectory) || /[\u0000-\u001f\u007f]/u.test(owner.sessionId + owner.sessionPath) ||
        await directoryIdentity(worktreePath) !== receipt.directoryIdentity ||
        await directoryIdentity(current.gitDir) !== receipt.gitDirectoryIdentity ||
        await digestFile(join(worktreePath, ".git"), { bytes: 0 }, context) !== receipt.gitFileDigest)
      throw new SessionWorktreeError("identity", "The native child binding or worktree ownership could not be verified.");
    if ((await identity(receipt.sourceRoot!, context)).commonDir !== current.commonDir)
      throw new SessionWorktreeError("identity", "The source Git repository no longer matches its ownership receipt.");
    if (claimed || await hasReleaseClaim(current.gitDir)) receipt.releaseState = "uncertain";
    return receipt as SessionWorktreeCleanupReceipt & { ownerSession: NonNullable<SessionWorktreeCleanupReceipt["ownerSession"]> };
  } catch {
    // A claim only narrows authority. Missing/corrupt private data must never
    // recreate a child binding, nor turn prior terminal uncertainty into a
    // definitive no-attempt result merely because the directory still exists.
    throw new SessionWorktreeError("uncertain", claimed
      ? "A release claim exists or cannot be inspected, but its original private authority is unavailable. No release is authorized."
      : "The managed worktree identity, private authority or terminal release state cannot be verified. No release is authorized.", worktreePath);
  }
}

export function sessionWorktreeReleaseTarget(receipt: SessionWorktreeCleanupReceipt & { ownerSession: NonNullable<SessionWorktreeCleanupReceipt["ownerSession"]> }): WebWorktreeReleaseTarget {
  return { ...receipt.ownerSession, worktreePath: receipt.path };
}

/** Bounded discovery from one known Git workspace, not a global resource registry or sweep. */
export async function listSessionWorktrees(cwd: string, sessionDirectory: string, cursor?: string) {
  const context = { deadline: performance.now() + OPERATION_MS };
  const commonDir = await realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"], context)).trim()));
  const parent = join(commonDir, "pi-worktrees");
  const entries = await readdir(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries.filter((entry) => /^session-[a-f0-9]{12}-[a-f0-9-]{36}$/u.test(entry)).sort();
  let start = 0;
  if (cursor !== undefined) {
    const anchor = Buffer.from(cursor, "base64url").toString("utf8");
    if (cursor.length > 256 || Buffer.from(anchor).toString("base64url") !== cursor ||
        !/^session-[a-f0-9]{12}-[a-f0-9-]{36}$/u.test(anchor) || !candidates.includes(anchor))
      throw new SessionWorktreeError("cursor", "Managed worktree listing changed; refresh the list.");
    start = candidates.indexOf(anchor) + 1;
  }
  const page = candidates.slice(start, start + 128);
  const worktrees: WebWorktreeReleaseTarget[] = [];
  let unavailable = 0;
  for (const name of page) {
    check(context);
    try { worktrees.push(sessionWorktreeReleaseTarget(await readSessionWorktreeReceipt(join(parent, name), sessionDirectory))); }
    catch { unavailable++; }
  }
  const truncated = start + page.length < candidates.length;
  return { worktrees, truncated, unavailable,
    ...(truncated && page.length ? { nextCursor: Buffer.from(page.at(-1)!).toString("base64url") } : {}) };
}

export async function cleanupSessionWorktree(
  receipt: SessionWorktreeCleanupReceipt,
) {
  const context = { deadline: performance.now() + OPERATION_MS };
  let releaseAttempted = false;
  const preserved = (reason: string) => ({
    removed: false,
    path: receipt.path,
    reason,
  });
  try {
    if (receipt.releaseState === "uncertain" || await hasReleaseClaim(receipt.gitDir))
      return { ...preserved("A prior release attempt is uncertain. Automatic removal cannot be repeated."), uncertain: true as const };
    if (
      receipt.version !== 1 ||
      !within(join(receipt.commonDir, "pi-worktrees"), receipt.path) ||
      dirname(receipt.path) !== join(receipt.commonDir, "pi-worktrees") ||
      !within(join(receipt.commonDir, "worktrees"), receipt.gitDir)
    )
      return preserved(
        "The cleanup receipt does not identify a managed worktree.",
      );
    if (
      (await realpath(receipt.path)) !== receipt.path ||
      (await realpath(receipt.gitDir)) !== receipt.gitDir ||
      (await directoryIdentity(receipt.path)) !== receipt.directoryIdentity ||
      (await directoryIdentity(receipt.gitDir)) !==
        receipt.gitDirectoryIdentity ||
      (await digestFile(join(receipt.path, ".git"), { bytes: 0 }, context)) !==
        receipt.gitFileDigest
    )
      return preserved(
        "The worktree path or administrative directory changed.",
      );
    const marker = await readOwnershipMarker(join(receipt.gitDir, OWNER_FILE));
    if (marker !== JSON.stringify(receipt))
      return preserved("The worktree ownership receipt changed.");
    const current = await identity(receipt.path, context);
    if (
      current.gitDir !== receipt.gitDir ||
      current.commonDir !== receipt.commonDir ||
      current.baseSha !== receipt.baseSha ||
      current.branch !== "HEAD"
    )
      return preserved("The worktree HEAD or Git identity changed.");
    if (
      (await indexDigest(receipt.path, context)) !== receipt.indexDigest ||
      (await fingerprint(receipt.path, context)) !== receipt.fingerprint
    )
      return preserved("The worktree contains changes made after creation.");
    const finalIdentity = await identity(receipt.path, context);
    if (
      finalIdentity.gitDir !== receipt.gitDir ||
      finalIdentity.commonDir !== receipt.commonDir ||
      finalIdentity.baseSha !== receipt.baseSha ||
      finalIdentity.branch !== "HEAD" ||
      (await directoryIdentity(receipt.path)) !== receipt.directoryIdentity ||
      (await indexDigest(receipt.path, context)) !== receipt.indexDigest ||
      (await fingerprint(receipt.path, context)) !== receipt.fingerprint
    )
      return preserved(
        "The worktree changed while cleanup was being verified.",
      );
    // Only this exact, owned, unchanged checkout can contain our dirty copied
    // baseline. Normal worktree removal refuses it; never force arbitrary ones.
    // The existing resource receipt owns this terminal barrier, across commands
    // and Host restarts. wx is an exclusive claim across processes; a leftover
    // claim is never unlocked automatically. No destructive Git call may precede
    // its durable write, including when updating the original marker fails.
    const original = JSON.stringify(receipt);
    releaseAttempted = true;
    const claim = await open(join(receipt.gitDir, `${OWNER_FILE}.release-lock`), "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && !await hasReleaseClaim(receipt.gitDir) &&
          await readOwnershipMarker(join(receipt.gitDir, OWNER_FILE)) === original) {
        releaseAttempted = false;
        return undefined;
      }
      throw error;
    });
    if (!claim) return preserved("An exclusive release claim could not be created. No Git removal was started.");
    try {
      if (await readOwnershipMarker(join(receipt.gitDir, OWNER_FILE)) !== original)
        throw new SessionWorktreeError("identity", "The worktree receipt changed before the release claim.");
      await claim.writeFile(original);
      await claim.sync();
      const terminal = { ...receipt, releaseState: "uncertain" as const };
      const terminalJson = JSON.stringify(terminal);
      if (Buffer.byteLength(terminalJson) > 16 * 1024)
        throw new SessionWorktreeError("limit", "The terminal release receipt exceeds its byte limit.");
      const marker = join(receipt.gitDir, OWNER_FILE);
      const temporary = `${marker}.${randomUUID()}.tmp`;
      try {
        const pending = await open(temporary, "wx", 0o600);
        try { await pending.writeFile(terminalJson); await pending.sync(); }
        finally { await pending.close(); }
        await rename(temporary, marker);
        if (process.platform !== "win32") {
          const directory = await open(receipt.gitDir, constants.O_RDONLY | constants.O_DIRECTORY);
          try { await directory.sync(); } finally { await directory.close(); }
        }
        if (await readOwnershipMarker(marker) !== terminalJson)
          throw new SessionWorktreeError("identity", "The worktree release barrier could not be verified.");
        receipt.releaseState = "uncertain";
      } finally { await rm(temporary, { force: true }); }
    } finally { await claim.close(); }
    await git(
      receipt.sourceRoot,
      ["worktree", "remove", "--force", receipt.path],
      context,
    );
    return { removed: true, path: receipt.path, reason: undefined };
  } catch (error) {
    return { ...preserved(error instanceof Error ? error.message : "Cleanup could not be verified."),
      ...(releaseAttempted ? { uncertain: true as const } : {}) };
  }
}
