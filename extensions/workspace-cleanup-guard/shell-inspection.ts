import {
  parse,
  type Command,
  type Redirect,
  type Word,
  type WordPart,
} from "unbash";

type UnverifiedReason =
  | "dynamic_executable"
  | "dynamic_rm_target"
  | "indirect_execution"
  | "indirect_rm"
  | "parse_error"
  | "unsupported_syntax";

interface InspectionState {
  creations: Set<string>;
  removals: Set<string>;
  unverifiedReason?: UnverifiedReason;
}

const MAX_AST_DEPTH = 64;
const OUTPUT_REDIRECTS = new Set<Redirect["operator"]>([
  ">",
  ">>",
  "<>",
  ">|",
  "&>",
  "&>>",
]);
const SHELL_EVALUATORS = new Set([
  ".",
  "alias",
  "ash",
  "bash",
  "dash",
  "eval",
  "fish",
  "hash",
  "ksh",
  "sh",
  "source",
  "trap",
  "zsh",
]);
const RM_REFERENCE = /\brm\b/u;

function reject(state: InspectionState, reason: UnverifiedReason) {
  state.unverifiedReason ??= reason;
}

function hasUnescapedGlob(text: string) {
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "*" || character === "?" || character === "[") {
      return true;
    }
  }
  return false;
}

function literalPart(part: WordPart, quoted: boolean): boolean {
  switch (part.type) {
    case "Literal":
      return quoted || !hasUnescapedGlob(part.text);
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "DoubleQuoted":
      return part.parts.every((child) => literalPart(child, true));
    case "SimpleExpansion":
    case "ParameterExpansion":
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "ExtendedGlob":
    case "BraceExpansion":
    case "LocaleString":
      return false;
  }
}

function literalWord(word: Word | undefined) {
  if (!word || word.text.startsWith("~")) return undefined;
  if (word.parts) {
    if (!word.parts.every((part) => literalPart(part, false))) return undefined;
  } else if (hasUnescapedGlob(word.text)) {
    return undefined;
  }
  return word.value;
}

function isCommand(value: unknown): value is Command {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "Command"
  );
}

function isRedirect(value: unknown): value is Redirect {
  return (
    typeof value === "object" &&
    value !== null &&
    "operator" in value &&
    "target" in value &&
    "fileDescriptor" in value
  );
}

function inspectRm(command: Command, state: InspectionState) {
  let afterOptions = false;
  let sawTarget = false;
  for (const word of command.suffix) {
    const value = literalWord(word);
    if (value === undefined) {
      reject(state, "dynamic_rm_target");
      return;
    }
    if (!afterOptions && value === "--") {
      afterOptions = true;
    } else if (afterOptions || !value.startsWith("-")) {
      sawTarget = true;
      state.removals.add(value);
    }
  }
  if (!sawTarget) reject(state, "dynamic_rm_target");
}

function inspectMkdir(command: Command, state: InspectionState) {
  for (const word of command.suffix) {
    const value = literalWord(word);
    if (value !== undefined && !value.startsWith("-")) {
      state.creations.add(value);
    }
  }
}

function inspectCommand(command: Command, state: InspectionState) {
  if (!command.name) return;
  const name = literalWord(command.name);
  if (name === undefined) {
    reject(state, "dynamic_executable");
    return;
  }
  const executable = name.split("/").at(-1) ?? "";
  if (executable === "rm") {
    inspectRm(command, state);
    return;
  }
  if (executable === "mkdir") inspectMkdir(command, state);
  if (SHELL_EVALUATORS.has(executable)) {
    reject(state, "indirect_execution");
    return;
  }
  if (
    command.prefix.some((assignment) =>
      RM_REFERENCE.test(literalWord(assignment.value) ?? ""),
    ) ||
    command.suffix.some((word) => RM_REFERENCE.test(literalWord(word) ?? ""))
  ) {
    reject(state, "indirect_rm");
  }
}

function inspectRedirect(redirect: Redirect, state: InspectionState) {
  if (!OUTPUT_REDIRECTS.has(redirect.operator)) return;
  const target = literalWord(redirect.target);
  if (target !== undefined) state.creations.add(target);
}

function inspectAst(value: unknown, state: InspectionState, depth: number) {
  if (state.unverifiedReason) return;
  if (depth >= MAX_AST_DEPTH) {
    reject(state, "unsupported_syntax");
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) inspectAst(child, state, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (
    "errors" in value &&
    Array.isArray(value.errors) &&
    value.errors.length > 0
  ) {
    reject(state, "parse_error");
    return;
  }
  if (isCommand(value)) inspectCommand(value, state);
  if (isRedirect(value)) inspectRedirect(value, state);
  if ("parts" in value && Array.isArray(value.parts)) {
    inspectAst(value.parts, state, depth + 1);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "parts") continue;
    inspectAst(child, state, depth + 1);
  }
}

export function inspectShell(command: string) {
  const state: InspectionState = {
    creations: new Set(),
    removals: new Set(),
  };
  try {
    inspectAst(parse(command), state, 0);
  } catch {
    reject(state, "parse_error");
  }
  if (state.unverifiedReason) {
    return {
      kind: "unverified" as const,
      reason: state.unverifiedReason,
    };
  }
  return {
    kind: "verified" as const,
    creations: [...state.creations],
    removals: [...state.removals],
  };
}
