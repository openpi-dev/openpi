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
        ["completed", "failed", "incomplete"].includes(String(item.status)),
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
  let stopped = false;
  let stopReason = "";
  return {
    observe(data: unknown) {
      if (!record(data)) return;
      if (adapter === "responses") {
        if (data.type === "response.output_item.done" && record(data.item))
          output.push(structuredClone(data.item));
        if (
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(String(data.type)) &&
          record(data.response)
        ) {
          if (
            Array.isArray(data.response.output) &&
            data.response.output.every(record)
          )
            output = structuredClone(data.response.output);
          stopped = data.type === "response.completed";
        }
      } else {
        const index = typeof data.index === "number" ? data.index : -1;
        if (data.type === "content_block_start" && record(data.content_block))
          blocks.set(index, structuredClone(data.content_block));
        const block = blocks.get(index);
        if (
          data.type === "content_block_delta" &&
          block &&
          record(data.delta)
        ) {
          const delta = data.delta;
          if (delta.type === "text_delta")
            block.text = String(block.text ?? "") + String(delta.text ?? "");
          if (delta.type === "thinking_delta")
            block.thinking =
              String(block.thinking ?? "") + String(delta.thinking ?? "");
          if (delta.type === "signature_delta")
            block.signature =
              String(block.signature ?? "") + String(delta.signature ?? "");
          if (delta.type === "input_json_delta")
            inputJson.set(
              index,
              (inputJson.get(index) ?? "") + String(delta.partial_json ?? ""),
            );
          if (delta.type === "citations_delta")
            block.citations = [
              ...(Array.isArray(block.citations) ? block.citations : []),
              ...(record(delta.citation)
                ? [structuredClone(delta.citation)]
                : []),
            ];
        }
        if (
          data.type === "content_block_stop" &&
          block &&
          inputJson.has(index)
        ) {
          try {
            block.input = JSON.parse(inputJson.get(index)!);
          } catch {
            stopReason = "invalid-tool-input";
          }
        }
        if (data.type === "message_delta" && record(data.delta))
          stopReason = String(data.delta.stop_reason ?? stopReason);
        if (data.type === "message_stop") stopped = true;
      }
    },
    finish(message: AssistantMessage) {
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
      if (
        new TextEncoder().encode(JSON.stringify(output)).byteLength >
        MAX_NATIVE_SEARCH_BYTES
      ) {
        return {
          ...message,
          stopReason: "error" as const,
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
  if (
    !messages.some((message) => {
      const evidence = readNativeSearchEvidence(message);
      return (
        evidence &&
        evidence.adapter === adapter &&
        sameWebSearchConnection(evidence.connection, connection)
      );
    })
  )
    return payload;
  const result = structuredClone(payload);
  let replayBytes = 0;
  for (const message of messages) {
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
    replayBytes += new TextEncoder().encode(
      JSON.stringify(evidence.output),
    ).byteLength;
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
      const texts = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id);
      const signatures = message.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinkingSignature);
      for (const item of result.messages) {
        if (
          !record(item) ||
          item.role !== "assistant" ||
          !Array.isArray(item.content)
        )
          continue;
        const indices = item.content.flatMap((part, index) =>
          record(part) &&
          ((part.type === "text" && texts.includes(String(part.text))) ||
            (part.type === "tool_use" && calls.includes(String(part.id))) ||
            (part.type === "thinking" &&
              signatures.includes(String(part.signature))) ||
            (part.type === "redacted_thinking" &&
              signatures.includes(String(part.data))))
            ? [index]
            : [],
        );
        if (!indices.length) continue;
        if (indices.at(-1)! - indices[0] + 1 !== indices.length)
          throw new Error(
            "Cannot safely replay native search across an altered assistant turn.",
          );
        item.content.splice(
          indices[0],
          indices.length,
          ...structuredClone(evidence.output),
        );
        break;
      }
    }
  }
  if (replayBytes > Math.min(MAX_NATIVE_SEARCH_BYTES, model.contextWindow * 2))
    throw new Error(
      "Native web search history exceeds its replay budget. Compact the Session before continuing.",
    );
  return result;
}
