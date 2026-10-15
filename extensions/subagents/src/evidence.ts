import { createHash } from "node:crypto";
import type {
  ExtensionToolContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { DelegationCompletion } from "../../shared/delegation-completion.ts";
import type { DirectEvidenceBinding } from "./domain.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIRECT_EVIDENCE_MAX_BYTES = 16 * 1024;
const SOURCE_MAX_BYTES = 50 * 1024;

export function directEvidenceRef(binding: DirectEvidenceBinding | undefined) {
  return binding?.sealed &&
    binding.parentBound &&
    Number.isSafeInteger(binding.generation) &&
    binding.generation > 0 &&
    typeof binding.sessionId === "string" &&
    UUID.test(binding.sessionId) &&
    typeof binding.endEntryId === "string" &&
    binding.endEntryId &&
    (binding.startEntryId === null || typeof binding.startEntryId === "string")
    ? `direct:${binding.sessionId}:run:${binding.generation}`
    : undefined;
}

export interface DirectFinishedEvidence {
  readonly id: string;
  readonly origin: "model";
  readonly evidence?: DirectEvidenceBinding;
  readonly completion: DelegationCompletion;
}

export interface DirectEvidenceQuery {
  readonly id: string;
  readonly generation?: number;
  readonly evidence?: "transcript" | "final" | "structured";
  /** Unicode code-point offset, not a file or entry offset. */
  readonly offset?: number;
  readonly limit?: number;
}

function unavailable(reason: string) {
  return { status: "unavailable" as const, reason };
}

// Validate only the structure consumed by indexing, ancestry and final selection.
function isEvidenceEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    typeof entry.type !== "string" ||
    !entry.type ||
    (entry.parentId !== null &&
      (typeof entry.parentId !== "string" || !entry.parentId))
  )
    return false;
  if (entry.type !== "message") return true;
  if (!entry.message || typeof entry.message !== "object") return false;
  const message = entry.message as Record<string, unknown>;
  if (typeof message.role !== "string" || !message.role) return false;
  if (message.role !== "assistant") return true;
  return (
    Array.isArray(message.content) &&
    message.content.every((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const part = value as Record<string, unknown>;
      switch (part.type) {
        case "text":
          return typeof part.text === "string";
        case "thinking":
          return typeof part.thinking === "string";
        case "toolCall":
          return (
            typeof part.id === "string" &&
            !!part.id &&
            typeof part.name === "string" &&
            !!part.name &&
            !!part.arguments &&
            typeof part.arguments === "object" &&
            !Array.isArray(part.arguments)
          );
        default:
          return false;
      }
    })
  );
}

