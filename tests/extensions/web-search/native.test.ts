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
            content,
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
        content: evidence.output,
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

test("Anthropic replay binds repeated answers to every surviving assistant ordinal", () => {
  const claude = { ...model, api: "anthropic-messages" as const };
  const ordinary = assistant({
    api: claude.api,
    content: [{ type: "text", text: "Done." }],
  });
  const searched = {
    ...ordinary,
    openpiWebSearch: {
      version: 1,
      connection: webSearchConnection(claude),
      adapter: "anthropic",
      output: [
        {
          type: "server_tool_use",
          id: "second",
          name: "web_search",
          input: {},
        },
        { type: "text", text: "Done." },
      ],
      activities: [],
    },
  };
  const payload = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ],
  };
  const replayed = replayNativeSearch(
    payload,
    [ordinary, searched],
    claude,
    "anthropic",
  );
  assert.ok(Array.isArray(replayed.messages));
  assert.deepEqual(replayed.messages[0], payload.messages[0]);
  assert.deepEqual(
    replayed.messages[2]?.content,
    searched.openpiWebSearch.output,
  );
  assert.deepEqual(payload.messages[2]?.content, ordinary.content);
});

test("optional capture overflow is terminal only for hosted evidence, including late evidence", () => {
  for (const adapter of ["responses", "anthropic"] as const) {
    const capture = createNativeSearchCapture(adapter, model);
    const huge = '界\\"'.repeat(MAX_NATIVE_SEARCH_BYTES);
    capture.observe(
      adapter === "responses"
        ? {
            type: "response.output_item.done",
            item: {
              type: "message",
              content: [{ type: "output_text", text: huge }],
            },
          }
        : {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: huge },
          },
    );
    assert.equal(capture.finish(assistant()), undefined);
    capture.observe(
      adapter === "responses"
        ? { type: "response.output_item.done", item: search }
        : {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "server_tool_use",
              name: "web_search",
              id: "late",
            },
          },
    );
    assert.equal(capture.finish(assistant())?.stopReason, "error");
    assert.equal(
      readNativeSearchEvidence(capture.finish(assistant())),
      undefined,
    );
    assert.equal(
      capture.finish(assistant({ stopReason: "aborted" }))?.stopReason,
      "aborted",
    );
  }
});

test("Anthropic ordinal replay survives saved v1 history, empty/error predecessors and compaction", () => {
  const claude = { ...model, api: "anthropic-messages" as const };
  const done = assistant({
    api: claude.api,
    content: [{ type: "text", text: "Done." }],
  });
  const saved = (id: string) =>
    JSON.parse(
      JSON.stringify({
        ...done,
        openpiWebSearch: {
          version: 1,
          connection: webSearchConnection(claude),
          adapter: "anthropic",
          output: [
            {
              type: "server_tool_use",
              id,
              name: "web_search",
              input: { query: id },
            },
            { type: "text", text: "Done." },
          ],
          activities: [],
        },
      }),
    ) as AssistantMessage;
  const first = saved("first"),
    second = saved("second");
  const row = { role: "assistant", content: [{ type: "text", text: "Done." }] };
  const history = [
    assistant({ content: [] }),
    assistant({ stopReason: "error" }),
    assistant({ stopReason: "aborted" }),
    done,
    first,
    second,
  ];
  const result = replayNativeSearch(
    { messages: [row, row, row] },
    history,
    claude,
    "anthropic",
  );
  assert.ok(Array.isArray(result.messages));
  assert.equal(result.messages[0], row);
  assert.deepEqual(
    result.messages[1]?.content,
    readNativeSearchEvidence(first)?.output,
  );
  assert.deepEqual(
    result.messages[2]?.content,
    readNativeSearchEvidence(second)?.output,
  );
  const compacted = replayNativeSearch(
    { messages: [row] },
    [second],
    claude,
    "anthropic",
  );
  assert.ok(Array.isArray(compacted.messages));
  assert.deepEqual(
    compacted.messages[0]?.content,
    readNativeSearchEvidence(second)?.output,
  );
  assert.throws(
    () =>
      replayNativeSearch(
        {
          messages: [
            {
              ...row,
              content: [...row.content, { type: "text", text: "extra" }],
            },
          ],
        },
        [second],
        claude,
        "anthropic",
      ),
    /altered/u,
  );
  assert.throws(
    () => replayNativeSearch({ messages: [] }, [second], claude, "anthropic"),
    /altered/u,
  );
});

