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
 * one bad file cannot take down spawning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CHILD_SAFE_PACKAGE_TOOL_NAMES } from "../../shared/child-session.ts";
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
 * tools this package exposes to children. Used only to flag likely typos: a
 * third-party extension can register tools we cannot know about, so an
 * unrecognized name is reported, never rejected.
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
 * diagnostics. A returned `agentType` may still carry diagnostics (e.g. an
 * unrecognized tool name) — those are advisory, not failures.
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
    if (KNOWN_TOOL_NAMES.includes(tool)) continue;
    diagnostics.push({
      source,
      message: `unrecognized tool "${tool}" in ${name}; it is kept, but a typo here silently removes a capability`,
    });
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
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
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
 * Load global then project agent types. Project entries override global ones of
 * the same name (more specific wins), which is reported so a shadowed global
 * does not silently change meaning.
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
  for (const agentType of global.agentTypes) {
    agentTypes.set(agentType.name, agentType);
  }
  for (const agentType of project.agentTypes) {
    const shadowed = agentTypes.get(agentType.name);
    if (shadowed) {
      diagnostics.push({
        source: agentType.source,
        message: `overrides the agent type of the same name from ${shadowed.source}`,
      });
    }
    agentTypes.set(agentType.name, agentType);
  }

  return { agentTypes, diagnostics };
}

/** One-line-per-problem notice, or undefined when everything loaded cleanly. */
export function formatAgentTypeDiagnostics(
  diagnostics: readonly AgentTypeDiagnostic[],
) {
  if (diagnostics.length === 0) return undefined;
  return [
    `Agent types: ${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"}.`,
    ...diagnostics.map((entry) => `- ${entry.source}: ${entry.message}`),
  ].join("\n");
}
