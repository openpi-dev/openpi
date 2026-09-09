// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { consumeEventStream } from "../../web/ui/src/protocol/event-stream.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bounds a stalled event read and cancels the stream", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
  );
  const consuming = consumeEventStream({
    client: new WebClient(),
    cursor: 0,
    signal: new AbortController().signal,
    onConnected() {},
    onEvent() {},
  });
  const failure = expect(consuming).rejects.toThrow("event stream stalled");
  await vi.advanceTimersByTimeAsync(45_000);
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes after four quiet heartbeats and cleans up on abort", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const heartbeat = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(": heartbeat\n\n".repeat(4)),
            );
          },
          cancel,
        }),
      ),
    ),
  );
  const consuming = consumeEventStream({
    client: new WebClient(),
    cursor: 0,
    signal: controller.signal,
    onConnected() {},
    onHeartbeat: heartbeat,
    onEvent() {},
  });
  const failure = expect(consuming).rejects.toThrow("event stream aborted");
  await vi.advanceTimersByTimeAsync(0);
  expect(heartbeat).toHaveBeenCalledOnce();
  controller.abort();
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("times out HTTP admission at thirty seconds while preserving its request identity", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_path: string, options: RequestInit) =>
      new Promise<Response>((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const request = new WebClient().prompt(
    "session",
    "once",
    "stable-command",
    true,
  );
  const failure = expect(request).rejects.toThrow(
    "admission may still be pending",
  );
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
    sessionId: "session",
    content: "once",
    commandId: "stable-command",
    retry: true,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("retains backend rejection codes for admission certainty", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "full", code: "PROMPT_ADMISSION_CAPACITY" }),
          { status: 503 },
        ),
      ),
  );
  const error = await new WebClient()
    .prompt("s", "once", "id")
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WebApiError);
  expect(error).toMatchObject({
    code: "PROMPT_ADMISSION_CAPACITY",
    status: 503,
  });
});

it("bounds a connection that never receives event headers", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("headers stalled")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const consuming = consumeEventStream({
    client: new WebClient(),
    cursor: 0,
    signal: new AbortController().signal,
    onConnected() {},
    onEvent() {},
  });
  const failure = expect(consuming).rejects.toThrow("headers stalled");
  await vi.advanceTimersByTimeAsync(45_000);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["{", "{}", '{"id":"x","accepted":false}'])(
  "rejects malformed successful admission receipts (%s)",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 202 })),
    );
    await expect(
      new WebClient().prompt("s", "once", "stable"),
    ).rejects.toBeInstanceOf(Error);
  },
);

it("keeps the HTTP deadline through a stalled body even with a caller signal", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: string, options: RequestInit) => {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"partial":'));
              options.signal?.addEventListener(
                "abort",
                () => stream.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
      );
    }),
  );
  const request = new WebClient().request("/api/snapshot", {
    signal: caller.signal,
  });
  const failure = expect(request).rejects.toThrow("Request timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await failure;
  expect(caller.signal.aborted).toBe(false);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([200, 503])(
  "cleans up request deadlines and caller listeners after HTTP %s",
  async (status) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response('{"error":"unavailable"}', { status })),
    );
    const request = new WebClient().request("/api/snapshot", {
      signal: caller.signal,
    });
    if (status === 200) await request;
    else await expect(request).rejects.toThrow("unavailable");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("prefers the current page credential over stale links and storage", () => {
  const current = "a".repeat(64);
  const meta = document.createElement("meta");
  meta.name = "openpi-web-token";
  meta.content = current;
  document.head.append(meta);
  history.replaceState(null, "", "/#token=old-link");
  sessionStorage.setItem("openpi.web.token", "old-storage");
  try {
    expect(new WebClient().token).toBe(current);
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("openpi.web.token")).toBe(current);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(new WebClient().token).toBe(current);
  } finally {
    meta.remove();
    vi.restoreAllMocks();
    sessionStorage.clear();
  }
});

it("retains the fragment entry for the separate Vite developer page", () => {
  history.replaceState(null, "", "/#token=legacy-development");
  try {
    expect(new WebClient().token).toBe("legacy-development");
    expect(location.hash).toBe("");
  } finally {
    sessionStorage.clear();
  }
});

it("requests a bounded model search for the current Session", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        models: [],
        totalAvailable: 251,
        totalMatches: 0,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 2,
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);

  await new WebClient().searchModels("k", "session-1");

  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/api/models?query=k&limit=50&sessionId=session-1",
  );
});
