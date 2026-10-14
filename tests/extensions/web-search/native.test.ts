import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  citedText,
  createNativeSearchCapture,
  MAX_NATIVE_SEARCH_BYTES,
  readNativeSearchEvidence,
  replayNativeSearch,
} from "../../../extensions/web-search/native.ts";
import {
  resolveWebSearchSupport,
  webSearchConnection,
} from "../../../extensions/web-search/support.ts";
import { projectMessage } from "../../../web/protocol/types.ts";

const model: Model<Api> = {
  id: "gpt-6-astra",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const config = { enabled: true, modelSupport: [] };
const assistant = (
  patch: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [
    {
      type: "text",
      text: "Slovenia.",
      textSignature: JSON.stringify({ v: 1, id: "msg_result" }),
    },
  ],
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
  ...patch,
});
const search = {
  type: "web_search_call",
  id: "ws_fixture",
  status: "completed",
  action: { type: "search", query: ".si IANA" },
};
const text = {
  type: "message",
  id: "msg_result",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Slovenia.",
      annotations: [
        {
          type: "url_citation",
          start_index: 0,
          end_index: 9,
          url: "https://www.iana.org/domains/root/db/si.html",
          title: "IANA",
        },
      ],
    },
  ],
};

test("eligibility binds protocol/provider/model/endpoint and does not infer search from compatibility", () => {
  assert.equal(resolveWebSearchSupport(model, config).available, true);
  for (const changed of [
    { id: "gpt-4.1-nano" },
    { id: "gpt-6-unknown" },
    { id: "o3-pro" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { api: "openai-codex-responses" as const },
  ])
    assert.equal(
      resolveWebSearchSupport({ ...model, ...changed }, config).available,
      false,
    );
  const custom = {
    ...model,
    provider: "gateway",
    baseUrl: "http://127.0.0.1:8080/v1",
  };
  assert.equal(resolveWebSearchSupport(custom, config).available, false);
  const declared = {
    ...config,
    modelSupport: [{ ...webSearchConnection(custom), supported: true }],
  };
  assert.equal(resolveWebSearchSupport(custom, declared).available, true);
  for (const changed of [
    { id: "gpt-6.1-sol" },
    { provider: "other" },
    { baseUrl: "http://127.0.0.1:8081/v1" },
    { api: "openai-completions" as const },
  ])
    assert.equal(
      resolveWebSearchSupport({ ...custom, ...changed }, declared).available,
      false,
    );
  assert.equal(
    resolveWebSearchSupport(
      {
        ...model,
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        id: "deepseek-v4-pro",
      },
      config,
    ).available,
    false,
  );
  const deepseek = {
    ...model,
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    id: "deepseek-v4-pro",
  };
  assert.equal(
    resolveWebSearchSupport(deepseek, {
      ...config,
      modelSupport: [{ ...webSearchConnection(deepseek), supported: true }],
    }).available,
    false,
  );
  assert.equal(
    resolveWebSearchSupport(model, {
      ...config,
      modelSupport: [{ ...webSearchConnection(model), supported: false }],
    }).available,
    false,
  );
  const claude = {
    ...model,
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    id: "claude-sonnet-4-6",
  };
  assert.equal(resolveWebSearchSupport(claude, config).available, true);
  assert.equal(resolveWebSearchSupport(claude, config, true).available, false);
});

test("Responses persists and replays native output, keeps citations clickable, and projects bounded activity", () => {
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({
    type: "response.completed",
    response: { output: [search, text] },
  });
  const message = capture.finish(assistant());
  assert.ok(message);
  assert.match(
    JSON.stringify(message.content),
    /\[IANA\]\(https:\/\/www\.iana\.org/u,
  );
  assert.equal(
    message.content.some((part) => part.type === "toolCall"),
    false,
  );
  const saved = JSON.parse(JSON.stringify(message)) as AssistantMessage;
  const payload = {
    input: [
      { role: "user", content: "first" },
      { ...text, content: [] },
      { role: "user", content: "next" },
    ],
    tools: [{ type: "function", name: "read" }],
  };
  const replayed = replayNativeSearch(payload, [saved], model, "responses");
  assert.deepEqual(replayed.input, [
    payload.input[0],
    search,
    text,
    payload.input[2],
  ]);
  assert.deepEqual(replayed.tools, payload.tools);
  assert.equal(
    JSON.stringify(replayed).includes("function_call_output"),
    false,
  );
  assert.deepEqual(
    replayNativeSearch(payload, [], model, "responses"),
    payload,
  );
  assert.deepEqual(
    replayNativeSearch(
      payload,
      [saved],
      { ...model, baseUrl: "https://different.test/v1" },
      "responses",
    ),
    payload,
  );
  const projection = projectMessage(saved);
  assert.deepEqual(projection.webSearch, [
    {
      id: "ws_fixture",
      status: "completed",
      query: ".si IANA",
      beforePartIndex: 0,
    },
  ]);
  assert.equal(JSON.stringify(projection).includes('"output_text"'), false);
});

test("native activity projection preserves provider order among commentary, reasoning, local tools and the final answer", () => {
  const intro = {
    ...text,
    id: "intro",
    content: [{ type: "output_text", text: "Checking." }],
  };
  const thought = { type: "reasoning", id: "thinking", summary: [] };
  const call = {
    type: "function_call",
    id: "local",
    call_id: "read",
    name: "read",
    arguments: "{}",
  };
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({
    type: "response.completed",
    response: {
      output: [
        intro,
        search,
        thought,
        call,
        { ...search, id: "ws_second" },
        text,
      ],
    },
  });
  const message = capture.finish(
    assistant({
      content: [
        {
          type: "text",
          text: "Checking.",
          textSignature: JSON.stringify({
            v: 1,
            id: "intro",
            phase: "commentary",
          }),
        },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify(thought),
        },
        { type: "toolCall", id: "read|local", name: "read", arguments: {} },
        ...assistant().content,
      ],
    }),
  );
  assert.ok(message);
  const restored = JSON.parse(JSON.stringify(message));
  assert.deepEqual(
    projectMessage(restored).webSearch?.map(({ id, beforePartIndex }) => ({
      id,
      beforePartIndex,
    })),
    [
      { id: "ws_fixture", beforePartIndex: 1 },
      { id: "ws_second", beforePartIndex: 3 },
    ],
  );
  assert.equal(
    message.content.filter((part) => part.type === "toolCall").length,
    1,
  );
  const anthropic = {
    ...restored,
    openpiWebSearch: {
      ...readNativeSearchEvidence(restored),
      adapter: "anthropic",
      output: [
        { type: "text", text: "Checking." },
        { type: "server_tool_use", id: "ws_fixture", name: "web_search" },
        {
          type: "web_search_tool_result",
          tool_use_id: "ws_fixture",
          content: [],
        },
        { type: "thinking", thinking: "" },
        { type: "tool_use", id: "read", name: "read" },
        { type: "server_tool_use", id: "ws_second", name: "web_search" },
        { type: "text", text: "Slovenia." },
      ],
    },
  };
  assert.deepEqual(
    projectMessage(anthropic).webSearch,
    projectMessage(restored).webSearch,
  );
  assert.equal(
    JSON.stringify(projectMessage(restored)).includes('"output_text"'),
    false,
  );
});

test("native replay preserves ordinary tool pairing and citation-only followups", () => {
  const call = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    arguments: '{"path":"file.txt"}',
  };
  const result = {
    type: "function_call_output",
    call_id: "call_read",
    output: "contents",
  };
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({
    type: "response.completed",
    response: { output: [search, text, call] },
  });
  const message = capture.finish(
    assistant({
      content: [
        ...assistant().content,
        {
          type: "toolCall",
          id: "call_read|fc_read",
          name: "read",
          arguments: { path: "file.txt" },
        },
      ],
      stopReason: "toolUse",
    }),
  )!;
  assert.deepEqual(
    replayNativeSearch(
      { input: [text, call, result] },
      [message],
      model,
      "responses",
    ).input,
    [search, text, call, result],
  );
  const followup = createNativeSearchCapture("responses", model);
  followup.observe({
    type: "response.completed",
    response: { output: [text] },
  });
  const cited = followup.finish(assistant())!;
  assert.deepEqual(readNativeSearchEvidence(cited)?.activities, []);
  assert.match(JSON.stringify(cited.content), /\[IANA\]/u);
});

