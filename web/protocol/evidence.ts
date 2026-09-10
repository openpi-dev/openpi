import type { WebLiveMessage, WebMessagePart } from "./types.ts";

export const EVIDENCE_MAX_BYTES = 12 * 1024;
export const EVIDENCE_MAX_LINES = 300;
export const LIVE_TOOL_LIMIT = 32;

export function evidenceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function projectEvidenceArguments(input: unknown) {
  const source = evidenceRecord(input);
  const result: Record<string, string | number> = {};
  for (const key of ["path", "command", "offset", "limit", "id"]) {
    const value = Object.getOwnPropertyDescriptor(source, key)?.value;
    if (typeof value === "string") result[key] = evidenceText(value).text;
    else if (typeof value === "number" && Number.isSafeInteger(value)) result[key] = value;
  }
  return result;
}

/** Display only: never feed this projection back to a tool or Session. */
export function evidenceText(value: string, tail = false) {
  // Bound work before stripping terminal controls, including OSC hyperlinks.
  const candidate = tail ? value.slice(-EVIDENCE_MAX_BYTES * 2) : value.slice(0, EVIDENCE_MAX_BYTES * 2);
  const clean = candidate
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/gu, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "");
  const lines = clean.split("\n");
  const limited = (tail ? lines.slice(-EVIDENCE_MAX_LINES) : lines.slice(0, EVIDENCE_MAX_LINES)).join("\n");
  const bytes = new TextEncoder().encode(limited);
  // Decode incomplete UTF-8 at the boundary without retaining a replacement character.
  let start = tail ? Math.max(0, bytes.length - EVIDENCE_MAX_BYTES) : 0;
  let end = tail ? bytes.length : Math.min(bytes.length, EVIDENCE_MAX_BYTES);
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  const text = new TextDecoder().decode(bytes.subarray(start, end));
  return { text, truncated: value.length > candidate.length || lines.length > EVIDENCE_MAX_LINES || bytes.length > EVIDENCE_MAX_BYTES };
}

export type EvidenceState = "running" | "returned" | "failed" | "cancelled" | "timed_out" | "unknown";
export interface LiveToolEvidence {
  call: Extract<WebMessagePart, { type: "toolCall" }>;
  result?: WebLiveMessage;
  state: EvidenceState;
}

export function bashReceipt(content: unknown, isError: unknown) {
  if (isError !== true) return undefined;
  const lastPart = Array.isArray(content) ? content.at(-1) : undefined;
  const value = typeof content === "string" ? content : evidenceRecord(lastPart).type === "text" ? evidenceRecord(lastPart).text : undefined;
  if (typeof value !== "string") return undefined;
  const last = value.slice(-512).trimEnd().split("\n").at(-1);
  if (last === "Command aborted") return { state: "cancelled" as const };
  if (/^Command timed out after \d+(?:\.\d+)? seconds$/u.test(last ?? "")) return { state: "timed_out" as const };
  const exit = /^Command exited with code (-?\d+)$/u.exec(last ?? "");
  if (exit && Number.isSafeInteger(Number(exit[1]))) return { state: "failed" as const, exitCode: Number(exit[1]) };
  return undefined;
}

export function toolArguments(call: Extract<WebMessagePart, { type: "toolCall" }>) {
  if (call.evidenceArguments) return call.evidenceArguments;
  try { return evidenceRecord(JSON.parse(call.arguments)); } catch { return {}; }
}

export function isEvidenceTool(name: string) {
  return ["read", "write", "edit", "bash", "bg_start", "bg_status"].includes(name);
}

function terminalOutcome(name: string, result?: WebLiveMessage) {
  if (name === "bash" && result?.terminalReceipt) return result.terminalReceipt;
  const details = evidenceRecord(result?.details);
  if (name.startsWith("bg_")) {
    const status = details.status;
    if (status === "running") return { state: "running" as const };
    if (["done", "failed", "killed", "timed_out"].includes(String(status))) {
      return {
        state: status === "killed" ? "cancelled" as const : status === "timed_out" ? "timed_out" as const : status === "failed" ? "failed" as const : "returned" as const,
        exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
        signal: typeof details.signal === "string" ? evidenceText(details.signal).text : undefined,
      };
    }
  }
  // Pi 0.85.1 appends these terminal receipts to failed bash results.
  // Require isError and an intact final line; ordinary stdout is not a receipt.
  if (name === "bash" && result?.isError === true && !result.truncation) {
    const last = result.content.trimEnd().split("\n").at(-1);
    if (last === "Command aborted") return { state: "cancelled" as const };
    if (/^Command timed out after \d+(?:\.\d+)? seconds$/u.test(last ?? "")) return { state: "timed_out" as const };
    const exit = /^Command exited with code (-?\d+)$/u.exec(last ?? "");
    if (exit) return { state: "failed" as const, exitCode: Number(exit[1]) };
  }
  return undefined;
}

