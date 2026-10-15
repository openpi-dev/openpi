// @vitest-environment jsdom

import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WebGitReviewResult,
  WebSessionProjection,
} from "../../web/protocol/types.ts";
import { useGitReview } from "../../web/ui/src/features/review/use-git-review.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("binds a chosen base to the exact Session and cancels an earlier comparison", async () => {
  vi.useFakeTimers();
  let finish!: (value: WebGitReviewResult) => void;
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ...oldResult,
      snapshot: {
        ...oldResult.snapshot,
        comparison: "branch",
        baseBranch: "refs/heads/main",
        revision: "new",
      },
    });
  const selected = session("same-id");
  const { result, rerender } = renderHook(
    ({ selected }) =>
      useGitReview(selected, 1, {
        initialSource: "branch",
        initialBaseRef: "refs/heads/release",
      }),
    { initialProps: { selected } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read.mock.calls[0]?.[3]).toEqual({
    source: "branch",
    offset: "0",
    baseRef: "refs/heads/release",
  });
  act(() => result.current.setBaseRef("refs/heads/main"));
  expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => finish(oldResult));
  expect(result.current.result).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read.mock.calls[1]?.[3]?.baseRef).toBe("refs/heads/main");
  rerender({ selected: { ...selected, path: "/sessions/copied.jsonl" } });
  expect(result.current.baseRef).toBe("refs/heads/release");
  expect(result.current.result).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read.mock.calls.at(-1)?.[1]).toBe("/sessions/copied.jsonl");
  expect(read.mock.calls.at(-1)?.[3]?.baseRef).toBe("refs/heads/release");
});

it("passes the pinned summary revision to a lazy detail and refreshes on drift or an unconfirmed response", async () => {
  vi.useFakeTimers();
  const latest = {
    ...oldResult,
    snapshot: { ...oldResult.snapshot, revision: "latest" },
  };
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValueOnce(oldResult)
    .mockResolvedValueOnce({ ok: false, reason: "revision_changed" })
    .mockResolvedValueOnce(latest);
  const { result } = renderHook(() =>
    useGitReview(session("a"), 1, {
      initialSource: "branch",
      initialBaseRef: "refs/heads/release",
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  await act(async () => {
    await expect(
      result.current.readFile(
        "old-session.txt",
        new AbortController().signal,
        "old",
      ),
    ).rejects.toThrow(i18n.t("gitReviewChanged"));
  });
  expect(read.mock.calls[1]?.[3]).toEqual({
    source: "branch",
    baseRef: "refs/heads/release",
    file: "old-session.txt",
    revision: "old",
  });
  expect(result.current.result).toEqual(latest);
  read
    .mockResolvedValueOnce({ ...latest, summaryRevision: "another-summary" })
    .mockResolvedValueOnce(latest);
  await act(async () => {
    await expect(
      result.current.readFile(
        "old-session.txt",
        new AbortController().signal,
        "latest",
      ),
    ).rejects.toThrow(i18n.t("gitReviewChanged"));
  });
  read.mockResolvedValueOnce({ ...latest, summaryRevision: "latest" });
  await act(async () => {
    expect(
      await result.current.readFile(
        "old-session.txt",
        new AbortController().signal,
        "latest",
      ),
    ).toEqual(latest.snapshot.files[0]);
  });
});

it("requests a versioned next page and rejects changed or late session pages", async () => {
  vi.useFakeTimers();
  const first = {
    ...oldResult,
    snapshot: { ...oldResult.snapshot, nextOffset: 1, totalFiles: 2 },
  };
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ ok: false, reason: "revision_changed" });
  const { result, rerender } = renderHook(
    ({ selected }) => useGitReview(selected, 1),
    { initialProps: { selected: session("a") } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  await act(() => result.current.loadMore());
  expect(result.current.result).toEqual(first);
  expect(result.current.error).toBe(i18n.t("gitReviewChanged"));
  expect(read.mock.calls[1]?.[3]).toEqual({
    source: "unstaged",
    offset: "1",
    revision: "old",
  });
  let finish!: (value: WebGitReviewResult) => void;
  read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ ok: false, reason: "not_git_repository" });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadMore();
  });
  rerender({ selected: session("b") });
  await act(async () => {
    finish(oldResult);
    await pending;
  });
  expect(result.current.result).toBeNull();
});

