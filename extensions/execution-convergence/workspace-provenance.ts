import { lstat } from "node:fs/promises";
import path from "node:path";

type Origin = "baseline" | "session_created";

interface PendingEffects {
  creations: Array<{
    path: string;
    existed: boolean;
    observeOnCommandError: boolean;
  }>;
  removals: string[];
}

interface Options {
  confirmDelete: (paths: readonly string[]) => Promise<boolean>;
}

interface BashAttempt {
  id: string;
  command: string;
  cwd: string;
}

interface WriteAttempt {
  id: string;
  path: string;
  cwd: string;
}

interface ShellInspection {
  creations: string[];
  removals: string[];
  opaqueDestructiveCommand: boolean;
}

const DYNAMIC_PATH = /[*?[$`]/u;

function splitShellSegments(command: string) {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === "\n" ||
      char === ";" ||
      (char === "&" && next === "&") ||
      (char === "|" && next === "|")
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((char === "&" || char === "|") && next === char) index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellTokens(segment: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };
  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    if (char === ">") {
      push();
      tokens.push(">");
      continue;
    }
    current += char;
  }
  push();
  return tokens;
}

function literalPath(value: string | undefined) {
  if (!value || value === "--" || DYNAMIC_PATH.test(value)) return undefined;
  return value;
}

function inspectShell(command: string): ShellInspection {
  const creations = new Set<string>();
  const removals = new Set<string>();
  let opaqueDestructiveCommand = false;
  for (const segment of splitShellSegments(command)) {
    const tokens = shellTokens(segment);
    const nestedBash = tokens.findIndex(
      (token, index) =>
        token.split("/").at(-1) === "bash" && tokens[index + 1] === "-c",
    );
    if (nestedBash >= 0) {
      const nestedCommand = tokens[nestedBash + 2];
      if (nestedCommand) {
        const nested: ShellInspection = inspectShell(nestedCommand);
        for (const target of nested.creations) creations.add(target);
        for (const target of nested.removals) removals.add(target);
        opaqueDestructiveCommand ||= nested.opaqueDestructiveCommand;
      }
      continue;
    }
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== ">") continue;
      const target = literalPath(tokens[index + 1]);
      if (target) creations.add(target);
    }

    const executable = tokens[0]?.split("/").at(-1);
    if (executable === "mkdir") {
      const targets: string[] = [];
      let afterOptions = false;
      let supported = true;
      for (const token of tokens.slice(1)) {
        if (!afterOptions && token === "--") {
          afterOptions = true;
          continue;
        }
        if (!afterOptions && (token === "-p" || token === "--parents")) {
          continue;
        }
        if (!afterOptions && token.startsWith("-")) {
          supported = false;
          break;
        }
        const target = literalPath(token);
        if (!target) {
          supported = false;
          break;
        }
        targets.push(target);
      }
      if (supported) {
        for (const target of targets) creations.add(target);
      }
    }
    if (executable !== "rm") continue;
    let sawLiteral = false;
    let afterOptions = false;
    for (const token of tokens.slice(1)) {
      if (!afterOptions && token === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && token.startsWith("-")) continue;
      const target = literalPath(token);
      if (!target) {
        opaqueDestructiveCommand = true;
        continue;
      }
      sawLiteral = true;
      removals.add(target);
    }
    if (!sawLiteral) opaqueDestructiveCommand = true;
  }
  if (/\brm\b/u.test(command) && removals.size === 0) {
    opaqueDestructiveCommand = true;
  }
  return {
    creations: [...creations],
    removals: [...removals],
    opaqueDestructiveCommand,
  };
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

export function createWorkspaceCleanupGuard(options: Options) {
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
        !(await options.confirmDelete(protectedPaths))
      ) {
        return {
          kind: "block" as const,
          protectedPaths,
          reason: `Blocked cleanup: ${protectedPaths.join(", ")} existed before this agent changed it and is not proven session-created scratch. Retry the cleanup without that path, or obtain explicit user confirmation to delete it.`,
          opaqueDestructiveCommand: inspected.opaqueDestructiveCommand,
        };
      }

      pending.set(attempt.id, { creations, removals });
      return {
        kind: "allow" as const,
        opaqueDestructiveCommand: inspected.opaqueDestructiveCommand,
      };
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
