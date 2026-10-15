import { performance } from "node:perf_hooks";
import type { InvocationRecord } from "./invocation-ledger.ts";
import { truncateUtf8 } from "./serialization.ts";

export const TIMING_ACTIVE_LIMIT = 128;
export const TIMING_ENTRY_LIMIT = 32;
export const TIMING_ENTRY_MAX_BYTES = 16 * 1024;
export const TIMING_ARTIFACT_MAX_BYTES = 32 * 1024;
export type ToolTimingOutcome = "success" | "error" | "timeout" | "cancelled";
export interface TimingEntry {
  toolCallId: string;
  toolName: string;
  startedAt?: number;
  finishedAt: number;
  durationMs?: number;
  outcome: ToolTimingOutcome;
}
export interface ExecutionTimingSummary {
  version: 1;
  provenance: "execution";
  clock: "monotonic-elapsed";
  startedAt: number;
  observedTo: number;
  elapsedMs: number;
  startupMs?: number;
  promptMs?: number;
  cleanupMs?: number;
  outcome: "success" | "failure" | "cancelled" | "uncertain";
  toolDurationMs: number;
  /** Union of paired/active observed intervals; a lower bound when tracking drops. */
  toolWallMs: number;
  /** Unattributed observation window, never provider latency or thinking time. */
  unattributedMs: number;
  tools: {
    started: number;
    finished: number;
    paired: number;
    errors: number;
    timedOut: number;
    cancelled: number;
    unmatchedEnds: number;
    unclosedStarts: number;
    trackingDropped: number;
    entriesOmitted: number;
    identifiersTruncated: number;
  };
  retries: { started: number; ended: number };
  coverage: "unobserved" | "complete-tool-events" | "partial-tool-events";
}
interface ActiveTiming {
  toolName: string;
  started: number;
  outcome?: ToolTimingOutcome;
}

