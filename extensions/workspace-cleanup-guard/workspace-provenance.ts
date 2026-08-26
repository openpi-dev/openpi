import { lstat } from "node:fs/promises";
import path from "node:path";
import { inspectShell } from "./shell-inspection.ts";

type Origin = "baseline" | "session_created";

interface PendingEffects {
  creations: Array<{
    path: string;
    existed: boolean;
    observeOnCommandError: boolean;
  }>;
  removals: string[];
}

interface BashAttempt {
  id: string;
  command: string;
  cwd: string;
  confirmDelete: (paths: readonly string[]) => Promise<boolean>;
}

interface WriteAttempt {
  id: string;
  path: string;
  cwd: string;
}

function containedPath(cwd: string, candidate: string) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

async function exists(candidate: string) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function createWorkspaceCleanupGuard() {
  const origins = new Map<string, Origin>();
  const pending = new Map<string, PendingEffects>();

  const prepareCreation = async (
    cwd: string,
    candidate: string,
    observeOnCommandError: boolean,
  ) => {
    const contained = containedPath(cwd, candidate);
    if (!contained) return undefined;
    const existed = await exists(contained.absolute);
    if (existed && !origins.has(contained.absolute)) {
      origins.set(contained.absolute, "baseline");
    }
    return { path: contained.absolute, existed, observeOnCommandError };
  };

  return {
    async beforeWrite(attempt: WriteAttempt) {
      const creation = await prepareCreation(attempt.cwd, attempt.path, false);
      pending.set(attempt.id, {
        creations: creation ? [creation] : [],
        removals: [],
      });
    },

    async before(attempt: BashAttempt) {
      const inspected = inspectShell(attempt.command);
      if (inspected.kind === "unverified") {
        return {
          kind: "block" as const,
          protectedPaths: [],
          reason:
            "Blocked cleanup: OpenPI could not prove this shell command's deletion effects. Use a direct rm command with literal workspace-relative paths so OpenPI can determine whether each target is session-created scratch or a pre-existing path requiring confirmation.",
        };
      }

      const creations: PendingEffects["creations"] = [];
      for (const candidate of inspected.creations) {
        const creation = await prepareCreation(attempt.cwd, candidate, true);
        if (creation) creations.push(creation);
      }

      const removals: string[] = [];
      const protectedPaths: string[] = [];
      for (const candidate of inspected.removals) {
        const contained = containedPath(attempt.cwd, candidate);
        if (!contained) continue;
        const origin = origins.get(contained.absolute);
        const present = await exists(contained.absolute);
        if (present && !origin) origins.set(contained.absolute, "baseline");
        if (present && origins.get(contained.absolute) !== "session_created") {
          protectedPaths.push(contained.relative);
        }
        removals.push(contained.absolute);
      }

      if (
        protectedPaths.length > 0 &&
        !(await attempt.confirmDelete(protectedPaths))
      ) {
        return {
          kind: "block" as const,
          protectedPaths,
          reason: `Blocked cleanup: ${protectedPaths.join(", ")} existed before this agent changed it and is not proven session-created scratch. Retry the cleanup without that path, or obtain explicit user confirmation to delete it.`,
        };
      }

      pending.set(attempt.id, { creations, removals });
      return { kind: "allow" as const };
    },

    async after(result: { id: string; isError: boolean }) {
      const effects = pending.get(result.id);
      pending.delete(result.id);
      if (!effects) return;
      for (const creation of effects.creations) {
        if (
          !creation.existed &&
          (!result.isError || creation.observeOnCommandError) &&
          !origins.has(creation.path) &&
          (await exists(creation.path))
        ) {
          origins.set(creation.path, "session_created");
        }
      }
      for (const removed of effects.removals) {
        if (
          origins.get(removed) === "session_created" &&
          !(await exists(removed))
        ) {
          origins.delete(removed);
        }
      }
    },

    reset() {
      origins.clear();
      pending.clear();
    },
  };
}
