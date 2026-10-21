/** Ephemeral bridge from child tool events to Pi's canonical tool renderer. */

import {
  type AgentSession,
  type MarkdownTransformer,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  activityEnabled,
  activityRenderers,
} from "../file-mutation-display/render.ts";
import { loadSetupConfig } from "./setup-config.ts";

export interface AgentToolRenderRequest {
  readonly toolId: string;
  readonly name: string;
  readonly cwd?: string;
  /** The child page's local Pi-native evidence visibility. */
  readonly expanded?: boolean;
}

/** Operator-only projection. It is deliberately absent from persisted state. */
export interface AgentToolRenderer {
  renderTool(
    request: AgentToolRenderRequest,
    width: number,
  ): string[] | undefined;
  readonly messagePresentation?: AgentMessagePresentation;
  invalidate?(): void;
}

export interface AgentMessagePresentation {
  readonly hideThinking: boolean;
  readonly outputPad: number;
  readonly codeBlockIndent: string;
  readonly markdownTransformers: readonly MarkdownTransformer[];
}

type Presentation = Pick<
  ToolDefinition,
  "renderCall" | "renderResult" | "renderShell"
>;

/** Use the child Session's own public presentation chain, never its executor. */
export function createAgentToolRenderLedger(session: AgentSession) {
  const runner = session.extensionRunner as typeof session.extensionRunner & {
    resolveToolRenderers?: (
      name: string,
      base: () => Presentation | undefined,
    ) => Presentation | undefined;
  };
  return new AgentToolRenderLedger(
    (name, definition) => {
      if (typeof runner.resolveToolRenderers === "function") {
        return runner.resolveToolRenderers(name, () => definition);
      }
      // Older Pi has no presentation resolver. Reuse OpenPI's projection
      // locally, without registering/replacing the headless child's tools.
      return definition && activityEnabled(name, loadSetupConfig().ui)
        ? { ...definition, ...activityRenderers(name, definition) }
        : definition;
    },
    () => ({
      hideThinking: session.settingsManager.getHideThinkingBlock(),
      outputPad: session.settingsManager.getOutputPad(),
      codeBlockIndent: session.settingsManager.getCodeBlockIndent(),
      markdownTransformers: runner.getMarkdownTransformers(),
    }),
  );
}

type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

interface ToolExecutionRecord {
  name: string;
  args: unknown;
  definition?: ToolDefinition;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: ToolResult;
  resultSource?: unknown;
  isPartial: boolean;
  component?: ToolExecutionComponent;
  componentCwd?: string;
  componentExpanded?: boolean;
  /** Payload bytes counted against the ledger budget. */
  bytes: number;
}

const inertTui = {
  requestRender() {},
} as TUI;

/**
 * Direct keeps at most 512 transcript items and each settled tool is one of
 * them; a Workflow child keeps 200 entries. Retaining this many settled tools
 * therefore never drops one a child page can still show by count alone.
 */
export const MAX_RETAINED_TOOL_RENDERS = 512;
/** Total argument and result text the ledger may keep reachable. */
export const MAX_RETAINED_TOOL_RENDER_BYTES = 8 * 1024 * 1024;
const PAYLOAD_MAX_DEPTH = 8;

/** UTF-8 bytes of the strings an event payload keeps reachable. */
function payloadBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (!value || typeof value !== "object" || depth >= PAYLOAD_MAX_DEPTH)
    return 0;
  let bytes = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value))
    bytes += payloadBytes(child, depth + 1);
  return bytes;
}

function resultContent(value: unknown): ToolResult["content"] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!value || typeof value !== "object") return [];
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    if (typeof candidate.type !== "string") return [];
    return [
      {
        type: candidate.type,
        ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
        ...(typeof candidate.data === "string" ? { data: candidate.data } : {}),
        ...(typeof candidate.mimeType === "string"
          ? { mimeType: candidate.mimeType }
          : {}),
      },
    ];
  });
}

function normalizeResult(value: unknown, isError: boolean): ToolResult {
  const details =
    value && typeof value === "object"
      ? (value as { details?: unknown }).details
      : undefined;
  return {
    content: resultContent(value),
    ...(details === undefined ? {} : { details }),
    isError,
  };
}

/**
 * Retains the real definition and event payloads only for the lifetime of the
 * child session/run. The model transcript and persisted artifacts remain the
 * compact, serializable source of execution facts.
 *
 * A long-lived child (many Direct `send`s, or a Workflow run still going) can
 * produce far more tool calls than its transcript keeps, so the oldest settled
 * records are evicted past a count and byte budget. An evicted tool renders
 * through the transcript's bounded preview fallback; running tools are never
 * evicted.
 */
export class AgentToolRenderLedger implements AgentToolRenderer {
  private executions = new Map<string, ToolExecutionRecord>();
  private retainedBytes = 0;

  private resolveRenderers?: (
    name: string,
    definition?: ToolDefinition,
  ) => Presentation | undefined;
  private getMessagePresentation?: () => AgentMessagePresentation;

