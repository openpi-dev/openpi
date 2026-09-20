// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WebGitReviewResult,
  WebSessionProjection,
} from "../../web/protocol/types.ts";
import { useGitReview } from "../../web/ui/src/features/review/use-git-review.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
const oldResult: WebGitReviewResult = {
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
