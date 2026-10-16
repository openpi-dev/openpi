// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => vi.restoreAllMocks());

it("sends mixed pin identities and the observed reading revision without retrying either reading operation", async () => {
  const client = new WebClient();
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValue({ saved: true });
  const target = { kind: "workspace" as const, path: "/project" };
  const before = {
    kind: "session" as const,
    path: "/sessions/a.jsonl",
    id: "a",
  };
  await client.setSidebarPin(target, true, before);
  expect(request.mock.calls[0]).toEqual([
    "/api/sidebar/pin",
    { method: "POST", body: JSON.stringify({ target, pinned: true, before }) },
  ]);
  await client.setSessionRead(
    before.path,
    before.id,
    true,
    "observed-revision",
  );
  expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
    path: before.path,
    id: "a",
    read: true,
    expectedRevision: "observed-revision",
  });
  await client.setSessionOrder(before.path, before.id, null);
  expect(JSON.parse(request.mock.calls[2]![1]!.body as string)).toEqual({
    path: before.path,
    id: "a",
    before: null,
  });
  await client.setSessionRead(before.path, before.id, false, "next-revision");
  expect(JSON.parse(request.mock.calls[3]![1]!.body as string)).toEqual({
    path: before.path,
    id: "a",
    read: false,
    expectedRevision: "next-revision",
  });
});

it("passes opaque worktree cursors and exact release identities without a fallback mutation", async () => {
  const client = new WebClient();
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValue({ worktrees: [], truncated: false, unavailable: 0 });
  await client.workspaceWorktrees("/project & files", "opaque+next/=?");
  const query = new URL(request.mock.calls[0]![0], "http://localhost")
    .searchParams;
  expect(query.get("path")).toBe("/project & files");
  expect(query.get("cursor")).toBe("opaque+next/=?");
  const release = {
    commandId: "original-request",
    sessionId: "deleted-native-child",
    sessionPath: "/sessions/child.jsonl",
    worktreePath: "/managed/child",
  };
  request.mockRejectedValueOnce(new Error("response lost"));
  await expect(client.releaseSessionWorktree(release)).rejects.toThrow(
    "response lost",
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual([
    "/api/sessions/worktree-release",
    { method: "POST", body: JSON.stringify(release) },
  ]);
});
