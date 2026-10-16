import {
  admittedJsonBytes,
  jsonStringBytes,
  sameJsonValue,
} from "./bounded-json.ts";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import {
  sameWebSearchConnection,
  webSearchConnection,
  type WebSearchModelSupport,
} from "./support.ts";

export const WEB_SEARCH_MESSAGE_KEY = "openpiWebSearch";
export const MAX_NATIVE_SEARCH_BYTES = 256 * 1024;
type RecordValue = Record<string, unknown>;
export const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface NativeSearchActivity {
  id: string;
  status: "completed" | "failed" | "incomplete";
  query: string;
}

export interface NativeSearchEvidence {
  version: 1;
  connection: Omit<WebSearchModelSupport, "supported">;
  adapter: "responses" | "anthropic";
  output: RecordValue[];
  activities: NativeSearchActivity[];
}

export function readNativeSearchEvidence(message: unknown) {
  if (!record(message)) return undefined;
  const value = message[WEB_SEARCH_MESSAGE_KEY];
  const connection =
    record(value) && record(value.connection) ? value.connection : undefined;
  if (
    !record(value) ||
    value.version !== 1 ||
    !connection ||
    !["provider", "model", "api", "baseUrl"].every(
      (key) => typeof connection[key] === "string",
    ) ||
    (value.adapter !== "responses" && value.adapter !== "anthropic") ||
    !Array.isArray(value.output) ||
    !value.output.every(record) ||
    !Array.isArray(value.activities) ||
    !value.activities.every(
      (item) =>
        record(item) &&
        typeof item.id === "string" &&
        typeof item.query === "string" &&
        typeof item.status === "string" &&
        ["completed", "failed", "incomplete"].includes(item.status),
    )
  )
    return undefined;
  return value as unknown as NativeSearchEvidence;
}

function citationLink(value: unknown) {
  if (!record(value) || typeof value.url !== "string") return undefined;
  const url = URL.parse(value.url);
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return undefined;
  const title = (typeof value.title === "string" ? value.title : url.hostname)
    .slice(0, 300)
    .replace(/[\r\n]/gu, " ")
    .replace(/[\\[\]]/gu, "\\$&");
  return `[${title}](${url.href.replace(/[()]/gu, encodeURIComponent)})`;
}

export function citedText(text: string, annotations: unknown) {
  if (!Array.isArray(annotations)) return text;
  const inserts = annotations
    .flatMap((annotation) => {
      const link = citationLink(annotation);
      if (
        !link ||
        !record(annotation) ||
        (typeof annotation.url === "string" && text.includes(annotation.url))
      )
        return [];
      const end = annotation.end_index;
      return [
        {
          index:
            typeof end === "number" &&
            Number.isInteger(end) &&
            end >= 0 &&
            end <= text.length
              ? end
              : text.length,
          link,
        },
      ];
    })
    .sort((a, b) => b.index - a.index);
  // Citation rendering must not amplify a bounded receipt into unbounded text.
  let remaining =
    MAX_NATIVE_SEARCH_BYTES -
    (jsonStringBytes(text, MAX_NATIVE_SEARCH_BYTES) ?? MAX_NATIVE_SEARCH_BYTES);
  for (const { link } of inserts) {
    const bytes = jsonStringBytes(link, remaining + 2);
    if (bytes === undefined || bytes - 1 > remaining) return text;
    remaining -= bytes - 1;
  }
  let result = text;
  for (const { index, link } of inserts)
    result = `${result.slice(0, index)} ${link}${result.slice(index)}`;
  return result;
}

