import { createParser } from "eventsource-parser";
import type { WebEvent } from "../../../protocol/types.ts";
import type { WebClient } from "./client.ts";

export class EventResyncRequired extends Error {}

export interface EventStreamOptions {
  client: WebClient;
  cursor: number;
  onConnected: () => void;
  onHeartbeat?: () => void;
  onEvent: (event: WebEvent) => void;
  signal: AbortSignal;
}

export async function consumeEventStream(options: EventStreamOptions) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = window.setTimeout(abort, 45_000);
  const response = await fetch(`/events?cursor=${options.cursor}`, {
    headers: options.client.headers(),
    signal: controller.signal,
  }).finally(() => {
    window.clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  });
  if (response.status === 409)
    throw new EventResyncRequired("event replay expired");
  if (!response.ok || !response.body)
    throw new Error("event connection failed");
  options.onConnected();

  let cursor = options.cursor;
  let heartbeats = 0;
  const parser = createParser({
    onComment(comment) {
      if (comment.trim() === "heartbeat" && ++heartbeats >= 4) {
        heartbeats = 0;
        options.onHeartbeat?.();
      }
    },
    onEvent(record) {
      const event = JSON.parse(record.data) as WebEvent;
      if (!Number.isSafeInteger(event.sequence)) {
        throw new EventResyncRequired("invalid event cursor");
      }
      if (event.sequence <= cursor) return;
      if (event.sequence !== cursor + 1) {
        throw new EventResyncRequired("event cursor gap");
      }
      cursor = event.sequence;
      if (event.type === "state_invalidated") {
        throw new EventResyncRequired("state invalidated");
      }
      options.onEvent(event);
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!options.signal.aborted) {
      let timer: number | undefined;
      let onAbort: (() => void) | undefined;
      const chunk = reader.read();
      const interruption = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("event stream aborted"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
        timer = window.setTimeout(
          () => reject(new Error("event stream stalled")),
          45_000,
        );
      });
      const { done, value } = await Promise.race([chunk, interruption]).finally(
        () => {
          window.clearTimeout(timer);
          if (onAbort) options.signal.removeEventListener("abort", onAbort);
        },
      );
      if (done) throw new Error("event connection closed");
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