function session(id: string): WebSessionProjection {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    entries: [],
    bytes: 0,
    truncation: {
      truncated: false,
      maxBytes: 1024,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
    },
  };
}
const oldResult: Extract<WebGitReviewResult, { ok: true }> = {
  ok: true,
  snapshot: {
    repositoryRoot: "/workspace",
    revision: "old",
    comparison: "session",
    currentBranch: "main",
    baseBranch: null,
    additions: 1,
    deletions: 0,
    truncated: false,
    files: [
      {
        path: "old-session.txt",
        status: "untracked",
        additions: 1,
        deletions: 0,
        diff: "+old",
        diffTruncated: false,
      },
    ],
  },
};

it("hides the previous session's files immediately and on a new-session error", async () => {
  vi.useFakeTimers();
  vi.spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValueOnce(oldResult)
    .mockRejectedValueOnce(new Error("new session unavailable"));
  const { result, rerender } = renderHook(
    ({ selected }) => useGitReview(selected, 1),
    { initialProps: { selected: session("a") } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(result.current.result).toEqual(oldResult);
  rerender({ selected: session("b") });
  expect(result.current.result).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(result.current.error).toBe("new session unavailable");
  expect(result.current.result).toBeNull();
});

it("ignores a previous-session response during the next session's debounce window", async () => {
  vi.useFakeTimers();
  let finish!: (value: WebGitReviewResult) => void;
  vi.spyOn(WebClient.prototype, "gitReview").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ selected }) => useGitReview(selected, 1),
    { initialProps: { selected: session("a") } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  rerender({ selected: session("b") });
  await act(async () => finish(oldResult));
  expect(result.current.result).toBeNull();
  expect(result.current.error).toBeNull();
});

it("does not scan hidden Git changes for every running-turn update and refreshes when shown", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValue(oldResult);
  const { rerender } = renderHook(
    ({ key, active }) =>
      useGitReview(session("a"), key, { active, running: true }),
    { initialProps: { key: 1, active: false } },
  );
  for (let key = 2; key < 20; key++) {
    rerender({ key, active: false });
    await act(() => vi.advanceTimersByTimeAsync(300));
  }
  expect(read).not.toHaveBeenCalled();
  rerender({ key: 20, active: true });
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read).toHaveBeenCalledTimes(1);
});

it("does not scan hidden Git changes when a running turn regains window focus", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValue(oldResult);
  const { result } = renderHook(() =>
    useGitReview(session("a"), 1, { active: false, running: true }),
  );
  await act(() => vi.advanceTimersByTimeAsync(300));
  await act(async () => {
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
  });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).not.toHaveBeenCalled();
  await act(() => result.current.refresh());
  expect(read).toHaveBeenCalledTimes(1);
});

it("promotes a deferred background refresh when the Git panel becomes visible", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockResolvedValue(oldResult);
  const { rerender } = renderHook(
    ({ key, active }) =>
      useGitReview(session("a"), key, { active, running: false }),
    { initialProps: { key: 1, active: false } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read).toHaveBeenCalledTimes(1);
  rerender({ key: 2, active: false });
  await act(() => vi.advanceTimersByTimeAsync(100));
  rerender({ key: 2, active: true });
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(read).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(read).toHaveBeenCalledTimes(2);
});

it("lets a slow Git result settle and coalesces repeated refreshes into one follow-up", async () => {
  vi.useFakeTimers();
  let finish!: (value: WebGitReviewResult) => void;
  const read = vi
    .spyOn(WebClient.prototype, "gitReview")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(oldResult);
  const { result, rerender } = renderHook(
    ({ key }) =>
      useGitReview(session("a"), key, { active: true, running: true }),
    { initialProps: { key: 1 } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  const signal = read.mock.calls[0]![2];
  for (let key = 2; key < 20; key++) {
    rerender({ key });
    await act(() => vi.advanceTimersByTimeAsync(100));
  }
  expect(read).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => finish(oldResult));
  expect(result.current.result).toEqual(oldResult);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(read).toHaveBeenCalledTimes(2);
  expect(signal?.aborted).toBe(false);
});
