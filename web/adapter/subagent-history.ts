import { readFile, lstat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizePersistedWorkflowDetails, recoverStaleWorkflowDetails } from "../../extensions/workflows/dashboard.ts";
import { workflowTranscriptDocument } from "../../extensions/workflows/transcript.ts";
import type { SubagentSnapshot, TranscriptItem } from "../../extensions/subagents/src/domain.ts";
import {
  WEB_MAX_CAPABILITY_ITEMS,
  type WebCapabilityProjection,
  projectSubagentCapability,
  projectSubagentDetail,
  projectWorkflowCapability,
  projectWorkflowAgentDetail,
} from "../../extensions/shared/web-observer-registry.ts";

export function mergeChildHistory<T>(saved: WebCapabilityProjection<T>, live: WebCapabilityProjection<T> | undefined, key: (item: T) => string) {
  if (!saved.items.length && !saved.omitted) return live;
  const liveItems = live?.items ?? [];
  const liveIds = new Set(liveItems.map(key));
  const savedItems = saved.items.filter((item) => !liveIds.has(key(item)));
  const items = [...liveItems, ...savedItems].slice(0, WEB_MAX_CAPABILITY_ITEMS);
  const omitted = saved.omitted + (live?.omitted ?? 0) + liveItems.length + savedItems.length - items.length;
  return { ...live, items, omitted, truncated: saved.truncated || live?.truncated === true || omitted > 0 };
}

/** Private parent entries bind a child file; tool receipts alone only supply display metadata. */
export const SUBAGENT_SESSION_ENTRY = "subagent-session";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

export function savedSubagents(manager: SessionManager) {
  const branch = manager.getBranch();
  const byId = new Map(branch.map((entry, index) => [entry.id, index]));
  const records = new Map<string, {
    id: string;
    title: string;
    origin: "model" | "btw";
    status: "done" | "error" | "unknown";
    outcome?: "completed" | "failed" | "interrupted";
    createdAt: number;
    settledAt?: number;
    model?: string;
    cwd: string;
    prompt: string;
    sessionId?: string;
    sessionPath?: string;
    endEntryId?: string;
    startEntryId?: string | null;
  }>();
  const parentId = manager.getSessionId();
  for (const [index, entry] of branch.entries()) {
    const data = entry.type === "custom" ? object(entry.data)
      : entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent_spawn" && !entry.message.isError
        ? object(entry.message.details) : undefined;
    if (!data || entry.type === "custom" && ![SUBAGENT_SESSION_ENTRY, "subagent-finished", "btw-result"].includes(entry.customType)) continue;
    const id = typeof data.id === "string" ? data.id : "";
    if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/u.test(id)) continue;
    const previous = records.get(id);
    const finished = entry.type === "custom" && entry.customType === "subagent-finished";
    const started = entry.type === "custom" && entry.customType === SUBAGENT_SESSION_ENTRY;
    const aside = entry.type === "custom" && entry.customType === "btw-result";
    const binding = finished ? object(data.evidence) : data;
    const originIndex = typeof binding.parentOriginEntryId === "string" ? byId.get(binding.parentOriginEntryId) : undefined;
    const bound = entry.type === "custom" && binding.parentSessionId === parentId &&
      (originIndex !== undefined && originIndex < index || started && binding.parentOriginEntryId === null && entry.parentId === null) && typeof binding.sessionId === "string" && UUID.test(binding.sessionId) &&
      typeof binding.sessionPath === "string" && isAbsolute(binding.sessionPath) && binding.sessionPath.length <= 4096 &&
      (!finished || binding.sealed === true && binding.parentBound === true && Number.isSafeInteger(binding.generation) && Number(binding.generation) > 0 &&
        (binding.startEntryId === null || typeof binding.startEntryId === "string") && typeof binding.endEntryId === "string");
    const completion = object(data.completion);
    const observed = object(completion.observed);
    const uncertain = observed.outcome === "uncertain" || finished && !bound || started && data.status === "running";
    const outcome = observed.outcome === "cancelled" || data.outcome === "interrupted" ? "interrupted"
      : observed.outcome === "success" || data.status === "done" ? "completed"
      : observed.outcome === "failure" || data.outcome === "failed" || data.status === "error" ? "failed" : "interrupted";
    const createdAt = previous?.createdAt ?? (Date.parse(entry.timestamp) || 0);
    records.delete(id);
    records.set(id, {
      ...previous,
      id,
      title: text(data.title) || previous?.title || id,
      origin: data.origin === "btw" || aside ? "btw" : previous?.origin ?? "model",
      // A saved start receipt proves history, never a live execution after restart.
      status: uncertain ? "unknown" : finished || aside || started ? outcome === "completed" ? "done" : "error" : previous?.status ?? "unknown",
      outcome: uncertain ? undefined : finished || aside || started ? outcome : previous?.outcome,
      createdAt,
      ...(finished || aside ? { settledAt: Date.parse(entry.timestamp) || createdAt } : started ? { settledAt: undefined } : {}),
      model: text(data.model, 640) || previous?.model,
      cwd: text(data.cwd, 4096) || previous?.cwd || manager.getCwd(),
      prompt: text(data.prompt, 4096) || previous?.prompt || "",
      ...(bound ? {
        sessionId: binding.sessionId as string,
        sessionPath: binding.sessionPath as string,
        endEntryId: typeof binding.endEntryId === "string" ? binding.endEntryId : undefined,
        startEntryId: typeof binding.startEntryId === "string" || binding.startEntryId === null ? binding.startEntryId : undefined,
      } : {}),
    });
  }
  return [...records.values()];
}

