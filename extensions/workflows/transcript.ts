import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  AgentTranscriptRenderer,
  buildPairingIndex,
  type AgentTranscriptDocument,
  type AgentTranscriptItem,
  type AgentTranscriptPart,
} from "../shared/agent-transcript.ts";
import type { TranscriptEntry } from "./model.ts";
import { workflowToolRenderer } from "./tool-renderer.ts";

/** Project the bounded Workflow artifact into the shared operator document. */
function buildWorkflowTranscriptDocument(
  transcript: ReadonlyArray<TranscriptEntry>,
  cwd?: string,
): AgentTranscriptDocument {
  const items: AgentTranscriptItem[] = [];
  const pendingByName = new Map<string, string[]>();

  const appendAssistantPart = (part: AgentTranscriptPart) => {
    const previous = items[items.length - 1];
    if (previous?.kind === "assistant") {
      items[items.length - 1] = {
        ...previous,
        parts: [...previous.parts, part],
      };
    } else {
      items.push({ kind: "assistant", parts: [part] });
    }
  };

  for (let index = 0; index < transcript.length; index++) {
    const entry = transcript[index]!;
    if (entry.role === "user") {
      items.push({ kind: "user", text: entry.text });
      continue;
    }
    if (entry.role === "assistant") {
      appendAssistantPart({ type: "text", text: entry.text });
      continue;
    }
    if (entry.role === "thinking") {
      appendAssistantPart({ type: "thinking", text: entry.text });
      continue;
    }

    const name = entry.name ?? "unknown";
    if (entry.role === "tool") {
      const toolId = entry.toolCallId ?? `workflow-tool-${index}`;
      appendAssistantPart({
        type: "toolCall",
        toolId,
        name,
        argsPreview: entry.text,
      });
      const pending = pendingByName.get(name) ?? [];
      pending.push(toolId);
      pendingByName.set(name, pending);
      continue;
    }

    const pending = pendingByName.get(name);
    let toolId: string;
    if (entry.toolCallId) {
      toolId = entry.toolCallId;
      const pendingIndex = pending?.indexOf(toolId) ?? -1;
      if (pendingIndex >= 0) pending?.splice(pendingIndex, 1);
    } else {
      toolId = pending?.shift() ?? `workflow-result-${index}`;
    }
    items.push({
      kind: "toolResult",
      toolId,
      name,
      isError: entry.isError === true,
      outputPreview: entry.text,
    });
  }

  const toolRenderer = workflowToolRenderer(transcript);
  return {
    items,
    pairing: buildPairingIndex(items),
    cwd,
    ...(toolRenderer ? { toolRenderer } : {}),
  };
}

/** Preserve the shared renderer's identity cache between Workflow repaint ticks. */
export class WorkflowTranscriptAdapter {
  private previousEntries?: ReadonlyArray<TranscriptEntry>;
  private previousCwd?: string;
  private previousToolRenderer?: AgentTranscriptDocument["toolRenderer"];
  private previousDocument?: AgentTranscriptDocument;

  document(
    transcript: ReadonlyArray<TranscriptEntry>,
    cwd?: string,
  ): AgentTranscriptDocument {
    const toolRenderer = workflowToolRenderer(transcript);
    if (
      this.previousDocument &&
      this.previousCwd === cwd &&
      this.previousToolRenderer === toolRenderer &&
      this.previousEntries?.length === transcript.length &&
      this.previousEntries.every((entry, index) => entry === transcript[index])
    ) {
      return this.previousDocument;
    }

    const document = buildWorkflowTranscriptDocument(transcript, cwd);
    this.previousEntries = [...transcript];
    this.previousCwd = cwd;
    this.previousToolRenderer = toolRenderer;
    this.previousDocument = document;
    return document;
  }
}

export function workflowTranscriptDocument(
  transcript: ReadonlyArray<TranscriptEntry>,
  cwd?: string,
) {
  return buildWorkflowTranscriptDocument(transcript, cwd);
}

export class WorkflowTranscriptRenderer {
  private adapter = new WorkflowTranscriptAdapter();
  private renderer = new AgentTranscriptRenderer();

  render(
    transcript: ReadonlyArray<TranscriptEntry>,
    cwd: string | undefined,
    width: number,
    theme: Theme,
    options?: { readonly now?: number; readonly expanded?: boolean },
  ) {
    return this.renderer.render(
      this.adapter.document(transcript, cwd),
      width,
      theme,
      options,
    );
  }

  invalidate() {
    this.renderer.invalidate();
  }
}