/** TAP summary is an output observation, not an execution receipt. */
export function testSummary(text: string) {
  const vitest = /^\s*Tests\s+((?:\d+ (?:passed|failed|skipped|todo)(?:\s*\|\s*)?)+)\s*\((\d+)\)\s*$/mu.exec(text);
  if (vitest) {
    const passed = Number(/(\d+) passed/u.exec(vitest[1]!)?.[1] ?? 0);
    const failed = Number(/(\d+) failed/u.exec(vitest[1]!)?.[1] ?? 0);
    const tests = Number(vitest[2]);
    if (Number.isSafeInteger(tests) && passed + failed <= tests) return { format: "Vitest", tests, passed, failed, cancelled: 0, failures: failureExcerpts(text, /^\s*(?:FAIL\s|×\s)/u) };
  }
  const bun = /^Ran (\d+) tests? across \d+ files?\./mu.exec(text);
  const bunPass = /^\s*(\d+) pass\s*$/mu.exec(text);
  const bunFail = /^\s*(\d+) fail\s*$/mu.exec(text);
  if (bun && bunPass && bunFail) {
    const tests = Number(bun[1]), passed = Number(bunPass[1]), failed = Number(bunFail[1]);
    if (Number.isSafeInteger(tests) && passed + failed <= tests) return { format: "Bun", tests, passed, failed, cancelled: 0, failures: failureExcerpts(text, /^\s*\(fail\) /u) };
  }
  const count = (name: string) => {
    const match = new RegExp(`^[#ℹ] ${name} (\\d+)$`, "mu").exec(text);
    const number = match ? Number(match[1]) : undefined;
    return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
  };
  const tests = count("tests");
  const passed = count("pass");
  const failed = count("fail");
  const cancelled = count("cancelled") ?? 0;
  if (tests === undefined || passed === undefined || failed === undefined || passed + failed + cancelled > tests) return undefined;
  const failures = failureExcerpts(text, /^(?:\s*not ok \d+\b|✖ )/u);
  return { format: /^ℹ tests /mu.test(text) ? "Node" : "TAP", tests, passed, failed, cancelled, failures };
}

function failureExcerpts(text: string, pattern: RegExp) {
  return text.split("\n").flatMap((line, index, lines) => pattern.test(line) ? [lines.slice(index, index + 8).join("\n")] : []).slice(0, 20);
}

export function projectToolEvidence(call: Extract<WebMessagePart, { type: "toolCall" }>, result?: WebLiveMessage, liveState?: EvidenceState) {
  const args = toolArguments(call);
  const details = evidenceRecord(result?.details);
  const terminal = terminalOutcome(call.name, result);
  const state = terminal?.state ?? (liveState === "running" ? "running" : result?.isError === true ? "failed" : result?.isError === false ? "returned" : "unknown");
  const isTerminal = ["bash", "bg_start", "bg_status"].includes(call.name);
  const output = evidenceText(result?.content ?? "", isTerminal);
  const readFooter = call.name === "read" ? /\n\n(\[(?:\d+ more lines in file\. Use offset=\d+ to continue\.|Showing lines [^\n]+)\])$/u.exec(output.text) : null;
  const truncated = output.truncated || Boolean(result?.truncation) || evidenceRecord(details.truncation).truncated === true || call.evidenceTruncated === true;
  const tests = isTerminal ? testSummary(output.text) : undefined;
  const kind = call.name === "read" ? "file" : ["write", "edit"].includes(call.name) ? "change" : tests ? "test" : "terminal";
  const diff = ["write", "edit"].includes(call.name) && result?.isError === false && typeof details.diff === "string" ? evidenceText(details.diff) : undefined;
  const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1;
  return {
    kind, state, processState: terminal?.state ?? (call.name === "bash" && result?.isError === false ? "returned" : call.name === "bash" && liveState === "running" ? "running" : "unknown"), output: readFooter ? output.text.slice(0, readFooter.index) : output.text, truncated: truncated || diff?.truncated === true,
    readRecovery: readFooter?.[1],
    numberLines: call.name === "read" && result?.isError === false && evidenceRecord(details.truncation).firstLineExceedsLimit !== true && Boolean(output.text),
    path: typeof args.path === "string" ? evidenceText(args.path).text : undefined,
    resolvedPath: typeof args.resolvedPath === "string" ? evidenceText(args.resolvedPath).text : undefined,
    command: typeof args.command === "string" ? evidenceText(args.command).text : undefined,
    offset, diff: diff?.text, tests,
    change: result?.isError === false && ["created", "overwritten", "unchanged"].includes(String(details.change)) ? String(details.change) : undefined,
    evidenceUnavailable: typeof details.evidenceUnavailable === "string" ? evidenceText(details.evidenceUnavailable).text : undefined,
    exitCode: terminal && "exitCode" in terminal ? terminal.exitCode : undefined,
    signal: terminal && "signal" in terminal ? terminal.signal : undefined,
    recovery: typeof details.fullOutputPath === "string" ? evidenceText(details.fullOutputPath).text : undefined,
    rawArguments: evidenceText(call.arguments).text,
    rawResult: evidenceText(JSON.stringify({ content: result?.content, details: result?.details, isError: result?.isError })).text,
  };
}