/** One accumulator per actual Pi request. Native calls never become local function calls. */
export function createNativeSearchCapture(
  adapter: NativeSearchEvidence["adapter"],
  model: Model<Api>,
) {
  let output: RecordValue[] = [];
  const blocks = new Map<number, RecordValue>();
  const inputJson = new Map<number, string>();
  const tails = new Map<number, Record<string, number>>();
  let stopped = false;
  let stopReason = "";
  let fault = false;
  let relevant = false;
  let reported = false;
  let retainedBytes = 2;
  // Raw JSON fragments coexist with opaque blocks until parsing; escaping can double their storage.
  let inputBytes = 0;
  const discard = () => {
    fault = true;
    output = [];
    blocks.clear();
    inputJson.clear();
    tails.clear();
    retainedBytes = 2;
    inputBytes = 0;
  };
  // Inspect only protocol marker positions, with bounded work per event and
  // memoization for shared graphs. The temporary graph is released on return.
  const markerScan = () => {
    let remaining = MAX_NATIVE_SEARCH_BYTES;
    const seen = new Map<object, boolean>();
    const uncertain = () => {
      relevant = true;
      discard();
      return false;
    };
    const spend = () => --remaining >= 0 || uncertain();
    const parts = (values: unknown[], depth: number) => {
      if (depth > 512) return uncertain();
      if (!spend() || values.length > MAX_NATIVE_SEARCH_BYTES)
        return uncertain();
      const previous = seen.get(values);
      if (previous !== undefined) return previous;
      seen.set(values, false);
      let ordinary = true;
      for (let index = 0; index < values.length; index++) {
        if (!spend()) return false;
        const descriptor = Object.getOwnPropertyDescriptor(
          values,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) return uncertain();
        const value: unknown = descriptor.value;
        const inspected = item(value, depth + 1);
        if (!record(value) || value.type !== "output_text" || !inspected)
          ordinary = false;
      }
      seen.set(values, ordinary);
      return ordinary;
    };
    const item = (value: unknown, depth = 0): boolean => {
      if (depth > 512) return uncertain();
      if (!spend()) return false;
      if (!record(value)) return false;
      const previous = seen.get(value);
      if (previous !== undefined) return previous;
      seen.set(value, false);
      if (
        value.type === "web_search_call" ||
        value.type === "web_search_tool_result" ||
        (value.type === "server_tool_use" && value.name === "web_search") ||
        (Array.isArray(value.citations) && value.citations.length) ||
        (Array.isArray(value.annotations) && value.annotations.length)
      )
        relevant = true;
      let ordinary = [
        "text",
        "thinking",
        "redacted_thinking",
        "tool_use",
        "function_call",
        "reasoning",
        "output_text",
      ].includes(typeof value.type === "string" ? value.type : "");
      if (value.type === "message")
        ordinary =
          Array.isArray(value.content) && parts(value.content, depth + 1);
      // Results can carry citation-bearing parts even when they are not ordinary messages.
      else if (Array.isArray(value.content)) parts(value.content, depth + 1);
      seen.set(value, ordinary);
      return ordinary;
    };
    const output = (values: unknown[]) => {
      if (values.length > MAX_NATIVE_SEARCH_BYTES) {
        uncertain();
        return { valid: false, ordinary: false };
      }
      let ordinary = true;
      for (let index = 0; index < values.length; index++) {
        if (!spend()) return { valid: false, ordinary: false };
        const descriptor = Object.getOwnPropertyDescriptor(
          values,
          String(index),
        );
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !record(descriptor.value)
        ) {
          uncertain();
          return { valid: false, ordinary: false };
        }
        if (!item(descriptor.value)) ordinary = false;
      }
      return { valid: true, ordinary };
    };
    return { item, output };
  };
  const admit = (value: unknown, overhead = 0, ordinary = false) => {
    if (fault) return false;
    const bytes = admittedJsonBytes(
      value,
      MAX_NATIVE_SEARCH_BYTES - retainedBytes - overhead,
    );
    if (bytes === undefined) {
      if (!ordinary) relevant = true;
      discard();
      return false;
    }
    retainedBytes += bytes + overhead;
    return true;
  };
  return {
    observe(data: unknown) {
      if (!record(data)) return false;
      const markers = markerScan();
      if (adapter === "responses") {
        if (
          typeof data.type === "string" &&
          (data.type.startsWith("response.web_search_call.") ||
            data.type === "response.output_text.annotation.added")
        )
          relevant = true;
        if (data.type === "response.output_item.done") {
          if (!record(data.item)) {
            relevant = true;
            discard();
          } else {
            const ordinary = markers.item(data.item);
            if (admit(data.item, output.length ? 1 : 0, ordinary))
              output.push(structuredClone(data.item));
          }
        }
        if (
          typeof data.type === "string" &&
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(data.type)
        ) {
          const replacement = record(data.response)
            ? data.response.output
            : undefined;
          // Terminal envelopes remain authoritative even after optional capture
          // was discarded: malformed output cannot prove absence of hosted work.
          if (!Array.isArray(replacement)) {
            relevant = true;
            discard();
          } else {
            const scanned = markers.output(replacement);
            if (!scanned.valid) {
              relevant = true;
              discard();
            } else if (!fault) {
              output = [];
              retainedBytes = 0;
              if (admit(replacement, 0, scanned.ordinary))
                output = structuredClone(replacement);
            }
          }
          stopped = data.type === "response.completed";
        }
      } else {
        const index = typeof data.index === "number" ? data.index : -1;
        if (
          data.type === "content_block_start" &&
          !record(data.content_block)
        ) {
          relevant = true;
          discard();
        }
        const ordinary =
          data.type === "content_block_start" && record(data.content_block)
            ? markers.item(data.content_block)
            : false;
        if (
          data.type === "content_block_delta" &&
          record(data.delta) &&
          data.delta.type === "citations_delta"
        )
          relevant = true;
        if (!fault && data.type === "content_block_start") {
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            blocks.has(index) ||
            !record(data.content_block)
          )
            discard();
          else if (admit(data.content_block, blocks.size ? 1 : 0, ordinary)) {
            const block = structuredClone(data.content_block);
            blocks.set(index, block);
            const tail: Record<string, number> = {};
            for (const field of ["text", "thinking", "signature"]) {
              const value = block[field];
              if (typeof value === "string" && value.length)
                tail[field] = value.charCodeAt(value.length - 1);
            }
            tails.set(index, tail);
          }
        }
        const block = blocks.get(index);
        if (!fault && data.type === "content_block_delta") {
          if (!block || !record(data.delta)) discard();
          else {
            const delta = data.delta;
            const field =
              delta.type === "text_delta"
                ? "text"
                : delta.type === "thinking_delta"
                  ? "thinking"
                  : delta.type === "signature_delta"
                    ? "signature"
                    : delta.type === "input_json_delta"
                      ? "partial_json"
                      : undefined;
            if (field) {
              const fragment = delta[field];
              const prior =
                field === "partial_json"
                  ? (inputJson.get(index) ?? "")
                  : (block[field] ?? "");
              if (typeof fragment !== "string" || typeof prior !== "string")
                discard();
              else {
                const partial = field === "partial_json";
                const budget = partial
                  ? MAX_NATIVE_SEARCH_BYTES * 2 - inputBytes
                  : MAX_NATIVE_SEARCH_BYTES - retainedBytes;
                // Splitting a surrogate pair across deltas saves eight JSON bytes.
                const tail = tails.get(index)!;
                const last = tail[field];
                const first = fragment.charCodeAt(0);
                const paired =
                  last >= 0xd800 &&
                  last <= 0xdbff &&
                  first >= 0xdc00 &&
                  first <= 0xdfff;
                const size = jsonStringBytes(
                  fragment,
                  budget + 2 + (paired ? 8 : 0),
                );
                const added =
                  size === undefined
                    ? undefined
                    : size -
                      2 -
                      (paired ? 8 : 0) +
                      (field !== "partial_json" && !(field in block)
                        ? field.length + 6
                        : 0);
                if (added === undefined || added > budget) discard();
                else {
                  if (fragment.length)
                    tail[field] = fragment.charCodeAt(fragment.length - 1);
                  if (partial) {
                    inputBytes += added;
                    inputJson.set(index, prior + fragment);
                  } else {
                    retainedBytes += added;
                    block[field] = prior + fragment;
                  }
                }
              }
            }
            if (!fault && delta.type === "citations_delta") {
              const citations = Array.isArray(block.citations)
                ? block.citations
                : [];
              if (!record(delta.citation)) discard();
              else if (
                admit(
                  delta.citation,
                  "citations" in block ? (citations.length ? 1 : 0) : 15,
                )
              ) {
                citations.push(structuredClone(delta.citation));
                block.citations = citations;
              }
            }
          }
        }
        if (
          !fault &&
          data.type === "content_block_stop" &&
          block &&
          inputJson.has(index)
        ) {
          const fragment = inputJson.get(index)!;
          inputJson.delete(index);
          delete tails.get(index)?.partial_json;
          try {
            const input: unknown = JSON.parse(fragment);
            const bytes = admittedJsonBytes(input, MAX_NATIVE_SEARCH_BYTES);
            const old =
              "input" in block
                ? (admittedJsonBytes(block.input, MAX_NATIVE_SEARCH_BYTES) ?? 0)
                : 0;
            const overhead = "input" in block ? 0 : 9;
            inputBytes -=
              (jsonStringBytes(fragment, MAX_NATIVE_SEARCH_BYTES * 2 + 2) ??
                2) - 2;
            if (
              bytes === undefined ||
              retainedBytes - old + bytes + overhead > MAX_NATIVE_SEARCH_BYTES
            )
              discard();
            else {
              retainedBytes += bytes - old + overhead;
              block.input = input;
            }
          } catch {
            discard();
          }
        }
        if (
          data.type === "message_delta" &&
          record(data.delta) &&
          data.delta.stop_reason != null
        )
          stopReason =
            data.delta.stop_reason === "pause_turn" ? "pause_turn" : "";
        if (data.type === "message_stop") stopped = true;
      }
      const abort = fault && relevant && !reported;
      if (abort) reported = true;
      return abort;
    },
    finish(message: AssistantMessage) {
      if (inputJson.size && relevant) discard();
      if (fault)
        return relevant
          ? {
              ...message,
              stopReason:
                message.stopReason === "aborted"
                  ? ("aborted" as const)
                  : ("error" as const),
              errorMessage:
                "Native search output exceeded its replay limit or was invalid. No incomplete search history was saved.",
            }
          : undefined;
      if (adapter === "anthropic")
        output = [...blocks.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, block]) => block);
      const activities: NativeSearchActivity[] = output.flatMap((item) => {
        if (adapter === "responses" && item.type === "web_search_call") {
          const action = record(item.action) ? item.action : {};
          return [
            {
              id: String(item.id ?? ""),
              status:
                item.status === "completed" && stopped
                  ? "completed"
                  : item.status === "failed"
                    ? "failed"
                    : "incomplete",
              query: Array.isArray(action.queries)
                ? action.queries.map(String).join(" · ")
                : String(action.query ?? action.url ?? action.pattern ?? ""),
            },
          ];
        }
        if (
          adapter === "anthropic" &&
          item.type === "server_tool_use" &&
          item.name === "web_search"
        ) {
          const result = output.find(
            (block) =>
              block.type === "web_search_tool_result" &&
              block.tool_use_id === item.id,
          );
          return [
            {
              id: String(item.id ?? ""),
              status:
                record(result?.content) &&
                result.content.type === "web_search_tool_result_error"
                  ? "failed"
                  : result && stopped
                    ? "completed"
                    : "incomplete",
              query: record(item.input) ? String(item.input.query ?? "") : "",
            },
          ];
        }
        return [];
      });
      const hasCitations = output.some(
        (item) =>
          (Array.isArray(item.citations) && item.citations.length > 0) ||
          (Array.isArray(item.content) &&
            item.content.some(
              (part) =>
                record(part) &&
                Array.isArray(part.annotations) &&
                part.annotations.length > 0,
            )),
      );
      if (!activities.length && !hasCitations) return undefined;
      if (admittedJsonBytes(output, MAX_NATIVE_SEARCH_BYTES) === undefined) {
        return {
          ...message,
          stopReason:
            message.stopReason === "aborted"
              ? ("aborted" as const)
              : ("error" as const),
          errorMessage:
            "Native search output exceeded the 256 KiB replay limit. No incomplete search history was saved.",
        };
      }
      const content = message.content.map((block) => {
        if (block.type !== "text") return block;
        if (adapter === "responses") {
          let id: unknown;
          try {
            id = JSON.parse(block.textSignature ?? "null")?.id;
          } catch {
            id = block.textSignature;
          }
          const item = output.find(
            (part) => part.type === "message" && part.id === id,
          );
          const parts = Array.isArray(item?.content)
            ? item.content
                .filter(record)
                .filter((part) => part.type === "output_text")
            : [];
          return {
            ...block,
            text: parts.length
              ? parts
                  .map((part) =>
                    citedText(String(part.text ?? ""), part.annotations),
                  )
                  .join("")
              : block.text,
          };
        }
        const part = output.find(
          (item) => item.type === "text" && item.text === block.text,
        );
        return { ...block, text: citedText(block.text, part?.citations) };
      });
      const evidence: NativeSearchEvidence = {
        version: 1,
        connection: webSearchConnection(model),
        adapter,
        output,
        activities,
      };
      const failed =
        activities.some((item) => item.status !== "completed") ||
        stopReason === "pause_turn" ||
        stopReason === "invalid-tool-input";
      return {
        ...message,
        content,
        [WEB_SEARCH_MESSAGE_KEY]: evidence,
        ...(failed && message.stopReason !== "aborted"
          ? {
              stopReason: "error" as const,
              errorMessage:
                stopReason === "pause_turn"
                  ? "Provider paused native web search. Automatic continuation is unavailable in this Pi adapter; no search provider was substituted."
                  : "Native web search did not complete. No search provider was substituted.",
            }
          : {}),
      };
    },
  };
}