test("a textual search claim is not evidence; incomplete and cancelled search are not completed", () => {
  assert.equal(
    createNativeSearchCapture("responses", model).finish(assistant()),
    undefined,
  );
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({ type: "response.output_item.done", item: search });
  const cancelled = capture.finish(assistant({ stopReason: "aborted" }));
  assert.equal(cancelled?.stopReason, "aborted");
  assert.equal(
    readNativeSearchEvidence(cancelled)?.activities[0]?.status,
    "incomplete",
  );
  assert.equal(capture.finish(assistant())?.stopReason, "error");
});

test("Anthropic replays opaque server blocks with citations, and distinguishes failure and pause_turn", () => {
  const claude = { ...model, api: "anthropic-messages" as const };
  const run = (error: boolean, pause = false) => {
    const capture = createNativeSearchCapture("anthropic", claude);
    const blocks = [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: error
          ? { type: "web_search_tool_result_error", error_code: "unavailable" }
          : [
              {
                type: "web_search_result",
                url: "https://iana.org",
                title: "IANA",
                encrypted_content: "opaque",
              },
            ],
      },
      { type: "text", text: "Slovenia." },
    ];
    blocks.forEach((content_block, index) => {
      capture.observe({ type: "content_block_start", index, content_block });
    });
    capture.observe({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":".si IANA"}' },
    });
    capture.observe({ type: "content_block_stop", index: 0 });
    capture.observe({
      type: "content_block_delta",
      index: 2,
      delta: {
        type: "citations_delta",
        citation: {
          url: "https://iana.org",
          title: "IANA",
          encrypted_index: "opaque-index",
        },
      },
    });
    capture.observe({
      type: "message_delta",
      delta: { stop_reason: pause ? "pause_turn" : "end_turn" },
    });
    capture.observe({ type: "message_stop" });
    return capture.finish(assistant({ api: claude.api }));
  };
  const message = run(false);
  assert.ok(message);
  assert.equal(message.stopReason, "stop");
  const evidence = readNativeSearchEvidence(message)!;
  assert.deepEqual(evidence.output[0]?.input, { query: ".si IANA" });
  assert.deepEqual(evidence.output[2]?.citations, [
    {
      url: "https://iana.org",
      title: "IANA",
      encrypted_index: "opaque-index",
    },
  ]);
  const content = message.content
    .filter((part) => part.type === "text")
    .map((part) => ({ type: "text", text: part.text }));
  assert.deepEqual(
    replayNativeSearch(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "unrelated" }, ...content],
          },
        ],
      },
      [message],
      claude,
      "anthropic",
    ).messages,
    [
      {
        role: "assistant",
        content: [{ type: "text", text: "unrelated" }, ...evidence.output],
      },
    ],
  );
  assert.equal(run(true)?.stopReason, "error");
  assert.match(run(false, true)?.errorMessage ?? "", /paused/u);
});

test("native replay is bounded without counting ordinary images or making unsafe citation links", () => {
  const image = {
    input: [
      {
        role: "user",
        content: [{ type: "input_image", image_url: "x".repeat(500000) }],
      },
    ],
  };
  assert.deepEqual(replayNativeSearch(image, [], model, "responses"), image);
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({
    type: "response.completed",
    response: {
      output: [search, { ...text, extra: "x".repeat(MAX_NATIVE_SEARCH_BYTES) }],
    },
  });
  assert.equal(capture.finish(assistant())?.stopReason, "error");
  assert.equal(citedText("text", [{ url: "javascript:alert(1)" }]), "text");
  assert.equal(
    citedText("text", [{ url: "https://user:secret@example.org" }]),
    "text",
  );
});
