// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => vi.restoreAllMocks());

it("encodes the archived Session query and opaque cursor and forwards cancellation", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({});
  const controller = new AbortController();
  await client.listArchivedSessions(
    { query: "word & space", cursor: "opaque+/=", limit: 25 },
    controller.signal,
  );
  const [path, options] = request.mock.calls[0]!;
  const url = new URL(path, "http://localhost");
  expect(url.pathname).toBe("/api/sessions/archived");
  expect(url.searchParams.get("q")).toBe("word & space");
  expect(url.searchParams.get("cursor")).toBe("opaque+/=");
  expect(url.searchParams.get("limit")).toBe("25");
  expect(options?.signal).toBe(controller.signal);
});

it("omits unspecified archive query options", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({});
  await client.listArchivedSessions();
  const url = new URL(request.mock.calls[0]![0], "http://localhost");
  expect([...url.searchParams]).toEqual([]);
});