export function savedSubagentCapability(manager: SessionManager) {
  return projectSubagentCapability(savedSubagents(manager));
}

export function savedWorkflowRuns(manager: SessionManager) {
  const runs = new Map<string, NonNullable<ReturnType<typeof normalizePersistedWorkflowDetails>>>();
  for (const entry of manager.getBranch()) {
    const marker = entry.type === "custom" && entry.customType === "workflow-child";
    const message = entry.type === "message" ? entry.message : undefined;
    if (!marker && !(message?.role === "toolResult" && ["workflow", "workflow_status"].includes(message.toolName)) &&
      !(message?.role === "custom" && message.customType === "workflow-result")) continue;
    const container = object(marker && entry.type === "custom" ? entry.data : message && "details" in message ? message.details : undefined);
    const candidates = typeof container.runId === "string" ? [container]
      : Array.isArray(container.entries) ? container.entries.map(object)
      : Array.isArray(container.runs) ? container.runs.map(object) : [];
    for (const data of candidates) {
      if (typeof data.runId !== "string" || data.runId.length > 128 || !/^wf_[0-9a-f]+$/i.test(data.runId) || data.sessionId !== undefined && data.sessionId !== manager.getSessionId()) continue;
      try {
        const previous = runs.get(data.runId);
        const agents = marker ? new Map<number, unknown>(previous?.agents.map((agent) => [agent.index, agent])) : undefined;
        if (agents && Array.isArray(data.agents)) for (const value of data.agents) {
          const agent = object(value);
          if (Number.isSafeInteger(agent.index) && Number(agent.index) > 0) agents.set(Number(agent.index), agent);
        }
        const source = { ...previous, ...data, sessionId: manager.getSessionId(), agents: agents ? [...agents.values()] : Array.isArray(data.agents) ? data.agents : previous?.agents ?? [] };
        const run = normalizePersistedWorkflowDetails(data.runId, source);
        if (run) { runs.delete(run.runId); runs.set(run.runId, recoverStaleWorkflowDetails(run)); }
      } catch { /* Malformed legacy receipts do not establish child ownership. */ }
    }
  }
  return [...runs.values()];
}

export class WorkflowHistory {
  private readonly cache = new Map<string, { identity: string; run: NonNullable<ReturnType<typeof normalizePersistedWorkflowDetails>> }>();