  constructor(
    resolveRenderers?: (
      name: string,
      definition?: ToolDefinition,
    ) => Presentation | undefined,
    getMessagePresentation?: () => AgentMessagePresentation,
  ) {
    this.resolveRenderers = resolveRenderers;
    this.getMessagePresentation = getMessagePresentation;
  }

  get messagePresentation() {
    return this.getMessagePresentation?.();
  }

  start(
    toolId: string,
    name: string,
    args: unknown,
    definition?: ToolDefinition,
  ) {
    const current = this.executions.get(toolId);
    if (current) {
      if (definition && definition !== current.definition) {
        current.definition = definition;
        current.component = undefined;
        current.componentCwd = undefined;
        current.componentExpanded = undefined;
      }
      current.name = name;
      if (current.args !== args) {
        current.args = args;
        current.component?.updateArgs(args);
        this.account(current);
      }
      const wasStarted = current.executionStarted;
      const wereArgsComplete = current.argsComplete;
      current.executionStarted = true;
      current.argsComplete = true;
      if (!wasStarted) current.component?.markExecutionStarted();
      if (!wereArgsComplete) current.component?.setArgsComplete();
      return;
    }
    this.add(toolId, {
      name,
      args,
      ...(definition ? { definition } : {}),
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      bytes: 0,
    });
  }

  update(toolId: string, name: string, args: unknown, result: unknown) {
    const current = this.executions.get(toolId);
    if (!current) {
      this.add(toolId, {
        name,
        args,
        executionStarted: true,
        argsComplete: true,
        result: normalizeResult(result, false),
        resultSource: result,
        isPartial: true,
        bytes: 0,
      });
      return;
    }
    const argsChanged = current.args !== args;
    if (argsChanged) {
      current.args = args;
      current.component?.updateArgs(args);
    }
    if (current.resultSource === result && current.isPartial) {
      if (argsChanged) this.account(current);
      return;
    }
    current.result = normalizeResult(result, false);
    current.resultSource = result;
    current.isPartial = true;
    current.component?.updateResult(current.result, true);
    this.account(current);
  }

  end(toolId: string, name: string, result: unknown, isError: boolean) {
    const current = this.executions.get(toolId);
    if (!current) {
      this.add(toolId, {
        name,
        args: {},
        executionStarted: true,
        argsComplete: true,
        result: normalizeResult(result, isError),
        resultSource: result,
        isPartial: false,
        bytes: 0,
      });
      return;
    }
    if (
      current.resultSource === result &&
      !current.isPartial &&
      current.result?.isError === isError
    ) {
      return;
    }
    current.result = normalizeResult(result, isError);
    current.resultSource = result;
    current.isPartial = false;
    current.component?.updateResult(current.result, false);
    this.account(current);
  }

  renderTool(request: AgentToolRenderRequest, width: number) {
    const execution = this.executions.get(request.toolId);
    if (!execution || execution.name !== request.name) return undefined;
    const cwd = request.cwd ?? process.cwd();
    if (!execution.component || execution.componentCwd !== cwd) {
      execution.component = new ToolExecutionComponent(
        execution.name,
        request.toolId,
        execution.args,
        { showImages: false },
        this.resolveRenderers
          ? this.resolveRenderers(execution.name, execution.definition)
          : execution.definition,
        inertTui,
        cwd,
      );
      execution.componentCwd = cwd;
      execution.componentExpanded = false;
      if (execution.executionStarted)
        execution.component.markExecutionStarted();
      if (execution.argsComplete) execution.component.setArgsComplete();
      if (execution.result) {
        execution.component.updateResult(execution.result, execution.isPartial);
      }
    }
    const expanded = request.expanded === true;
    if (execution.componentExpanded !== expanded) {
      execution.component.setExpanded(expanded);
      execution.componentExpanded = expanded;
    }
    return execution.component.render(width);
  }

  invalidate() {
    for (const execution of this.executions.values()) {
      execution.component?.invalidate();
    }
  }

  /** Retained tool ids (oldest first) and counted payload bytes. */
  retention() {
    return {
      toolIds: [...this.executions.keys()],
      bytes: this.retainedBytes,
    };
  }

  private add(toolId: string, record: ToolExecutionRecord) {
    this.executions.set(toolId, record);
    this.account(record);
  }

  /** Re-measure one record after its payload changed, then enforce the budget. */
  private account(record: ToolExecutionRecord) {
    const bytes = payloadBytes(record.args) + payloadBytes(record.resultSource);
    this.retainedBytes += bytes - record.bytes;
    record.bytes = bytes;
    this.evict(record);
  }

  /**
   * Drop the oldest settled records until both budgets hold. The record that
   * just changed is kept even if it alone exceeds the byte budget, so the tool
   * a child is showing right now still renders natively.
   */
  private evict(keep: ToolExecutionRecord) {
    for (const [toolId, record] of this.executions) {
      if (
        this.executions.size <= MAX_RETAINED_TOOL_RENDERS &&
        this.retainedBytes <= MAX_RETAINED_TOOL_RENDER_BYTES
      )
        return;
      if (record === keep || record.isPartial) continue;
      this.executions.delete(toolId);
      this.retainedBytes -= record.bytes;
    }
  }
}