/** Reconstruct opaque native blocks only for messages still present after Pi compaction. */
export function replayNativeSearch(
  payload: RecordValue,
  messages: readonly Message[],
  model: Model<Api>,
  adapter: NativeSearchEvidence["adapter"],
) {
  const connection = webSearchConnection(model);
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      continue;
    const candidate = record(message)
      ? message[WEB_SEARCH_MESSAGE_KEY]
      : undefined;
    const candidateConnection =
      record(candidate) && record(candidate.connection)
        ? candidate.connection
        : undefined;
    if (
      record(candidate) &&
      candidate.adapter === adapter &&
      candidateConnection &&
      Object.entries(connection).every(
        ([key, value]) => candidateConnection[key] === value,
      ) &&
      !readNativeSearchEvidence(message)
    )
      throw new Error(
        "Cannot safely replay invalid native web search evidence.",
      );
  }
  if (
    !messages.some((message) => {
      if (
        message.role !== "assistant" ||
        message.stopReason === "error" ||
        message.stopReason === "aborted"
      )
        return false;
      const evidence = readNativeSearchEvidence(message);
      return (
        evidence &&
        evidence.adapter === adapter &&
        sameWebSearchConnection(evidence.connection, connection)
      );
    })
  )
    return payload;
  const result = { ...payload };
  if (Array.isArray(payload.input)) result.input = [...payload.input];
  if (Array.isArray(payload.messages)) result.messages = [...payload.messages];
  const assigned = new Map<number, number>();
  if (adapter === "anthropic") {
    if (!Array.isArray(payload.messages))
      throw new Error(
        "Cannot safely replay native search across an altered assistant turn.",
      );
    const rows = payload.messages.flatMap((item, index) =>
      record(item) && item.role === "assistant" ? [{ item, index }] : [],
    );
    // Only assistant visibility is projected here. Pi still owns conversion of
    // the transcript, tools, system updates, transport and request options.
    const sanitize = (text: string) =>
      text.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
        "",
      );
    let ordinal = 0;
    for (const [sourceIndex, message] of messages.entries()) {
      if (
        message.role !== "assistant" ||
        message.stopReason === "error" ||
        message.stopReason === "aborted"
      )
        continue;
      const sameModel =
        message.provider === model.provider &&
        message.api === model.api &&
        message.model === model.id;
      const projection = message.content.flatMap((block): RecordValue[] => {
        if (block.type === "text")
          return block.text.trim()
            ? [{ type: "text", text: sanitize(block.text) }]
            : [];
        if (block.type === "toolCall")
          return [
            {
              type: "tool_use",
              id: sameModel
                ? block.id
                : block.id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64),
              name: block.name,
              input: block.arguments ?? {},
            },
          ];
        if (block.type === "thinking") {
          if (block.redacted)
            return sameModel
              ? [{ type: "redacted_thinking", data: block.thinkingSignature }]
              : [];
          if (!sameModel)
            return block.thinking.trim()
              ? [{ type: "text", text: sanitize(block.thinking) }]
              : [];
          const signed = !!block.thinkingSignature?.trim();
          if (!block.thinking.trim() && !signed) return [];
          return signed ||
            (model.compat &&
              "allowEmptySignature" in model.compat &&
              model.compat.allowEmptySignature)
            ? [
                {
                  type: "thinking",
                  thinking: sanitize(block.thinking),
                  signature: signed ? block.thinkingSignature : "",
                },
              ]
            : [{ type: "text", text: sanitize(block.thinking) }];
        }
        return [];
      });
      if (!projection.length) {
        if (readNativeSearchEvidence(message))
          throw new Error(
            "Cannot safely replay native search from an empty assistant turn.",
          );
        continue;
      }
      const entry = rows[ordinal++];
      const row = entry?.item;
      const content = record(row) ? row.content : undefined;
      if (
        !record(row) ||
        !Array.isArray(content) ||
        content.length !== projection.length ||
        !projection.every((expected, index) => {
          const actual = content[index];
          return (
            record(actual) &&
            Object.entries(expected).every(([key, value]) => {
              // OAuth changes tool names; it does not change turn identity or arguments.
              if (key === "name")
                return (
                  actual[key] === value ||
                  (typeof actual[key] === "string" &&
                    [
                      "Read",
                      "Write",
                      "Edit",
                      "Bash",
                      "Grep",
                      "Glob",
                      "AskUserQuestion",
                      "EnterPlanMode",
                      "ExitPlanMode",
                      "KillShell",
                      "NotebookEdit",
                      "Skill",
                      "Task",
                      "TaskOutput",
                      "TodoWrite",
                      "WebFetch",
                      "WebSearch",
                    ].includes(actual[key]) &&
                    typeof value === "string" &&
                    actual[key].toLowerCase() === value.toLowerCase())
                );
              if (key === "input") return sameJsonValue(actual[key], value);
              return actual[key] === value;
            })
          );
        })
      )
        throw new Error(
          "Cannot safely replay native search across an altered assistant turn.",
        );
      assigned.set(sourceIndex, entry!.index);
    }
    if (ordinal !== rows.length)
      throw new Error(
        "Cannot safely replay native search across an altered assistant turn.",
      );
  }
  let replayBytes = 0;
  for (const [sourceIndex, message] of messages.entries()) {
    const evidence = readNativeSearchEvidence(message);
    if (
      !evidence ||
      evidence.adapter !== adapter ||
      !sameWebSearchConnection(evidence.connection, connection) ||
      message.role !== "assistant" ||
      message.stopReason === "aborted" ||
      message.stopReason === "error"
    )
      continue;
    const bytes = admittedJsonBytes(
      evidence.output,
      Math.min(MAX_NATIVE_SEARCH_BYTES, model.contextWindow * 2) - replayBytes,
    );
    if (bytes === undefined)
      throw new Error(
        "Native web search history exceeds its replay budget. Compact the Session before continuing.",
      );
    replayBytes += bytes;
    if (adapter === "responses" && Array.isArray(result.input)) {
      const ids = new Set(
        evidence.output
          .map((item) => item.id)
          .filter((id) => typeof id === "string"),
      );
      const indices = result.input.flatMap((item, index) =>
        record(item) && typeof item.id === "string" && ids.has(item.id)
          ? [index]
          : [],
      );
      if (!indices.length) continue;
      if (indices.at(-1)! - indices[0] + 1 !== indices.length)
        throw new Error(
          "Cannot safely replay native web search across an altered assistant turn.",
        );
      result.input.splice(
        indices[0],
        indices.length,
        ...structuredClone(evidence.output),
      );
    }
    if (adapter === "anthropic" && Array.isArray(result.messages)) {
      const index = assigned.get(sourceIndex);
      if (index === undefined)
        throw new Error(
          "Cannot safely replay native search across an altered assistant turn.",
        );
      result.messages[index] = {
        ...(result.messages[index] as RecordValue),
        content: structuredClone(evidence.output),
      };
    }
  }
  if (replayBytes > Math.min(MAX_NATIVE_SEARCH_BYTES, model.contextWindow * 2))
    throw new Error(
      "Native web search history exceeds its replay budget. Compact the Session before continuing.",
    );
  return result;
}
