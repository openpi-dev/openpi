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
