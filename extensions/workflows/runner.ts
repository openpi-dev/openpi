/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, no extensions (so the
 * `workflow` tool can never recurse), skills + AGENTS.md context still loaded,
 * and an optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { emptyUsage, type AgentUsage, type TranscriptEntry } from "./model.ts";

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}

const STRUCTURED_OUTPUT_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/**
 * Build a resource loader for workflow subagents. Extensions are disabled (no
 * recursion into `workflow`), while skills and AGENTS.md context still load.
 * One loader per variant is shared across all agents in a run.
 */
export async function createWorkflowLoader(
  cwd: string,
  variant: "plain" | "structured",
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    ...(variant === "structured"
      ? { appendSystemPrompt: [STRUCTURED_OUTPUT_INSTRUCTION] }
      : {}),
  });
  await loader.reload();
  return loader;
}

/**
 * Convert the JSON-schema-ish object a workflow script passes as `schema`
 * into a TypeBox schema usable as tool parameters. Covers the practical
 * subset (object/array/string/number/integer/boolean, enums, required,
 * descriptions); unknown shapes degrade to Type.Any().
 */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") return Type.Any();
  const node = schema as {
    type?: unknown;
    description?: unknown;
    enum?: unknown;
    properties?: Record<string, unknown>;
    required?: unknown;
    items?: unknown;
  };
  const opts =
    typeof node.description === "string"
      ? { description: node.description }
      : {};

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return Type.Union(
      node.enum.map((value) =>
        Type.Literal(value as string | number | boolean),
      ),
      opts,
    );
  }

  // Tolerate schemas that omit `type` but are still unambiguous.
  const inferredType =
    node.type ??
    (node.properties !== undefined || node.required !== undefined
      ? "object"
      : node.items !== undefined
        ? "array"
        : undefined);

  switch (inferredType) {
    case "object": {
      const properties = node.properties ?? {};
      const required = Array.isArray(node.required) ? node.required : [];
      const props: Record<string, TSchema> = {};
      for (const key of Object.keys(properties)) {
        const child = jsonSchemaToTypebox(properties[key]);
        props[key] = required.includes(key) ? child : Type.Optional(child);
      }
      return Type.Object(props, opts);
    }
    case "array":
      return Type.Array(jsonSchemaToTypebox(node.items), opts);
    case "string":
      return Type.String(opts);
    case "number":
    case "integer":
      return Type.Number(opts);
    case "boolean":
      return Type.Boolean(opts);
    default:
      return Type.Any();
  }
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.",
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
function transcriptFromMessages(messages: AgentMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
              )
              .join("\n");
      if (text.trim()) {
        entries.push({ role: "user", text, timestamp: message.timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          entries.push({
            role: "assistant",
            text: part.text,
            timestamp: message.timestamp,
          });
        } else if (part.type === "thinking" && part.thinking.trim()) {
          entries.push({
            role: "thinking",
            text: part.thinking,
            timestamp: message.timestamp,
          });
        } else if (part.type === "toolCall") {
          entries.push({
            role: "tool",
            name: part.name,
            text: safeJson(part.arguments),
            timestamp: message.timestamp,
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const text = message.content
      .map((part) =>
        part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
      )
      .join("\n");
    entries.push({
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
    });
  }
  return entries;
}

function computeUsage(messages: AgentMessage[]): AgentUsage {
  const usage = emptyUsage();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    usage.turns++;
    const u = msg.usage;
    if (!u) continue;
    usage.input += u.input || 0;
    usage.output += u.output || 0;
    usage.cacheRead += u.cacheRead || 0;
    usage.cacheWrite += u.cacheWrite || 0;
    usage.cost += u.cost?.total || 0;
    if (u.totalTokens) usage.contextTokens = u.totalTokens;
  }
  return usage;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  const customTools =
    options.schema !== undefined
      ? [
          makeStructuredOutputTool(options.schema, (value) => {
            structured = value;
          }),
        ]
      : undefined;

  let session: AgentSession;
  try {
    ({ session } = await createAgentSession({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      modelRegistry: options.modelRegistry,
      resourceLoader: options.loader,
      sessionManager: SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
    }));
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}`,
      aborted: false,
      usage: emptyUsage(),
      transcript: [],
    };
  }

  let usage = emptyUsage();
  let modelId = options.model?.id;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  const sync = () => {
    const messages = session.messages;
    usage = computeUsage(messages);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      if (msg.model) modelId = msg.model;
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;
      break;
    }
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" && event.type !== "tool_execution_end")
      return;
    sync();
    options.onProgress?.({
      preview: finalOutput(session.messages),
      usage,
      model: modelId,
      transcript: transcriptFromMessages(session.messages),
    });
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void session.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let output = "";
  let transcript: TranscriptEntry[] = [];
  try {
    await session.prompt(options.prompt);
  } catch (error) {
    errorMessage = errorMessage ?? errorText(error);
    stopReason = stopReason ?? "error";
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    sync();
    output = finalOutput(session.messages);
    transcript = transcriptFromMessages(session.messages);
    try {
      session.dispose();
    } catch {
      // Best-effort dispose.
    }
  }

  if (aborted || stopReason === "aborted") {
    return {
      ok: false,
      output,
      structured,
      error: "Agent was aborted",
      aborted: true,
      usage,
      model: modelId,
      transcript,
    };
  }

  const failed = stopReason === "error" || errorMessage !== undefined;
  if (failed) {
    return {
      ok: false,
      output,
      structured,
      error: errorMessage ?? "Agent failed",
      aborted: false,
      usage,
      model: modelId,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage,
      model: modelId,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage,
    model: modelId,
    transcript,
  };
}
