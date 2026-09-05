import { createParser } from "eventsource-parser";
import type { WebEvent } from "../../../protocol/types.ts";
import type { WebClient } from "./client.ts";

export class EventResyncRequired extends Error {}

export interface EventStreamOptions {
  client: WebClient;
  cursor: number;
  onConnected: () => void;
  onEvent: (event: WebEvent) => void;
  signal: AbortSignal;
}

export async function consumeEventStream(options: EventStreamOptions) {
  const response = await fetch(`/events?cursor=${options.cursor}`, {
    headers: options.client.headers(),
    signal: options.signal,
  });
  if (response.status === 409)
    throw new EventResyncRequired("event replay expired");
  if (!response.ok || !response.body)
    throw new Error("event connection failed");
  options.onConnected();

  let cursor = options.cursor;
  const parser = createParser({
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
      const { done, value } = await reader.read();
      if (done) throw new Error("event connection closed");
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
