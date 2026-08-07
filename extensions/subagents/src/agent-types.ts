/**
 * Agent types: reusable subagent definitions loaded from `agents/*.md`.
 *
 * A type fixes what a spawned child IS — an optional system-prompt addendum, an
 * optional model/thinking level, and above all an enforced tool allowlist — so
 * "this subagent is read-only" becomes a capability boundary instead of a
 * request the child can ignore.
 *
 * The allowlist can only ever NARROW. Pi composes it with the child denylist as
 * `(!allowed || allowed.has(name)) && !excluded.has(name)`, so naming an
 * excluded tool here cannot resurrect it (see `../../shared/child-session.ts`).
 *
 * Discovery is two-tier: `<agentDir>/agents/*.md` always, and `<cwd>/.pi/agents/
 * *.md` only in a trusted project — a project file supplies an
 * attacker-controllable system prompt and tool list, so an untrusted repo must
 * contribute none. Project files win on a name collision.
 *
 * Malformed files never throw: they are skipped and reported as diagnostics, so
 * one bad file cannot take down spawning. Unknown frontmatter keys are malformed
 * too: ignoring a misspelled restriction key could otherwise widen the child.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  parseFrontmatter,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_EXCLUDED_TOOL_NAMES,
  CHILD_SAFE_PACKAGE_TOOL_NAMES,
} from "../../shared/child-session.ts";
import { sanitizeTerminalText } from "../../shared/terminal-text.ts";
import {
  isSubagentRoleName,
  type SubagentRoleModel,
} from "../../shared/subagent-roles.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "./domain.ts";

/** Directory name scanned under both the agent dir and a project's `.pi`. */
export const AGENT_TYPES_DIR_NAME = "agents";

/** Bounds mirroring the Agent Skills conventions Pi uses for `SKILL.md`. */
export const AGENT_TYPE_LIMITS = Object.freeze({
  nameChars: 64,
  descriptionChars: 1024,
  bodyChars: 16_384,
  tools: 64,
  files: 128,
});

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Pi's built-in tools (`read bash edit write grep find ls`) plus the read-only
 * tools this package exposes to children. Used only for an early diagnostic: a
 * third-party extension can register other names, whose actual availability is
 * verified against each final bound child registry before its first prompt.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  ...CHILD_SAFE_PACKAGE_TOOL_NAMES,
];

/**
 * Every key `parseAgentType` reads. Anything else is reported, because a
 * misspelled key fails in the dangerous direction: `tool:` leaves `tools`
 * undefined and yields a child with the full inherited toolset, indis-
 * tinguishable from a type that deliberately inherits everything.
 */
export const KNOWN_FRONTMATTER_KEYS: readonly string[] = [
  "name",
  "description",
  "tools",
  "model",
  "reasoning_effort",
  "reasoningEffort",
];

export interface AgentType {
  readonly name: string;
  readonly description: string;
  /** Omitted = the child keeps the normal tool set. Present = allowlist. */
  readonly tools?: readonly string[];
  /** "provider/model-id" or a bare id; resolved by the pi backend. */
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Markdown body, appended to the child's system prompt. */
  readonly body?: string;
  /** Absolute path this type was loaded from, for diagnostics. */
  readonly source: string;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "fd", "rg"];

/**
 * Built-in role definitions are deliberately provider-free: model selection is
 * inherited unless the user assigns one in package setup. Files may replace a
 * complete role definition; `loadAgentTypes` reports every replacement.
 */
export const BUILT_IN_AGENT_TYPES: readonly AgentType[] = [
  {
    name: "explorer",
    description:
      "Read-only codebase exploration. Use high for routine, local, direct tracing; xhigh for interacting state transitions, concurrency or trust boundaries, or subtle multi-path lifecycle/control-flow; max only for exceptionally difficult broad unfamiliar architecture with unresolved competing flows.",
    tools: READ_ONLY_TOOLS,
    reasoningEffort: "high",
    body: "Explore the codebase read-only. Trace the real flow, inspect related callers, and report concise evidence with file paths and line references.",
    source: "built-in:explorer",
  },
  {
    name: "implementer",
    description: "Focused implementation with repository checks.",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "fd", "rg"],
    reasoningEffort: "high",
    body: "Implement the requested change carefully. Trace the affected flow first, make the smallest correct edit, and run relevant checks before reporting results.",
    source: "built-in:implementer",
  },
  {
    name: "reviewer",
    description: "Read-only review for correctness, safety, and regressions.",
    tools: READ_ONLY_TOOLS,
    reasoningEffort: "medium",
    body: "Review the requested code or change read-only. Identify concrete correctness, security, and regression risks with evidence; do not modify files.",
    source: "built-in:reviewer",
  },
  {
    name: "advisor",
    description: "Deep read-only analysis and technical advice.",
    tools: READ_ONLY_TOOLS,
    reasoningEffort: "xhigh",
    body: "Analyze the problem deeply without modifying files. Explain the relevant tradeoffs, risks, and recommended next step using repository evidence.",
    source: "built-in:advisor",
  },
];