  private async read(name: string, directory: string) {
    const file = join(directory, basename(name));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Workflow history is unavailable");
    return { raw: object(JSON.parse(await readFile(file, "utf8"))), identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  }

  private async manifest(manager: SessionManager, saved: ReturnType<typeof savedWorkflowRuns>[number]) {
    const directory = join(getAgentDir(), "workflows", saved.runId);
    const key = join(directory, "workflow.json");
    try {
      const info = await lstat(key);
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.cache.get(key);
      if (cached?.identity === identity && cached.run.sessionId === manager.getSessionId()) return cached.run;
      const { raw } = await this.read("workflow.json", directory);
      if (raw.sessionId !== manager.getSessionId() || raw.runId !== saved.runId) return undefined;
      const run = normalizePersistedWorkflowDetails(saved.runId, raw);
      if (!run) return undefined;
      this.cache.delete(key);
      this.cache.set(key, { identity, run });
      while (this.cache.size > WEB_MAX_CAPABILITY_ITEMS) this.cache.delete(this.cache.keys().next().value!);
      return run;
    } catch { return saved; }
  }

  async capability(manager: SessionManager) {
    const runs: ReturnType<typeof savedWorkflowRuns> = [];
    const savedRuns = savedWorkflowRuns(manager);
    const selected = savedRuns.slice(-WEB_MAX_CAPABILITY_ITEMS);
    for (const saved of selected) {
      const run = await this.manifest(manager, saved);
      if (run) runs.push(recoverStaleWorkflowDetails(structuredClone(run)));
    }
    const projection = projectWorkflowCapability(runs);
    const omitted = projection.omitted + savedRuns.length - selected.length;
    return { ...projection, omitted, truncated: projection.truncated || omitted > 0 };
  }

  async detail(manager: SessionManager, id: string) {
    const match = /^(wf_[0-9a-f]+):call:([1-9][0-9]*)$/i.exec(id);
    if (!match) return undefined;
    const saved = savedWorkflowRuns(manager).find((run) => run.runId === match[1]);
    if (!saved) return undefined;
    const manifest = await this.manifest(manager, saved);
    if (!manifest) return undefined;
    let run = structuredClone(manifest);
    const directory = join(getAgentDir(), "workflows", run.runId);
    // Keep validated terminal metadata even if the separately stored transcript is unavailable.
    if (run.transcriptArtifact) try {
      const { raw: transcripts } = await this.read(run.transcriptArtifact, directory);
      run = normalizePersistedWorkflowDetails(run.runId, {
        ...run, agents: run.agents.map((agent) => ({ ...agent, transcript: transcripts[String(agent.index)] ?? agent.transcript })),
      }) ?? run;
    } catch { /* A missing side artifact is not an empty or vanished execution. */ }
    recoverStaleWorkflowDetails(run);
    const agent = run.agents.find((item) => item.index === Number(match[2]));
    if (!agent) return undefined;
    return projectWorkflowAgentDetail(run.runId, { ...agent,
      cwd: agent.effectiveCwd ?? agent.requestedCwd,
      errorText: agent.error,
      transcript: workflowTranscriptDocument(agent.transcript).items,
      transcriptUnavailable: agent.transcript.length === 0,
    });
  }
}

function contentText(content: string | readonly { type: string; text?: string }[]) {
  return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n");
}

export function savedSubagentDetail(
  record: ReturnType<typeof savedSubagents>[number],
  child: SessionManager,
) {
  if (child.getSessionId() !== record.sessionId) return undefined;
  const branch: ReturnType<SessionManager["getEntries"]> = [];
  const seen = new Set<string>();
  let cursor = record.endEntryId ?? child.getLeafId();
  while (cursor !== null) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    const entry = child.getEntry(cursor);
    if (!entry || entry.parentId !== null && typeof entry.parentId !== "string") return undefined;
    branch.push(entry);
    cursor = entry.parentId;
  }
  branch.reverse();
  const startIndex = record.startEntryId ? branch.findIndex((entry) => entry.id === record.startEntryId) : -1;
  if (record.startEntryId && startIndex < 0) return undefined;
  const transcript: TranscriptItem[] = [];
  let finalText = "";
  let errorText: string | undefined;
  const spend = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [index, entry] of branch.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") transcript.push({ kind: "user", text: contentText(message.content) });
    else if (message.role === "assistant") {
      transcript.push({ kind: "assistant", parts: message.content.flatMap((part): Extract<TranscriptItem, { kind: "assistant" }>["parts"][number][] => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "thinking") return [{ type: "thinking", text: part.redacted ? "" : part.thinking, redacted: part.redacted }];
        if (part.type === "toolCall") return [{ type: "toolCall", toolId: part.id, name: part.name, argsPreview: JSON.stringify(part.arguments).slice(0, 4096) }];
        return [];
      }) });
      if (index > startIndex) {
        finalText = contentText(message.content);
        errorText = message.errorMessage;
      }
      spend.input += message.usage.input;
      spend.output += message.usage.output;
      spend.cacheRead += message.usage.cacheRead;
      spend.cacheWrite += message.usage.cacheWrite;
    } else if (message.role === "toolResult") transcript.push({ kind: "toolResult", toolId: message.toolCallId, name: message.toolName, isError: message.isError, outputPreview: contentText(message.content) });
  }
  const source: SubagentSnapshot = {
    ...record,
    status: record.status === "unknown" ? "error" : record.status,
    backend: "pi",
    meta: { backend: "pi", modelLabel: record.model },
    usage: {},
    transcript,
    transcriptVersion: transcript.length,
    liveTools: [],
    queued: [],
    finalText,
    errorText,
    spend,
    turns: transcript.filter((item) => item.kind === "assistant").length,
  };
  const detail = projectSubagentDetail(source);
  return record.status === "unknown" ? { ...detail, status: "unknown" as const, outcome: undefined } : detail;
}
