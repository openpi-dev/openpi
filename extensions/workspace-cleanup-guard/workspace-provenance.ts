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

interface ShellInspection {
  creations: string[];
  removals: string[];
  opaqueDestructiveCommand: boolean;
}

const DYNAMIC_PATH = /[*?[$`]/u;
const STANDALONE_CONTROL_CHARACTERS = ";&|<>(){}$`*?[]#";
const COMMAND_FORWARDERS = new Set([
  "!",
  "alias",
  "bash",
  "builtin",
  "chroot",
  "command",
  "dash",
  "doas",
  "env",
  "eval",
  "exec",
  "find",
  "hash",
  "ksh",
  "nice",
  "nohup",
  "sandbox-exec",
  "setsid",
  "sh",
  "sudo",
  "time",
  "timeout",
  "trap",
  "watch",
  "xargs",
  "zsh",
]);

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

function standaloneShellTokens(command: string) {
  const source = command.replace(/^[ \t]+|[ \t]+$/gu, "");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let tokenStarted = false;
  const push = () => {
    if (!tokenStarted) return;
    tokens.push(current);
    current = "";
    tokenStarted = false;
  };

  for (const character of source) {
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        if (character !== "\n") {
          current += '$`"\\'.includes(character) ? character : `\\${character}`;
        }
        escaped = false;
      } else if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "$" || character === "`") {
        return undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (escaped) {
      if (character === "\n" || character === "\r") return undefined;
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "\n" || character === "\r") return undefined;
    if (character === " " || character === "\t") {
      push();
      continue;
    }
    if (STANDALONE_CONTROL_CHARACTERS.includes(character)) return undefined;
    current += character;
    tokenStarted = true;
  }
  if (quote || escaped) return undefined;
  push();
  return tokens;
}

function directRmTargets(command: string) {
  const tokens = standaloneShellTokens(command);
  if (!tokens || tokens[0] !== "rm") return undefined;

  const targets: string[] = [];
  let afterOptions = false;
  for (const token of tokens.slice(1)) {
    if (!afterOptions && token === "--") {
      afterOptions = true;
      continue;
    }
    if (!afterOptions && token.startsWith("-")) continue;
    if (!token || token.startsWith("~") || path.isAbsolute(token)) {
      return undefined;
    }
    targets.push(token);
  }
  return targets.length > 0 ? targets : undefined;
}

function inspectCreations(command: string) {
  const creations = new Set<string>();
  for (const segment of splitShellSegments(command)) {
    const tokens = shellTokens(segment);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== ">") continue;
      const target = literalPath(tokens[index + 1]);
      if (target) creations.add(target);
    }

    if (tokens[0]?.split("/").at(-1) !== "mkdir") continue;
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
  return [...creations];
}

function containsRmReference(command: string) {
  let decoded = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (!quote && character === "$" && (next === "'" || next === '"')) {
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (next !== "\n") {
        decoded +=
          quote === '"' && !'$`"\\'.includes(next) ? `\\${next}` : next;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      if (!quote) quote = character;
      else if (quote === character) quote = undefined;
      else decoded += character;
      continue;
    }
    decoded += character;
  }
  return /(^|[^A-Za-z0-9_.-])(?:\/[A-Za-z0-9_.-]+)*\/?rm(?=$|[^A-Za-z0-9_.-])/u.test(
    decoded,
  );
}

function stripShellComment(command: string) {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  let source = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (comment) {
      if (character === "\n") {
        comment = false;
        source += character;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      source += character;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      source += character;
      continue;
    }
    if (character === "'" || character === '"') {
      if (!quote) quote = character;
      else if (quote === character) quote = undefined;
      source += character;
      continue;
    }
    if (
      !quote &&
      character === "#" &&
      (index === 0 || /[\s;&|()]/u.test(command[index - 1] ?? ""))
    ) {
      comment = true;
      continue;
    }
    source += character;
  }
  return source.trimEnd();
}

function heredocContainsExecutableRm(command: string) {
  const lines = command.split("\n");
  if (lines.length < 3) return undefined;
  const header = lines[0] ?? "";
  const match = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*$/u.exec(
    header,
  );
  if (!match) return undefined;
  const stripTabs = match[1] === "-";
  const delimiterQuoted = Boolean(match[2]);
  const delimiter = match[3] ?? "";
  const closing = lines.findIndex((line, index) => {
    if (index === 0) return false;
    return (stripTabs ? line.replace(/^\t+/u, "") : line) === delimiter;
  });
  if (closing < 0 || lines.slice(closing + 1).some((line) => line.trim())) {
    return undefined;
  }
  if (containsRmReference(stripShellComment(header))) return true;
  if (delimiterQuoted) return false;
  const body = lines.slice(1, closing).join("\n");
  return /\$\(|`/u.test(body) && containsRmReference(body);
}

function containsExecutableRmReference(command: string) {
  const heredoc = heredocContainsExecutableRm(command);
  if (heredoc !== undefined) return heredoc;

  const source = stripShellComment(command);
  if (!containsRmReference(source)) return false;
  const tokens = standaloneShellTokens(source);
  if (!tokens) return true;

  const executableIndex = tokens.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token),
  );
  const executable = tokens[executableIndex]?.split("/").at(-1) ?? "";
  if (
    executable === "command" &&
    (tokens[executableIndex + 1] === "-v" ||
      tokens[executableIndex + 1] === "-V")
  ) {
    return false;
  }
  return COMMAND_FORWARDERS.has(executable) || executable === "rm";
}

function inspectShell(command: string): ShellInspection {
  const removals = directRmTargets(command);
  if (removals) {
    return {
      creations: [],
      removals,
      opaqueDestructiveCommand: false,
    };
  }
  if (!containsExecutableRmReference(command)) {
    return {
      creations: inspectCreations(command),
      removals: [],
      opaqueDestructiveCommand: false,
    };
  }
  return {
    creations: [],
    removals: [],
    opaqueDestructiveCommand: true,
  };
}

function containedPath(cwd: string, candidate: string) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
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

  const unverifiedCleanup = () => ({
    kind: "block" as const,
    protectedPaths: [],
    reason:
      "Blocked cleanup: OpenPI recognized a source-visible deletion outside its supported direct rm command grammar. Use a direct rm command with literal workspace-relative paths so OpenPI can determine whether each target is session-created scratch or a pre-existing path requiring confirmation.",
  });

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
      if (inspected.opaqueDestructiveCommand) return unverifiedCleanup();

      const containedRemovals = inspected.removals.map((candidate) =>
        containedPath(attempt.cwd, candidate),
      );
      if (containedRemovals.some((candidate) => !candidate)) {
        return unverifiedCleanup();
      }

      const creations: PendingEffects["creations"] = [];
      for (const candidate of inspected.creations) {
        const creation = await prepareCreation(attempt.cwd, candidate, true);
        if (creation) creations.push(creation);
      }

      const removals: string[] = [];
      const protectedPaths: string[] = [];
      for (const contained of containedRemovals) {
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