/**
 * Resolves the model hint without turning inherited-parent selection into a
 * hardcoded default. The backend receives undefined to preserve inheritance.
 */
export function selectSubagentModel(
  explicitModel: string | undefined,
  agentType: AgentType | undefined,
  roleModel: SubagentRoleModel | undefined,
) {
  return (
    explicitModel ??
    agentType?.model ??
    (roleModel ? `${roleModel.provider}/${roleModel.model}` : undefined)
  );
}

/**
 * Resolve a model hint consistently for direct and Workflow children.
 * Provider-qualified hints are exact; bare ids prefer the parent provider and
 * otherwise must be unique. No hint inherits the parent model.
 */
export function resolveAgentModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): Model<any> | undefined {
  if (!hint) {
    if (!inherited) return undefined;
    const found = registry.find(inherited.provider, inherited.id);
    if (found) return found;
    throw new Error(
      `Inherited model "${inherited.provider}/${inherited.id}" is no longer available. Choose an available model explicitly.`,
    );
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((model) => model.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((model) => model.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

/** Return a package assignment only for the four built-in role names. */
export function roleModelForAgentType(
  agentType: AgentType | undefined,
  roleModels: Partial<Record<string, SubagentRoleModel>>,
) {
  return agentType && isSubagentRoleName(agentType.name)
    ? roleModels[agentType.name]
    : undefined;
}

export interface AgentTypeDiagnostic {
  /** File the problem came from, or the directory for a scan failure. */
  readonly source: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** YAML gives us real types, so accept only a string and trim it. */
function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * Accept `[a, b]` and `a, b` alike: the flow-sequence form is what the docs
 * show, but a plain comma string is the mistake people actually make.
 */
function readToolList(
  value: unknown,
):
  | { readonly error: string; readonly tools?: undefined }
  | { readonly tools: string[]; readonly error?: undefined }
  | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined;
  if (!raw) return { error: "tools must be a list of tool names" };
  const tools: string[] = [];
  for (const entry of raw) {
    const name = readString(entry);
    if (!name) return { error: "tools entries must be non-empty strings" };
    if (!tools.includes(name)) tools.push(name);
  }
  if (tools.length === 0) {
    // An empty list would silently mean "no tools at all", which is never what
    // someone means by writing the key. Omitting it is how you inherit.
    return { error: "tools is empty; omit it to inherit the normal tool set" };
  }
  if (tools.length > AGENT_TYPE_LIMITS.tools) {
    return { error: `tools exceeds ${AGENT_TYPE_LIMITS.tools} entries` };
  }
  return { tools };
}

export type ParseAgentTypeResult =
  | {
      readonly agentType: AgentType;
      readonly diagnostics: AgentTypeDiagnostic[];
    }
  | {
      readonly agentType?: undefined;
      readonly diagnostics: AgentTypeDiagnostic[];
    };

/**
 * Parse one agent-type document. Pure: `source` is only echoed into
 * diagnostics. Unknown tool names remain advisory because extensions can
 * register them; unknown frontmatter keys reject the whole type because a
 * misspelled restriction key could otherwise expand capability.
 */
export function parseAgentType(
  content: string,
  stem: string,
  source = stem,
): ParseAgentTypeResult {
  const diagnostics: AgentTypeDiagnostic[] = [];
  const fail = (message: string) => ({
    diagnostics: [...diagnostics, { source, message }],
  });

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    if (!isRecord(parsed.frontmatter)) return fail("frontmatter must be a map");
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (error) {
    return fail(
      `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const name = readString(frontmatter.name);
  if (!name) return fail("missing required `name`");
  if (name.length > AGENT_TYPE_LIMITS.nameChars) {
    return fail(`name exceeds ${AGENT_TYPE_LIMITS.nameChars} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    return fail(
      `name "${name}" must be lowercase letters, digits, and single hyphens`,
    );
  }
  // A renamed file with a stale `name` would otherwise shadow a different type
  // than the filename suggests.
  if (name !== stem) {
    return fail(`name "${name}" does not match filename "${stem}.md"`);
  }

  const description = readString(frontmatter.description);
  if (!description) return fail("missing required `description`");
  if (description.length > AGENT_TYPE_LIMITS.descriptionChars) {
    return fail(
      `description exceeds ${AGENT_TYPE_LIMITS.descriptionChars} characters`,
    );
  }

  const toolList = readToolList(frontmatter.tools);
  if (toolList?.error !== undefined) return fail(toolList.error);
  const tools = toolList?.tools;
  for (const tool of tools ?? []) {
    if (CHILD_EXCLUDED_TOOL_NAMES.includes(tool as never)) {
      diagnostics.push({
        source,
        message: `"${tool}" in ${name} is a parent-only tool; the child cannot receive it, so it is ignored`,
      });
      continue;
    }
    if (KNOWN_TOOL_NAMES.includes(tool)) continue;
    diagnostics.push({
      source,
      message: `unrecognized tool "${tool}" in ${name}; launch will verify it after child extensions initialize`,
    });
  }
  // A misspelled KEY is the dangerous direction: `tool:` or `allowed_tools:`
  // parses cleanly, leaves `tools` undefined, and would produce a child with
  // the full inherited toolset. There is no safe distinction between a typo
  // in a restriction-relevant key and a harmless future key, so reject every
  // unknown key rather than guessing and widening capability.
  const unknownKeys = Object.keys(frontmatter).filter(
    (key) => !KNOWN_FRONTMATTER_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    return fail(
      `unrecognized frontmatter key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.map((key) => `"${key}"`).join(", ")}; the agent type was rejected because ignored keys could change its tool restrictions`,
    );
  }

  const model = readString(frontmatter.model);

  const rawEffort =
    readString(frontmatter.reasoning_effort) ??
    readString(frontmatter.reasoningEffort);
  if (rawEffort && !REASONING_EFFORTS.includes(rawEffort as ReasoningEffort)) {
    return fail(
      `reasoning_effort "${rawEffort}" must be one of ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  const reasoningEffort = rawEffort as ReasoningEffort | undefined;

  const trimmedBody = body.trim();
  if (trimmedBody.length > AGENT_TYPE_LIMITS.bodyChars) {
    return fail(`body exceeds ${AGENT_TYPE_LIMITS.bodyChars} characters`);
  }

  return {
    agentType: {
      name,
      description,
      ...(tools ? { tools } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(trimmedBody ? { body: trimmedBody } : {}),
      source,
    },
    diagnostics,
  };
}

/** Read one directory of `*.md` agent types. A missing directory is normal. */
function loadDirectory(directory: string) {
  const agentTypes: AgentType[] = [];
  const diagnostics: AgentTypeDiagnostic[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // Not existing is the common case and not worth reporting; anything else
    // (permissions, a file where a directory belongs) is.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      diagnostics.push({
        source: directory,
        message: `could not read agent types: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { agentTypes, diagnostics };
  }

  const files = entries
    .filter((entry) => {
      if (!entry.name.endsWith(".md")) return false;
      if (entry.isFile()) return true;
      // A symlinked type is the normal shape when these live in a dotfiles
      // repo, and `isFile()` is false for one. Skipping it silently means the
      // user's type simply never appears — no diagnostic, no enum entry. Pi's
      // own skills loader resolves symlinks for exactly this reason.
      if (!entry.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(directory, entry.name)).isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort();

  if (files.length > AGENT_TYPE_LIMITS.files) {
    diagnostics.push({
      source: directory,
      message: `more than ${AGENT_TYPE_LIMITS.files} agent types; ignoring the rest`,
    });
  }

  for (const file of files.slice(0, AGENT_TYPE_LIMITS.files)) {
    const filePath = path.join(directory, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      diagnostics.push({
        source: filePath,
        message: `could not read file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const result = parseAgentType(content, file.slice(0, -3), filePath);
    diagnostics.push(...result.diagnostics);
    if (result.agentType) agentTypes.push(result.agentType);
  }

  return { agentTypes, diagnostics };
}

export interface LoadAgentTypesOptions {
  readonly agentDir: string;
  readonly cwd: string;
  /** Untrusted projects contribute no agent types. */
  readonly projectTrusted: boolean;
}

/**
 * Load built-in then global then project agent types. Each more-specific layer
 * overrides a complete same-name definition, and every replacement is reported
 * so a role never changes meaning silently.
 */
export function loadAgentTypes(options: LoadAgentTypesOptions) {
  const global = loadDirectory(
    path.join(options.agentDir, AGENT_TYPES_DIR_NAME),
  );
  const project = options.projectTrusted
    ? loadDirectory(path.join(options.cwd, ".pi", AGENT_TYPES_DIR_NAME))
    : { agentTypes: [], diagnostics: [] };

  const diagnostics = [...global.diagnostics, ...project.diagnostics];
  const agentTypes = new Map<string, AgentType>();
  for (const layer of [
    BUILT_IN_AGENT_TYPES,
    global.agentTypes,
    project.agentTypes,
  ]) {
    for (const agentType of layer) {
      const shadowed = agentTypes.get(agentType.name);
      if (shadowed) {
        diagnostics.push({
          source: agentType.source,
          message: `overrides the agent type of the same name from ${shadowed.source}`,
        });
      }
      agentTypes.set(agentType.name, agentType);
    }
  }

  return { agentTypes, diagnostics };
}

/** One-line-per-problem notice, or undefined when everything loaded cleanly. */
export function formatAgentTypeDiagnostics(
  diagnostics: readonly AgentTypeDiagnostic[],
) {
  if (diagnostics.length === 0) return undefined;
  return sanitizeTerminalText(
    [
      `Agent types: ${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}.`,
      ...diagnostics.map((entry) => `- ${entry.source}: ${entry.message}`),
    ].join("\n"),
  );
}