test("capture admits exact escaped UTF8 boundary and opaque values before terminal replacement", () => {
  const opaque = { ...search, extra: '界\\"\n😀'.repeat(1000) };
  const overhead = Buffer.byteLength(JSON.stringify([opaque]));
  opaque.extra += "x".repeat(MAX_NATIVE_SEARCH_BYTES - overhead);
  assert.equal(
    Buffer.byteLength(JSON.stringify([opaque])),
    MAX_NATIVE_SEARCH_BYTES,
  );
  const capture = createNativeSearchCapture("responses", model);
  capture.observe({ type: "response.output_item.done", item: search });
  capture.observe({
    type: "response.completed",
    response: { output: [opaque] },
  });
  assert.deepEqual(
    readNativeSearchEvidence(capture.finish(assistant()))?.output,
    [opaque],
  );
  const overflow = createNativeSearchCapture("responses", model);
  overflow.observe({
    type: "response.output_item.done",
    item: { ...opaque, extra: opaque.extra + "x" },
  });
  overflow.observe({
    type: "response.completed",
    response: { output: [search] },
  });
  assert.equal(
    readNativeSearchEvidence(overflow.finish(assistant())),
    undefined,
  );
});

test("Anthropic incremental overflow and malformed input cannot recover into partial replay", () => {
  for (const field of [
    "text",
    "thinking",
    "signature",
    "partial_json",
  ] as const) {
    const capture = createNativeSearchCapture("anthropic", model);
    capture.observe({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "server_tool_use",
        id: "search",
        name: "web_search",
        input: {},
        [field]: "",
      },
    });
    for (let i = 0; i < 280; i++)
      capture.observe({
        type: "content_block_delta",
        index: 0,
        delta: {
          type:
            field === "partial_json" ? "input_json_delta" : `${field}_delta`,
          [field]: "x".repeat(1024),
        },
      });
    capture.observe({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    capture.observe({ type: "message_stop" });
    assert.equal(capture.finish(assistant())?.stopReason, "error");
    assert.equal(
      readNativeSearchEvidence(capture.finish(assistant())),
      undefined,
    );
  }
  const capture = createNativeSearchCapture("anthropic", model);
  capture.observe({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "server_tool_use",
      id: "search",
      name: "web_search",
      input: {},
    },
  });
  capture.observe({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: "{" },
  });
  capture.observe({ type: "content_block_stop", index: 0 });
  capture.observe({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
  });
  assert.equal(capture.finish(assistant())?.stopReason, "error");
  assert.equal(
    readNativeSearchEvidence(capture.finish(assistant())),
    undefined,
  );
});

test("capture accounts for a UTF16 pair split across deltas at the exact JSON limit", () => {
  const searchBlock = {
    type: "server_tool_use",
    id: "search",
    name: "web_search",
    input: {},
  };
  const textBlock = { type: "text", text: "\ud83d" };
  textBlock.text =
    "x".repeat(
      MAX_NATIVE_SEARCH_BYTES -
        Buffer.byteLength(JSON.stringify([searchBlock, textBlock])),
    ) + textBlock.text;
  const capture = createNativeSearchCapture("anthropic", model);
  capture.observe({
    type: "content_block_start",
    index: 0,
    content_block: searchBlock,
  });
  capture.observe({
    type: "content_block_start",
    index: 1,
    content_block: textBlock,
  });
  capture.observe({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "\ude00" },
  });
  const evidence = readNativeSearchEvidence(capture.finish(assistant()));
  assert.ok(evidence);
  assert.equal(evidence.output[1]?.text, textBlock.text + "\ude00");
});

test("capture latches duplicate indices, cyclic items and many small output items", () => {
  const capture = createNativeSearchCapture("anthropic", model);
  const content_block = {
    type: "server_tool_use",
    id: "search",
    name: "web_search",
    input: {},
  };
  capture.observe({ type: "content_block_start", index: 0, content_block });
  assert.equal(
    capture.observe({ type: "content_block_start", index: 0, content_block }),
    true,
  );
  assert.equal(capture.observe({ type: "message_stop" }), false);
  assert.equal(
    readNativeSearchEvidence(capture.finish(assistant())),
    undefined,
  );
  const cyclic: Record<string, unknown> = { ...search };
  cyclic.self = cyclic;
  const responses = createNativeSearchCapture("responses", model);
  assert.equal(
    responses.observe({ type: "response.output_item.done", item: cyclic }),
    true,
  );
  const many = createNativeSearchCapture("responses", model);
  for (let i = 0; i < 10000; i++)
    many.observe({
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [{ type: "output_text", text: "x".repeat(30) }],
      },
    });
  assert.equal(many.finish(assistant()), undefined);
  assert.equal(
    many.observe({ type: "response.web_search_call.in_progress" }),
    true,
  );
  assert.equal(readNativeSearchEvidence(many.finish(assistant())), undefined);
});

