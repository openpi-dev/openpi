// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => vi.restoreAllMocks());

it("requests an exact prompt index with an optional native cursor and cancellation", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({});
  const anchor = {
    sessionId: "same-id",
    sessionPath: "/a space/session+copy.jsonl",
    entryId: "native-anchor",
  };
  const controller = new AbortController();
  await client.sessionPromptHistory(anchor, null, controller.signal);
  await client.sessionPromptHistory(anchor, "native-before", controller.signal);
  for (const [path, options] of request.mock.calls) {
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/session/prompt-history");
    expect(url.searchParams.get("sessionId")).toBe(anchor.sessionId);
    expect(url.searchParams.get("path")).toBe(anchor.sessionPath);
    expect(url.searchParams.get("anchorEntryId")).toBe(anchor.entryId);
    expect(options?.signal).toBe(controller.signal);
  }
  expect(
    new URL(request.mock.calls[0]![0], "http://localhost").searchParams.has(
      "beforeEntryId",
    ),
  ).toBe(false);
  expect(
    new URL(request.mock.calls[1]![0], "http://localhost").searchParams.get(
      "beforeEntryId",
    ),
  ).toBe("native-before");
});

it("reads a hovered prompt against its exact frozen branch anchor without acknowledging it", async () => {
  const client = new WebClient();
  const request = vi.spyOn(client, "request").mockResolvedValue({});
  const controller = new AbortController();
  const result = await client.sessionPromptPreview(
    {
      sessionId: "same-id",
      sessionPath: "/copy/session.jsonl",
      entryId: "latest-native",
    },
    "hovered-native",
    controller.signal,
  );
  expect(result).toEqual({});
  const [path, options] = request.mock.calls[0]!;
  const url = new URL(path, "http://localhost");
  expect(url.pathname).toBe("/api/session/prompt-preview");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    sessionId: "same-id",
    path: "/copy/session.jsonl",
    anchorEntryId: "latest-native",
    entryId: "hovered-native",
  });
  expect(options?.signal).toBe(controller.signal);
  expect(options?.method).toBeUndefined();
});