/** Resolve only owner records on the active parent branch; never open a Session bypassing tools. */
export async function queryDirectEvidence(
  ctx: ExtensionToolContext,
  query: DirectEvidenceQuery,
  signal?: AbortSignal,
) {
  const branch = ctx.sessionManager.getBranch();
  const candidates = branch.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "subagent-finished",
  );
  const record = [...candidates].reverse().find((entry) => {
    const data =
      entry.type === "custom"
        ? (entry.data as Partial<DirectFinishedEvidence> | undefined)
        : undefined;
    return (
      data?.id === query.id &&
      (query.generation === undefined ||
        data.evidence?.generation === query.generation)
    );
  });
  if (!record || record.type !== "custom")
    return unavailable("missing-or-pruned");
  const data = record.data as Partial<DirectFinishedEvidence> | undefined;
  const binding = data?.evidence;
  if (data?.origin !== "model" || !binding)
    return unavailable("legacy-or-non-model");
  if (!directEvidenceRef(binding)) return unavailable("unsealed-or-unbound");
  const originIndex = branch.findIndex(
    (entry) => entry.id === binding.parentOriginEntryId,
  );
  if (
    binding.parentSessionId !== ctx.sessionManager.getSessionId() ||
    originIndex < 0 ||
    originIndex >= branch.indexOf(record)
  )
    return unavailable("origin-not-on-active-branch");
  if (!query.evidence)
    return {
      status: "available" as const,
      generation: binding.generation,
      completion: data.completion,
    };

  // The native host records nested read arguments (including paths). Explicit
  // evidence queries have that disclosure contract; ordinary receipts do not.
  const read = async (path: string) => {
    signal?.throwIfAborted();
    const outcome = await ctx.executeTool("read", { path }, { signal });
    signal?.throwIfAborted();
    if (outcome.isError) return unavailable("read-denied-or-missing");
    const details = outcome.result.details as
      | {
          truncation?: { truncated?: boolean; firstLineExceedsLimit?: boolean };
        }
      | undefined;
    const text = outcome.result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (
      details?.truncation?.truncated ||
      details?.truncation?.firstLineExceedsLimit ||
      Buffer.byteLength(text) > SOURCE_MAX_BYTES
    )
      return unavailable("oversized");
    return { status: "available" as const, text };
  };
  if (!binding.sessionPath) return unavailable("missing-session-binding");
  const source = await read(binding.sessionPath);
  if (source.status !== "available") return source;
  let entries: SessionEntry[];
  try {
    const lines = source.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (lines[0]?.type !== "session" || lines[0].id !== binding.sessionId)
      return unavailable("session-identity-mismatch");
    const parsed: unknown[] = lines.slice(1);
    if (!parsed.every(isEvidenceEntry)) return unavailable("invalid-session");
    entries = parsed;
  } catch {
    return unavailable("invalid-or-oversized-session");
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) return unavailable("invalid-session");
  const run: SessionEntry[] = [];
  const seen = new Set<string>();
  let id = binding.endEntryId;
  while (id !== binding.startEntryId) {
    if (id === null || seen.has(id))
      return unavailable("missing-or-pruned-anchors");
    seen.add(id);
    const entry = byId.get(id);
    if (
      !entry ||
      (typeof entry.parentId !== "string" && entry.parentId !== null)
    )
      return unavailable("missing-or-pruned-anchors");
    run.push(entry);
    id = entry.parentId;
  }
  if (binding.startEntryId !== null && !byId.has(binding.startEntryId))
    return unavailable("missing-or-pruned-anchors");
  run.reverse();
  let text: string;
  if (query.evidence === "structured") {
    if (
      binding.structured.status !== "saved" ||
      !binding.structured.path ||
      !binding.structured.digest
    )
      return unavailable(
        binding.structured.status === "failed"
          ? "failed-persistence"
          : "not-run",
      );
    const artifact = await read(binding.structured.path);
    if (artifact.status !== "available") return artifact;
    // Native read may remove the trailing newline; the artifact writer stores JSON exactly.
    if (
      createHash("sha256").update(artifact.text).digest("hex") !==
      binding.structured.digest
    )
      return unavailable("artifact-identity-mismatch");
    text = artifact.text;
  } else if (query.evidence === "final") {
    const final = run.find((entry) => entry.id === binding.finalEntryId);
    if (
      !final ||
      final.type !== "message" ||
      final.message.role !== "assistant"
    )
      return unavailable("missing-final-identity");
    text = JSON.stringify(final.message);
  } else {
    text = run.map((entry) => JSON.stringify(entry)).join("\n");
  }
  const points = Array.from(text);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 2048;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > points.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 4096
  )
    return unavailable("invalid-pagination");
  let end = Math.min(points.length, offset + limit);
  const page = {
    status: "available" as const,
    generation: binding.generation,
    evidence: query.evidence,
    offset,
    text: points.slice(offset, end).join(""),
    nextOffset: end < points.length ? end : undefined,
    total: points.length,
  };
  // JSON escaping, not just source bytes, counts toward the tool output cap.
  while (
    Buffer.byteLength(JSON.stringify(page)) > DIRECT_EVIDENCE_MAX_BYTES &&
    end > offset
  ) {
    end--;
    page.text = points.slice(offset, end).join("");
    page.nextOffset = end;
  }
  return page;
}