test("matching restored malformed or oversized evidence is rejected before replay cloning", () => {
  const base = {
    ...assistant(),
    openpiWebSearch: {
      version: 1,
      connection: webSearchConnection(model),
      adapter: "responses",
      output: [search],
      activities: [],
    },
  };
  const malformed = {
    ...base,
    openpiWebSearch: { ...base.openpiWebSearch, output: [null] },
  };
  const oversized = {
    ...base,
    openpiWebSearch: {
      ...base.openpiWebSearch,
      output: [{ ...search, extra: "x".repeat(MAX_NATIVE_SEARCH_BYTES) }],
    },
  };
  assert.throws(
    () => replayNativeSearch({ input: [] }, [malformed], model, "responses"),
    /invalid/u,
  );
  assert.throws(
    () =>
      replayNativeSearch({ input: [text] }, [oversized], model, "responses"),
    /budget/u,
  );
  const capture = createNativeSearchCapture("responses", model);
  assert.equal(
    capture.observe({ type: "response.completed", response: { output: {} } }),
    true,
  );
  assert.equal(capture.finish(assistant())?.stopReason, "error");
  assert.equal(
    readNativeSearchEvidence(capture.finish(assistant())),
    undefined,
  );
});

test("aborted and errored evidence alone never activates replay validation", () => {
  const claude = { ...model, api: "anthropic-messages" as const };
  const payload = { messages: [{ role: "user", content: "retry" }] };
  for (const stopReason of ["aborted", "error"] as const) {
    const source = {
      ...assistant({ stopReason }),
      openpiWebSearch: {
        version: 1,
        connection: webSearchConnection(claude),
        adapter: "anthropic",
        output: [{ type: "server_tool_use", name: "web_search" }],
        activities: [],
      },
    };
    assert.equal(
      replayNativeSearch(payload, [source], claude, "anthropic"),
      payload,
    );
  }
});

test("malformed stream marker values are never string-coerced after optional capture discard", () => {
  const hostile = {
    toString() {
      throw new Error("must not coerce provider markers");
    },
  };
  const responses = createNativeSearchCapture("responses", model);
  assert.equal(responses.observe({ type: hostile }), false);
  const anthropic = createNativeSearchCapture("anthropic", model);
  anthropic.observe({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "x".repeat(MAX_NATIVE_SEARCH_BYTES) },
  });
  assert.equal(
    anthropic.observe({
      type: "message_delta",
      delta: { stop_reason: hostile },
    }),
    false,
  );
  assert.equal(anthropic.finish(assistant()), undefined);
});

test("Responses terminal envelope validation survives prior capture discard and never restores a prefix", () => {
  for (const response of [
    null,
    "invalid",
    { output: {} },
    { output: [null] },
  ]) {
    const ordinary = createNativeSearchCapture("responses", model);
    ordinary.observe({
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [
          { type: "output_text", text: "x".repeat(MAX_NATIVE_SEARCH_BYTES) },
        ],
      },
    });
    assert.equal(ordinary.finish(assistant()), undefined);
    assert.equal(
      ordinary.observe({ type: "response.completed", response }),
      true,
    );
    assert.equal(ordinary.finish(assistant())?.stopReason, "error");
    assert.equal(
      ordinary.finish(assistant({ stopReason: "aborted" }))?.stopReason,
      "aborted",
    );
    const hosted = createNativeSearchCapture("responses", model);
    hosted.observe({ type: "response.output_item.done", item: search });
    hosted.observe({ type: "response.completed", response });
    hosted.observe({
      type: "response.completed",
      response: { output: [search] },
    });
    assert.equal(hosted.finish(assistant())?.stopReason, "error");
    assert.equal(
      readNativeSearchEvidence(hosted.finish(assistant())),
      undefined,
    );
  }
  const validOrdinary = createNativeSearchCapture("responses", model);
  validOrdinary.observe({
    type: "response.completed",
    response: {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "x".repeat(MAX_NATIVE_SEARCH_BYTES) },
          ],
        },
      ],
    },
  });
  assert.equal(validOrdinary.finish(assistant()), undefined);
});

