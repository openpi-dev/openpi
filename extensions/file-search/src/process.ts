import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Data, Effect, FileSystem } from "effect";
import { COMPLETE_OUTPUT_MAX_BYTES, type CapturedOutput } from "./output.ts";

const STDERR_MAX_BYTES = 64 * 1024;

interface PreviewState {
  readonly decoder: TextDecoder;
  preview: string;
  totalBytes: number;
  lineBreaks: number;
  trailingLineBreaks: number;
  truncated: boolean;
  captureLimitExceeded: boolean;
}

function makePreviewState(): PreviewState {
  return {
    decoder: new TextDecoder(),
    preview: "",
    totalBytes: 0,
    lineBreaks: 0,
    trailingLineBreaks: 0,
    truncated: false,
    captureLimitExceeded: false,
  };
}

function observeStdout(state: PreviewState, chunk: Uint8Array) {
  state.totalBytes += chunk.byteLength;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      state.lineBreaks++;
      state.trailingLineBreaks++;
    } else {
      state.trailingLineBreaks = 0;
    }
  }

  if (state.truncated) return;
  state.preview += state.decoder.decode(chunk, { stream: true });
  const truncation = truncateHead(state.preview, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (truncation.truncated) {
    state.preview = truncation.content;
    state.truncated = true;
  }
}

function finishStdout(
  state: PreviewState,
  fullOutputPath: string,
  captureLimitBytes: number,
) {
  if (!state.truncated) state.preview += state.decoder.decode();
  const totalBytes = state.totalBytes - state.trailingLineBreaks;
  const lineCount =
    totalBytes === 0 ? 0 : state.lineBreaks - state.trailingLineBreaks + 1;
  return {
    preview: state.preview,
    lineCount,
    totalBytes,
    truncated: state.truncated || state.captureLimitExceeded,
    captureLimitExceeded: state.captureLimitExceeded,
    captureLimitBytes,
    fullOutputPath:
      state.truncated && !state.captureLimitExceeded
        ? fullOutputPath
        : undefined,
  } satisfies CapturedOutput;
}

class SearchProcessError extends Data.TaggedError("SearchProcessError")<{
  readonly message: string;
}> {}

function killProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already be gone.
  }
}

function captureProcess(
  options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly createOutput?: (path: string) => Writable;
  },
  fullOutputPath: string,
  captureLimitBytes: number,
  preview: PreviewState,
) {
  return Effect.callback<
    { readonly exitCode: number; readonly stderr: string },
    SearchProcessError
  >((resume) => {
    const output = options.createOutput
      ? options.createOutput(fullOutputPath)
      : createWriteStream(fullOutputPath, { flags: "w" });
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closed = false;
    let outputClosed = false;
    let settled = false;
    let stderr = Buffer.alloc(0);
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const complete = (
      result: Effect.Effect<
        { readonly exitCode: number; readonly stderr: string },
        SearchProcessError
      >,
    ) => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    const terminate = () => {
      if (closed || forceKillTimer) return;
      killProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcess(child, "SIGKILL"), 1_000);
      forceKillTimer.unref();
    };
    const fail = (error: unknown) => {
      terminate();
      output.destroy();
      const message = error instanceof Error ? error.message : String(error);
      if (outputClosed) {
        complete(Effect.fail(new SearchProcessError({ message })));
      } else {
        output.once("close", () =>
          complete(Effect.fail(new SearchProcessError({ message }))),
        );
      }
    };

    output.on("close", () => {
      outputClosed = true;
    });
    output.on("error", fail);
    child.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (preview.captureLimitExceeded) return;
      const remaining = captureLimitBytes - preview.totalBytes;
      const captured = chunk.subarray(0, Math.max(0, remaining));
      if (captured.byteLength > 0) {
        observeStdout(preview, captured);
        if (!output.write(captured)) {
          child.stdout.pause();
          output.once("drain", () => child.stdout.resume());
        }
      }
      if (captured.byteLength < chunk.byteLength) {
        preview.captureLimitExceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength >= STDERR_MAX_BYTES) return;
      const remaining = STDERR_MAX_BYTES - stderr.byteLength;
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      output.end(() => {
        outputClosed = true;
        if (signal && !preview.captureLimitExceeded) {
          complete(
            Effect.fail(
              new SearchProcessError({
                message: `process terminated by ${signal}`,
              }),
            ),
          );
          return;
        }
        complete(
          Effect.succeed({
            exitCode: preview.captureLimitExceeded ? 0 : (code ?? 1),
            stderr: stderr.toString("utf8"),
          }),
        );
      });
    });

    return Effect.callback<void>((done) => {
      settled = true;
      let cleanupFinished = false;
      let processDeadlineExpired = false;
      let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
      const finishCleanup = () => {
        if (
          cleanupFinished ||
          !outputClosed ||
          (!closed && !processDeadlineExpired)
        ) {
          return;
        }
        cleanupFinished = true;
        if (cleanupDeadline) clearTimeout(cleanupDeadline);
        child.off("close", finishCleanup);
        output.off("close", finishCleanup);
        done(Effect.void);
      };

      child.on("close", finishCleanup);
      output.on("close", finishCleanup);
      cleanupDeadline = setTimeout(() => {
        killProcess(child, "SIGKILL");
        processDeadlineExpired = true;
        finishCleanup();
      }, 1_500);
      cleanupDeadline.unref();
      terminate();
      child.stdout.destroy();
      child.stderr.destroy();
      output.destroy();
      finishCleanup();

      return Effect.sync(() => {
        if (cleanupDeadline) clearTimeout(cleanupDeadline);
        child.off("close", finishCleanup);
        output.off("close", finishCleanup);
      });
    });
  });
}

export function executeSearchProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tempPrefix: string;
  /** Test overrides; production capture is capped at 10 MiB. */
  readonly maxCaptureBytes?: number;
  readonly createOutput?: (path: string) => Writable;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({
      prefix: options.tempPrefix,
    });
    const fullOutputPath = join(directory, "output.txt");
    const captureLimitBytes = Math.max(
      1,
      Math.floor(options.maxCaptureBytes ?? COMPLETE_OUTPUT_MAX_BYTES),
    );
    const preview = makePreviewState();
    let retainDirectory = false;

    return yield* captureProcess(
      options,
      fullOutputPath,
      captureLimitBytes,
      preview,
    ).pipe(
      Effect.map((result) => {
        const output = finishStdout(preview, fullOutputPath, captureLimitBytes);
        retainDirectory = output.fullOutputPath !== undefined;
        return { code: result.exitCode, stderr: result.stderr, output };
      }),
      Effect.ensuring(
        Effect.suspend(() =>
          retainDirectory
            ? Effect.void
            : fs
                .remove(directory, { recursive: true, force: true })
                .pipe(Effect.orDie),
        ),
      ),
    );
  });
}

export function discardCapturedOutput(output: CapturedOutput) {
  if (!output.fullOutputPath) return Effect.void;
  const directory = dirname(output.fullOutputPath);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(directory, { recursive: true, force: true });
  });
}