/** Privacy-safe projection of Pi lifecycle events, independent of message retention. */
export class ExecutionTimingLedger {
  private readonly active = new Map<string, ActiveTiming>();
  private readonly entries: TimingEntry[] = [];
  private entriesBytes = 0;
  private readonly origin: number;
  private last = 0;
  private wall = 0;
  private duration = 0;
  private promptAt?: number;
  private cleanupAt?: number;
  private eventEnd?: number;
  private observing = false;
  private counters = {
    started: 0,
    finished: 0,
    paired: 0,
    errors: 0,
    timedOut: 0,
    cancelled: 0,
    unmatchedEnds: 0,
    trackingDropped: 0,
    entriesOmitted: 0,
    identifiersTruncated: 0,
  };
  private retries = { started: 0, ended: 0 };
  readonly startedAt: number;
  private readonly now: () => number;
  constructor(startedAt = Date.now(), now = () => performance.now()) {
    this.startedAt = startedAt;
    this.now = now;
    this.origin = now();
  }
  private tick() {
    const elapsed = Math.max(this.last, this.now() - this.origin);
    if (this.active.size > 0 && this.eventEnd === undefined)
      this.wall += elapsed - this.last;
    this.last = elapsed;
    return elapsed;
  }
  eventsStarted() {
    this.observing = true;
  }
  promptStarted() {
    this.promptAt = this.tick();
  }
  eventsEnded() {
    this.eventEnd = this.tick();
    this.cleanupAt = this.eventEnd;
  }
  retry(type: "auto_retry_start" | "auto_retry_end") {
    if (type === "auto_retry_start") this.retries.started++;
    else this.retries.ended++;
  }
  toolBoundary(toolCallId: string, outcome: "timeout" | "cancelled") {
    if (outcome === "timeout") this.counters.timedOut++;
    else this.counters.cancelled++;
    const active = this.active.get(toolCallId);
    if (active) active.outcome = outcome;
  }
  toolStart(toolCallId: string, toolName: string) {
    this.observing = true;
    const elapsed = this.tick();
    this.counters.started++;
    if (
      this.active.has(toolCallId) ||
      this.active.size >= TIMING_ACTIVE_LIMIT ||
      Buffer.byteLength(toolCallId) > 256
    ) {
      this.counters.trackingDropped++;
      return;
    }
    const boundedName = truncateUtf8(toolName, 128);
    if (boundedName !== toolName) this.counters.identifiersTruncated++;
    this.active.set(toolCallId, { toolName: boundedName, started: elapsed });
  }
  toolEnd(toolCallId: string, toolName: string, isError: boolean) {
    this.observing = true;
    const elapsed = this.tick();
    this.counters.finished++;
    if (isError) this.counters.errors++;
    const active = this.active.get(toolCallId);
    this.active.delete(toolCallId);
    if (active) {
      this.counters.paired++;
      this.duration += elapsed - active.started;
    } else this.counters.unmatchedEnds++;
    if (this.entries.length >= TIMING_ENTRY_LIMIT) {
      this.counters.entriesOmitted++;
      return;
    }
    const boundedId = truncateUtf8(toolCallId, 256);
    const boundedName = active?.toolName ?? truncateUtf8(toolName, 128);
    if (boundedId !== toolCallId) this.counters.identifiersTruncated++;
    if (!active && boundedName !== toolName)
      this.counters.identifiersTruncated++;
    const entry: TimingEntry = {
      toolCallId: boundedId,
      toolName: boundedName,
      ...(active
        ? {
            startedAt: this.startedAt + active.started,
            durationMs: elapsed - active.started,
          }
        : {}),
      finishedAt: this.startedAt + elapsed,
      outcome: active?.outcome ?? (isError ? "error" : "success"),
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (this.entriesBytes + bytes > TIMING_ENTRY_MAX_BYTES) {
      this.counters.entriesOmitted++;
      return;
    }
    this.entriesBytes += bytes;
    this.entries.push(entry);
  }
  snapshot(outcome: ExecutionTimingSummary["outcome"]) {
    const elapsed = this.tick();
    const summary: ExecutionTimingSummary = {
      version: 1,
      provenance: "execution",
      clock: "monotonic-elapsed",
      startedAt: this.startedAt,
      observedTo: this.startedAt + (this.eventEnd ?? elapsed),
      elapsedMs: elapsed,
      ...(this.promptAt === undefined
        ? {}
        : {
            startupMs: this.promptAt,
            promptMs: (this.eventEnd ?? elapsed) - this.promptAt,
          }),
      ...(this.cleanupAt === undefined
        ? {}
        : { cleanupMs: elapsed - this.cleanupAt }),
      outcome,
      toolDurationMs: this.duration,
      toolWallMs: this.wall,
      unattributedMs: Math.max(0, elapsed - this.wall),
      tools: { ...this.counters, unclosedStarts: this.active.size },
      retries: { ...this.retries },
      coverage: !this.observing
        ? "unobserved"
        : this.counters.trackingDropped ||
            this.counters.unmatchedEnds ||
            this.active.size
          ? "partial-tool-events"
          : "complete-tool-events",
    };
    return { summary, entries: this.entries.map((entry) => ({ ...entry })) };
  }
}

/** Admission remains owned by the canonical invocation, including replay provenance. */
export function invocationTiming(invocation: InvocationRecord) {
  const end = invocation.terminalAt;
  return {
    identity: invocation.identity,
    provenance:
      invocation.admissionState === "replayed" ? "replay" : "invocation",
    ...(invocation.claimedAt === undefined
      ? {}
      : { admissionMs: invocation.claimedAt - invocation.requestedAt }),
    ...(invocation.runningAt === undefined ||
    end === undefined ||
    invocation.admissionState === "replayed"
      ? {}
      : { childLifecycleMs: end - invocation.runningAt }),
  };
}

/** Reload only known numeric facts; never project arbitrary persisted payload fields. */
export function decodeExecutionTimingSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const outcome = raw.outcome;
  const coverage = raw.coverage;
  if (
    raw.version !== 1 ||
    raw.provenance !== "execution" ||
    raw.clock !== "monotonic-elapsed" ||
    typeof outcome !== "string" ||
    (outcome !== "success" &&
      outcome !== "failure" &&
      outcome !== "cancelled" &&
      outcome !== "uncertain") ||
    typeof coverage !== "string" ||
    (coverage !== "unobserved" &&
      coverage !== "complete-tool-events" &&
      coverage !== "partial-tool-events")
  )
    return undefined;
  const finite = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) && number >= 0;
  const durationKeys = [
    "startedAt",
    "observedTo",
    "elapsedMs",
    "toolDurationMs",
    "toolWallMs",
    "unattributedMs",
  ] as const;
  if (durationKeys.some((key) => !finite(raw[key]))) return undefined;
  const optionalKeys = ["startupMs", "promptMs", "cleanupMs"] as const;
  if (optionalKeys.some((key) => raw[key] !== undefined && !finite(raw[key])))
    return undefined;
  if (
    !raw.tools ||
    typeof raw.tools !== "object" ||
    Array.isArray(raw.tools) ||
    !raw.retries ||
    typeof raw.retries !== "object" ||
    Array.isArray(raw.retries)
  )
    return undefined;
  const tools = raw.tools as Record<string, unknown>;
  const retries = raw.retries as Record<string, unknown>;
  const toolKeys = [
    "started",
    "finished",
    "paired",
    "errors",
    "timedOut",
    "cancelled",
    "unmatchedEnds",
    "unclosedStarts",
    "trackingDropped",
    "entriesOmitted",
    "identifiersTruncated",
  ] as const;
  const count = (number: unknown) =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (
    toolKeys.some((key) => !count(tools[key])) ||
    !count(retries.started) ||
    !count(retries.ended)
  )
    return undefined;
  if (
    Number(raw.observedTo) < Number(raw.startedAt) ||
    Number(raw.toolWallMs) > Number(raw.elapsedMs) ||
    Number(tools.unclosedStarts) > TIMING_ACTIVE_LIMIT ||
    Number(tools.paired) > Number(tools.started) ||
    Number(tools.paired) > Number(tools.finished) ||
    Number(tools.entriesOmitted) > Number(tools.finished)
  )
    return undefined;
  if (
    raw.coverage === "complete-tool-events" &&
    (Number(tools.trackingDropped) ||
      Number(tools.unmatchedEnds) ||
      Number(tools.unclosedStarts))
  )
    return undefined;
  // Build an allowlisted projection after validation so hidden payloads cannot survive reload.
  const result: ExecutionTimingSummary = {
    version: 1,
    provenance: "execution",
    clock: "monotonic-elapsed",
    startedAt: Number(raw.startedAt),
    observedTo: Number(raw.observedTo),
    elapsedMs: Number(raw.elapsedMs),
    outcome,
    toolDurationMs: Number(raw.toolDurationMs),
    toolWallMs: Number(raw.toolWallMs),
    unattributedMs: Number(raw.unattributedMs),
    tools: Object.fromEntries(
      toolKeys.map((key) => [key, Number(tools[key])]),
    ) as ExecutionTimingSummary["tools"],
    retries: { started: Number(retries.started), ended: Number(retries.ended) },
    coverage,
  };
  for (const key of optionalKeys)
    if (raw[key] !== undefined) result[key] = Number(raw[key]);
  return result;
}
