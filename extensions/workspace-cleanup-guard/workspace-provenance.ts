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

interface ShellToken {
  value: string;
  dynamicPath: boolean;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

const DYNAMIC_UNQUOTED_PATH_CHARACTER = /[*?[$`{}]/u;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const COMMAND_POSITION_PREFIXES = new Set([
  "!",
  "{",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
]);

function heredocsInLine(line: string) {
  const heredocs: Heredoc[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStarted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (escaped) {
      escaped = false;
      wordStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === "#" && !wordStarted) break;
    if (/\s/u.test(char) || /[;&|<>]/u.test(char)) wordStarted = false;
    else wordStarted = true;
    if (char !== "<" || next !== "<" || line[index + 2] === "<") {
      continue;
    }

    index += 2;
    let stripTabs = false;
    if (line[index] === "-") {
      stripTabs = true;
      index += 1;
    }
    while (/\s/u.test(line[index] ?? "")) index += 1;

    let delimiter = "";
    let delimiterQuote: "'" | '"' | undefined;
    let delimiterEscaped = false;
    for (; index < line.length; index += 1) {
      const delimiterChar = line[index] ?? "";
      if (delimiterEscaped) {
        delimiter += delimiterChar;
        delimiterEscaped = false;
        continue;
      }
      if (delimiterChar === "\\" && delimiterQuote !== "'") {
        delimiterEscaped = true;
        continue;
      }
      if (delimiterQuote) {
        if (delimiterChar === delimiterQuote) delimiterQuote = undefined;
        else delimiter += delimiterChar;
        continue;
      }
      if (delimiterChar === "'" || delimiterChar === '"') {
        delimiterQuote = delimiterChar;
        continue;
      }
      if (/\s/u.test(delimiterChar) || /[;&|<>]/u.test(delimiterChar)) {
        index -= 1;
        break;
      }
      delimiter += delimiterChar;
    }
    if (delimiter) heredocs.push({ delimiter, stripTabs });
  }
  return heredocs;
}

function withoutHeredocBodies(command: string) {
  const kept: string[] = [];
  const pending: Heredoc[] = [];
  for (const line of command.split("\n")) {
    const heredoc = pending[0];
    if (heredoc) {
      const comparable = (
        heredoc.stripTabs ? line.replace(/^\t+/u, "") : line
      ).replace(/\r$/u, "");
      if (comparable === heredoc.delimiter) pending.shift();
      continue;
    }
    kept.push(line);
    pending.push(...heredocsInLine(line));
  }
  return kept.join("\n");
}

function splitShellSegments(command: string) {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStarted = false;
  let subshellDepth = 0;
  const push = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      wordStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      wordStarted = true;
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
      wordStarted = true;
      continue;
    }
    if (char === "#" && !wordStarted) {
      push();
      while (index + 1 < command.length && command[index + 1] !== "\n") {
        index += 1;
      }
      wordStarted = false;
      continue;
    }
    const opensSubshell = char === "(" && !wordStarted;
    const closesSubshell = char === ")" && subshellDepth > 0;
    if (
      char === "\n" ||
      char === ";" ||
      char === "&" ||
      char === "|" ||
      opensSubshell ||
      closesSubshell
    ) {
      push();
      if (opensSubshell) subshellDepth += 1;
      if (closesSubshell) subshellDepth -= 1;
      if (
        ((char === "&" || char === "|") && next === char) ||
        (char === "|" && next === "&")
      ) {
        index += 1;
      }
      wordStarted = false;
      continue;
    }
    current += char;
    wordStarted = !/\s/u.test(char);
  }
  push();
  return segments;
}

function shellTokens(segment: string) {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let escapeStartedInDoubleQuote = false;
  let tokenStarted = false;
  let dynamicPath = false;
  const push = () => {
    if (!tokenStarted) return;
    tokens.push({ value: current, dynamicPath });
    current = "";
    tokenStarted = false;
    dynamicPath = false;
  };
  for (const char of segment) {
    if (escaped) {
      if (char === "\n") {
        escaped = false;
        escapeStartedInDoubleQuote = false;
        continue;
      }
      if (
        escapeStartedInDoubleQuote &&
        char !== "$" &&
        char !== "`" &&
        char !== '"' &&
        char !== "\\"
      ) {
        current += "\\";
      }
      current += char;
      escaped = false;
      escapeStartedInDoubleQuote = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      escapeStartedInDoubleQuote = quote === '"';
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        current += char;
        if (quote === '"' && (char === "$" || char === "`")) {
          dynamicPath = true;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    if (char === "#" && !tokenStarted) break;
    if (char === ">") {
      push();
      tokens.push({ value: ">", dynamicPath: false });
      continue;
    }
    if (
      DYNAMIC_UNQUOTED_PATH_CHARACTER.test(char) ||
      (char === "~" && !tokenStarted)
    ) {
      dynamicPath = true;
    }
    current += char;
    tokenStarted = true;
  }
  push();
  return tokens;
}

function literalPath(token: ShellToken | undefined) {
  if (!token || token.value === "--" || token.dynamicPath) return undefined;
  return token.value;
}

function executableTokens(tokens: ShellToken[]) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]?.value ?? "";
    if (SHELL_ASSIGNMENT.test(token) || COMMAND_POSITION_PREFIXES.has(token)) {
      index += 1;
      continue;
    }
    if (token.split("/").at(-1) !== "command") break;

    index += 1;
    let queriesCommand = false;
    while (index < tokens.length) {
      const option = tokens[index]?.value ?? "";
      if (option === "--") {
        index += 1;
        break;
      }
      if (!option.startsWith("-") || option === "-") break;
      queriesCommand ||= option.includes("v") || option.includes("V");
      index += 1;
    }
    if (queriesCommand) return [];
  }
  return tokens.slice(index);
}