test("Anthropic assignment distinguishes duplicate retained message references by occurrence", () => {
  const claude = { ...model, api: "anthropic-messages" as const };
  const searched = {
    ...assistant({
      api: claude.api,
      content: [{ type: "text" as const, text: "Done." }],
    }),
    openpiWebSearch: {
      version: 1,
      connection: webSearchConnection(claude),
      adapter: "anthropic",
      output: [
        { type: "server_tool_use", id: "same", name: "web_search", input: {} },
        { type: "text", text: "Done." },
      ],
      activities: [],
    },
  };
  const row = { role: "assistant", content: [{ type: "text", text: "Done." }] };
  const result = replayNativeSearch(
    { messages: [row, row] },
    [searched, searched],
    claude,
    "anthropic",
  );
  assert.ok(Array.isArray(result.messages));
  for (const item of result.messages)
    assert.deepEqual(item.content, searched.openpiWebSearch.output);
});

test("marker inspection bounds expanded graphs while preserving known ordinary output and late search", () => {
  const part = { type: "output_text", text: "ordinary" };
  const ordinary = { type: "message", content: Array(10000).fill(part) };
  const shared = createNativeSearchCapture("responses", model);
  assert.equal(
    shared.observe({
      type: "response.completed",
      response: { output: Array(10000).fill(ordinary) },
    }),
    false,
  );
  assert.equal(shared.finish(assistant()), undefined);
  assert.equal(
    shared.observe({ type: "response.web_search_call.in_progress" }),
    true,
  );
  assert.equal(readNativeSearchEvidence(shared.finish(assistant())), undefined);
  const uncertain = createNativeSearchCapture("responses", model);
  const distinct = Array.from({ length: 1000 }, () => ({
    type: "message",
    content: Array(1000).fill(part),
  }));
  assert.equal(
    uncertain.observe({
      type: "response.completed",
      response: { output: distinct },
    }),
    true,
  );
  assert.equal(uncertain.finish(assistant())?.stopReason, "error");
  assert.equal(
    readNativeSearchEvidence(uncertain.finish(assistant())),
    undefined,
  );
});

test("many single-character deltas preserve complete opaque text and trailing surrogate accounting", () => {
  const capture = createNativeSearchCapture("anthropic", model);
  capture.observe({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "server_tool_use",
      id: "search",
      name: "web_search",
      input: {},
    },
  });
  capture.observe({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  });
  for (let index = 0; index < 250000; index++)
    capture.observe({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "x" },
    });
  capture.observe({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "\ud83d" },
  });
  capture.observe({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "\ude00" },
  });
  assert.equal(
    readNativeSearchEvidence(capture.finish(assistant()))?.output[1]?.text,
    "x".repeat(250000) + "😀",
  );
});

test("marker inspection bounds deep and cyclic content before cloning or retaining evidence", () => {
  let deep: Record<string, unknown> = { type: "output_text", text: "ordinary" };
  for (let index = 0; index < 10000; index++)
    deep = { type: "message", content: [deep] };
  const cyclic: Record<string, unknown> = { type: "message" };
  cyclic.content = [cyclic];
  for (const item of [deep, cyclic]) {
    const capture = createNativeSearchCapture("responses", model);
    assert.equal(
      capture.observe({ type: "response.output_item.done", item }),
      true,
    );
    assert.equal(capture.finish(assistant())?.stopReason, "error");
    assert.equal(
      readNativeSearchEvidence(capture.finish(assistant())),
      undefined,
    );
  }
});

test("malformed nonterminal output remains relevant after optional capture discard", () => {
  for (const adapter of ["responses", "anthropic"] as const) {
    const capture = createNativeSearchCapture(adapter, model);
    capture.observe(
      adapter === "responses"
        ? {
            type: "response.output_item.done",
            item: {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "x".repeat(MAX_NATIVE_SEARCH_BYTES),
                },
              ],
            },
          }
        : {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: "x".repeat(MAX_NATIVE_SEARCH_BYTES),
            },
          },
    );
    assert.equal(capture.finish(assistant()), undefined);
    assert.equal(
      capture.observe(
        adapter === "responses"
          ? { type: "response.output_item.done", item: null }
          : { type: "content_block_start", index: 1, content_block: null },
      ),
      true,
    );
    assert.equal(capture.finish(assistant())?.stopReason, "error");
    assert.equal(
      readNativeSearchEvidence(capture.finish(assistant())),
      undefined,
    );
  }
});
