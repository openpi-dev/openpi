/**
 * Bounded git process execution for the read-only git tools.
 *
 * Reuses the file-search capture discipline: a preview is retained in memory
 * under pi's standard truncation limits while the complete output (up to the
 * 10 MiB capture cap) streams to a temporary file, and the process group is
 * terminated when the cap is exceeded.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect } from "effect";
import type { CapturedOutput } from "../../shared/search-output.ts";
import {
  discardCapturedOutput,
  executeSearchProcess,
} from "../../shared/search-process.ts";
import { GIT_TIMEOUT_MS } from "./args.ts";

export const GIT_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly message: string;
}> {}

export interface GitOutcome {
  readonly output: CapturedOutput;
  readonly exitCode: number;
}

/**
 * Run one git subcommand. Exit code 128 (not a repository / bad revision) and
 * 129 (usage) surface as a GitCommandError carrying stderr; other non-zero
 * exits also fail with the captured stderr detail.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Effect.Effect<GitOutcome, GitCommandError> {
  return Effect.gen(function* () {
    const result = yield* Effect.catchTags(
      executeSearchProcess({
        command: "git",
        args,
        cwd,
        tempPrefix: "pi-git-",
        maxCaptureBytes: GIT_CAPTURE_MAX_BYTES,
      }),
      {
        SearchProcessError: (error) =>
          new GitCommandError({
            message: `failed to run git: ${error.message}`,
          }),
        PlatformError: (error) =>
          new GitCommandError({
            message: `git output capture failed: ${String(error.reason ?? "")}`,
          }),
      },
    );
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || `git exited with code ${result.code}`;
      // A failure means nothing useful was captured; drop the artifact.
      yield* Effect.ignore(discardCapturedOutput(result.output));
      return yield* new GitCommandError({ message: detail });
    }
    return {
      output: result.output,
      exitCode: result.code,
    } satisfies GitOutcome;
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.mapError((error) => {
      if (error._tag === "GitCommandError") return error;
      return new GitCommandError({
        message: `git command timed out after ${timeoutMs}ms`,
      });
    }),
    Effect.provide(NodeServices.layer),
  );
}