function inspectShell(command: string): ShellInspection {
  const creations = new Set<string>();
  const removals = new Set<string>();
  let opaqueDestructiveCommand = false;
  for (const segment of splitShellSegments(withoutHeredocBodies(command))) {
    const tokens = shellTokens(segment);
    const nestedBash = tokens.findIndex(
      (token, index) =>
        token.value.split("/").at(-1) === "bash" &&
        tokens[index + 1]?.value === "-c",
    );
    if (nestedBash >= 0) {
      const nestedCommand = tokens[nestedBash + 2]?.value;
      if (nestedCommand) {
        const nested: ShellInspection = inspectShell(nestedCommand);
        for (const target of nested.creations) creations.add(target);
        for (const target of nested.removals) removals.add(target);
        opaqueDestructiveCommand ||= nested.opaqueDestructiveCommand;
      }
      continue;
    }
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.value !== ">") continue;
      const target = literalPath(tokens[index + 1]);
      if (target) creations.add(target);
    }

    const commandTokens = executableTokens(tokens);
    const executable = commandTokens[0]?.value.split("/").at(-1);
    if (executable === "mkdir") {
      const targets: string[] = [];
      let afterOptions = false;
      let supported = true;
      for (const token of commandTokens.slice(1)) {
        if (!afterOptions && token.value === "--") {
          afterOptions = true;
          continue;
        }
        if (
          !afterOptions &&
          (token.value === "-p" || token.value === "--parents")
        ) {
          continue;
        }
        if (!afterOptions && token.value.startsWith("-")) {
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
    for (const token of commandTokens.slice(1)) {
      if (!afterOptions && token.value === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && token.value.startsWith("-")) continue;
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
      if (inspected.opaqueDestructiveCommand) {
        return {
          kind: "block" as const,
          protectedPaths: [],
          reason:
            "Blocked cleanup: the rm command uses a dynamic or otherwise unverified target. Use literal workspace-relative paths so OpenPI can prove whether each target is session-created scratch or a pre-existing path requiring confirmation.",
          opaqueDestructiveCommand: true,
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
