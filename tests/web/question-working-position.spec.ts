// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WebQuestionAnswers,
  WebQuestionReceipt,
  WebQuestionRequest,
} from "../../web/protocol/questions.ts";
import {
  QuestionCard,
  QuestionPanel,
  type QuestionWorkingCache,
} from "../../web/ui/src/features/questions/QuestionPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { questionFixture } from "./question-fixtures.ts";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function request(sessionId = "A", requestId = `question-${sessionId}`) {
  return {
    sessionId,
    requestId,
    toolCallId: `tool-${requestId}`,
    expiresAt: Date.now() + 900_000,
    questions: questionFixture,
  } satisfies WebQuestionRequest;
}

function panel(
  cache: QuestionWorkingCache,
  {
    sessionId = "A",
    sessionPath = "/workspace/a.jsonl",
    surface = "chat",
    revision = 1,
  } = {},
) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      "div",
      { key: surface },
      createElement(QuestionPanel, {
        key: JSON.stringify([sessionId, sessionPath]),
        sessionId,
        sessionPath,
        revision,
        connected: true,
        workingCache: cache,
      }),
    ),
  );
}

function card(
  cache: QuestionWorkingCache,
  current = request(),
  sessionPath = "/workspace/a.jsonl",
  answer = vi.fn(
    async (
      _request: WebQuestionRequest,
      _answers: WebQuestionAnswers | null,
      _signal: AbortSignal,
    ): Promise<WebQuestionReceipt> => ({ state: "answered" }),
  ),
  settled = vi.fn(),
) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(QuestionCard, {
      key: JSON.stringify([current.sessionId, sessionPath, current.requestId]),
      request: current,
      sessionPath,
      workingCache: cache,
      answer,
      onSettled: settled,
    }),
  );
}

function firstAnswer(note = "Keep this answer draft") {
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  fireEvent.click(screen.getByRole("button", { name: "补充说明（选填）" }));
  fireEvent.change(screen.getByRole("textbox", { name: "补充说明（选填）" }), {
    target: { value: note },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
}

function reviewAnswers() {
  firstAnswer();
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "Desktop and mobile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "复核答案" }));
}

it("preserves the same request's review and option notes across settings reparenting", async () => {
  const cache: QuestionWorkingCache = new Map();
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValue({ pending: request() });
  const answer = vi.spyOn(WebClient.prototype, "answerQuestions");
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  reviewAnswers();
  view.rerender(panel(cache, { surface: "settings" }));
  await screen.findByRole("button", { name: "提交答案" });
  expect(screen.getByText("Desktop and mobile")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "修改答案：实现范围" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "补充说明（选填）",
    }).value,
  ).toBe("Keep this answer draft");
  view.rerender(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: /完整交互/ }).checked,
  ).toBe(true);
  expect(answer).not.toHaveBeenCalled();
  expect(pending).toHaveBeenCalledTimes(3);
});

it("keeps independent Session question drafts and restores A after visiting B", async () => {
  const cache: QuestionWorkingCache = new Map();
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockImplementation(
    async (sessionId) => ({ pending: request(sessionId) }),
  );
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  firstAnswer("A note");
  view.rerender(
    panel(cache, { sessionId: "B", sessionPath: "/workspace/b.jsonl" }),
  );
  await screen.findByRole("radio", { name: /完整交互/ });
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: /完整交互/ }).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "B answer" },
  });
  view.rerender(panel(cache));
  await screen.findByRole("heading", {
    name: questionFixture[1]!.question,
  });
  expect(screen.getByText("2 / 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上一步" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "补充说明（选填）",
    }).value,
  ).toBe("A note");
  view.rerender(
    panel(cache, { sessionId: "B", sessionPath: "/workspace/b.jsonl" }),
  );
  expect(
    (
      await screen.findByRole<HTMLTextAreaElement>("textbox", {
        name: "你的答案",
      })
    ).value,
  ).toBe("B answer");
});

it("does not restore a copied Session id at another native path", async () => {
  const cache: QuestionWorkingCache = new Map();
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: request(),
  });
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "Original path answer" },
  });
  view.rerender(panel(cache, { sessionPath: "/workspace/copy.jsonl" }));
  await screen.findByRole("radio", { name: /完整交互/ });
  expect(screen.queryByRole("textbox", { name: "你的答案" })).toBeNull();
  view.rerender(panel(cache));
  expect(
    (
      await screen.findByRole<HTMLTextAreaElement>("textbox", {
        name: "你的答案",
      })
    ).value,
  ).toBe("Original path answer");
});

it("a new canonical request retires the old form and starts without its answers", async () => {
  const cache: QuestionWorkingCache = new Map();
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValue({ pending: request() });
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  firstAnswer();
  pending.mockResolvedValue({ pending: request("A", "successor") });
  view.rerender(panel(cache, { revision: 2 }));
  const choice = await screen.findByRole<HTMLInputElement>("radio", {
    name: /完整交互/,
  });
  expect(choice.checked).toBe(false);
  expect(cache.size).toBe(0);
});

it("restores only the original uncertain submission and can replay it after remount", async () => {
  const cache: QuestionWorkingCache = new Map();
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: request(),
  });
  const answer = vi
    .spyOn(WebClient.prototype, "answerQuestions")
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValue({ state: "answered", replayed: true });
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  reviewAnswers();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
  );
  const original = answer.mock.calls[0]![1];
  view.rerender(panel(cache, { surface: "settings" }));
  await screen.findByRole("button", { name: "核对提交结果" });
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "修改答案：实现范围",
    }).disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("暂时无法确认");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "核对提交结果" })),
  );
  expect(answer.mock.calls[1]![1]).toEqual(original);
  expect(cache.size).toBe(0);
  expect(screen.queryByRole("button", { name: "核对提交结果" })).toBeNull();
});

it("canonical absence retires an uncertain form without inventing an answered receipt", async () => {
  const cache: QuestionWorkingCache = new Map();
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValue({ pending: request() });
  vi.spyOn(WebClient.prototype, "answerQuestions").mockRejectedValue(
    new Error("response lost"),
  );
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  reviewAnswers();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
  );
  pending.mockResolvedValue({ pending: null });
  view.rerender(panel(cache, { revision: 2 }));
  await waitFor(() =>
    expect(view.container.querySelector("section")).toBeNull(),
  );
  expect(cache.size).toBe(0);
  expect(view.container.querySelector(".question-receipt")).toBeNull();
});

it("aborts only the client wait on navigation and prevents a late old receipt replacing a successor", async () => {
  const cache: QuestionWorkingCache = new Map();
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValue({ pending: request() });
  let resolve: ((receipt: WebQuestionReceipt) => void) | undefined;
  const answer = vi
    .spyOn(WebClient.prototype, "answerQuestions")
    .mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  reviewAnswers();
  fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
  const signal = answer.mock.calls[0]![2];
  pending.mockResolvedValue({ pending: request("A", "successor") });
  view.rerender(panel(cache, { surface: "settings" }));
  await screen.findByRole("radio", { name: /完整交互/ });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve?.({ state: "dismissed" }));
  expect(screen.queryByText(i18n.t("questionState_dismissed"))).toBeNull();
  expect(screen.getByRole("radio", { name: /完整交互/ })).toBeTruthy();
});

it("a canonical successor retires an in-flight submission without awaiting its response", async () => {
  const cache: QuestionWorkingCache = new Map();
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValue({ pending: request() });
  let resolve: ((receipt: WebQuestionReceipt) => void) | undefined;
  const answer = vi
    .spyOn(WebClient.prototype, "answerQuestions")
    .mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  reviewAnswers();
  fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
  expect(screen.getByRole("button", { name: "正在提交…" })).toBeTruthy();
  pending.mockResolvedValue({ pending: request("A", "successor") });
  view.rerender(panel(cache, { revision: 2 }));
  await screen.findByRole("radio", { name: /完整交互/ });
  expect(answer.mock.calls[0]![2]?.aborted).toBe(true);
  expect(cache.size).toBe(0);
  await act(async () => resolve?.({ state: "dismissed" }));
  expect(screen.queryByText(i18n.t("questionState_dismissed"))).toBeNull();
  expect(screen.getByRole("radio", { name: /完整交互/ })).toBeTruthy();
});

it.each(["successor", "absent"] as const)(
  "does not let a same-tick old receipt overwrite canonical %s before React commits",
  async (nextState) => {
    const cache: QuestionWorkingCache = new Map();
    let resolveRead:
      | ((result: { pending: WebQuestionRequest | null }) => void)
      | undefined;
    const pending = vi
      .spyOn(WebClient.prototype, "pendingQuestions")
      .mockResolvedValueOnce({ pending: request() })
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveRead = done;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    let resolveAnswer: ((receipt: WebQuestionReceipt) => void) | undefined;
    vi.spyOn(WebClient.prototype, "answerQuestions").mockImplementation(
      () =>
        new Promise((done) => {
          resolveAnswer = done;
        }),
    );
    const view = render(panel(cache));
    await screen.findByRole("radio", { name: /完整交互/ });
    reviewAnswers();
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    view.rerender(panel(cache, { revision: 2 }));
    expect(pending).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveRead?.({
        pending: nextState === "successor" ? request("A", "successor") : null,
      });
      resolveAnswer?.({ state: "dismissed" });
      await Promise.resolve();
    });
    expect(screen.queryByText(i18n.t("questionState_dismissed"))).toBeNull();
    expect(pending).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    if (nextState === "successor") {
      expect(
        screen.getByRole<HTMLInputElement>("radio", { name: /完整交互/ })
          .checked,
      ).toBe(false);
    } else {
      expect(view.container.querySelector(".question-panel")).toBeNull();
    }
  },
);

it("preserves an uncertain dismiss as null rather than converting it to draft answers", async () => {
  const cache: QuestionWorkingCache = new Map();
  const answer = vi
    .fn(
      async (
        _request: WebQuestionRequest,
        _answers: WebQuestionAnswers | null,
        _signal: AbortSignal,
      ): Promise<WebQuestionReceipt> => ({
        state: "dismissed",
        replayed: true,
      }),
    )
    .mockRejectedValueOnce(new Error("response lost"));
  const view = render(card(cache, request(), undefined, answer));
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "关闭提问，不提交答案" }),
    ),
  );
  expect(answer.mock.calls[0]![1]).toBeNull();
  view.unmount();
  render(card(cache, request(), undefined, answer));
  expect(
    screen
      .getByRole<HTMLInputElement>("radio", { name: /完整交互/ })
      .matches(":disabled"),
  ).toBe(true);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "核对提交结果" })),
  );
  expect(answer.mock.calls[1]![1]).toBeNull();
  expect(cache.size).toBe(0);
});

it("rejects a same-tick duplicate submission before a second transport starts", async () => {
  const cache: QuestionWorkingCache = new Map();
  let resolve: ((receipt: WebQuestionReceipt) => void) | undefined;
  const answer = vi.fn(
    async (
      _request: WebQuestionRequest,
      _answers: WebQuestionAnswers | null,
      _signal: AbortSignal,
    ): Promise<WebQuestionReceipt> =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(card(cache, request(), undefined, answer));
  reviewAnswers();
  const submit = screen.getByRole("button", { name: "提交答案" });
  act(() => {
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(answer).toHaveBeenCalledOnce();
  await act(async () => resolve?.({ state: "answered" }));
});

it("does not let an aborted pending read retire a newer owner's work", async () => {
  const cache: QuestionWorkingCache = new Map();
  let resolveOld:
    | ((value: { pending: WebQuestionRequest | null }) => void)
    | undefined;
  const pending = vi
    .spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValueOnce({ pending: request() })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    )
    .mockResolvedValue({ pending: request("B") });
  const view = render(panel(cache));
  await screen.findByRole("radio", { name: /完整交互/ });
  firstAnswer("A note");
  view.rerender(panel(cache, { revision: 2 }));
  view.rerender(
    panel(cache, { sessionId: "B", sessionPath: "/workspace/b.jsonl" }),
  );
  await screen.findByRole("radio", { name: /完整交互/ });
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "B note" },
  });
  await act(async () => resolveOld?.({ pending: null }));
  expect(pending.mock.calls[1]![1]?.aborted).toBe(true);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "你的答案" })
      .value,
  ).toBe("B note");
  expect(cache.size).toBe(2);
});

it("validates only selected answer text, retaining an oversized inactive custom draft", () => {
  const cache: QuestionWorkingCache = new Map();
  const view = render(card(cache));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "中".repeat(2667) },
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "下一题" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "下一题" }).disabled,
  ).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  render(card(cache));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "你的答案" })
      .value,
  ).toBe("中".repeat(2667));
});

it("retains unselected option notes without letting their limit block a different choice", () => {
  const cache: QuestionWorkingCache = new Map();
  render(card(cache));
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  fireEvent.click(screen.getByRole("button", { name: "补充说明（选填）" }));
  fireEvent.change(screen.getByRole("textbox", { name: "补充说明（选填）" }), {
    target: { value: "n".repeat(8001) },
  });
  const radios = screen.getAllByRole<HTMLInputElement>("radio");
  fireEvent.click(radios[1]!);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "下一题" }).disabled,
  ).toBe(false);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "补充说明（选填）",
    }).value,
  ).toBe("");
  fireEvent.click(radios[0]!);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "补充说明（选填）",
    }).value,
  ).toBe("n".repeat(8001));
});

it("rejects new bytes at the shared memory limit, keeps old text, and always permits shrinking", () => {
  const cache: QuestionWorkingCache = new Map();
  const half = "x".repeat(512 * 1024);
  const view = render(card(cache));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: half },
  });
  view.rerender(card(cache, request("B"), "/workspace/b.jsonl"));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "你的答案",
  });
  fireEvent.change(input, { target: { value: half } });
  fireEvent.change(input, { target: { value: `${half}y` } });
  expect(input.value).toBe(half);
  expect(
    screen.getAllByRole("alert").map((node) => node.textContent),
  ).toContain(i18n.t("questionDraftLimit"));
  fireEvent.change(input, { target: { value: "shortened" } });
  expect(input.value).toBe("shortened");
  view.rerender(card(cache));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "你的答案" })
      .value,
  ).toBe(half);
  expect(cache.size).toBe(2);
});

it("counts the cache's draft bytes as UTF-8 and leaves an oversized replacement intact", () => {
  const cache: QuestionWorkingCache = new Map();
  const view = render(card(cache));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "你的答案",
  });
  const exact = `${"中".repeat(349525)}x`;
  fireEvent.change(input, { target: { value: exact } });
  expect(input.value).toBe(exact);
  fireEvent.change(input, { target: { value: `${exact}中` } });
  expect(input.value).toBe(exact);
  view.unmount();
  render(card(cache));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "你的答案" })
      .value,
  ).toBe(exact);
});

it("rejects a 33rd nonempty request draft without evicting the existing 32", () => {
  const cache: QuestionWorkingCache = new Map();
  const view = render(card(cache, request("0"), "/workspace/0.jsonl"));
  for (let index = 0; index < 32; index++) {
    view.rerender(
      card(cache, request(String(index)), `/workspace/${index}.jsonl`),
    );
    fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  }
  expect(cache.size).toBe(32);
  const blockedAnswer = vi.fn(
    async (
      _request: WebQuestionRequest,
      _answers: WebQuestionAnswers | null,
      _signal: AbortSignal,
    ): Promise<WebQuestionReceipt> => ({ state: "dismissed" }),
  );
  view.rerender(
    card(cache, request("33"), "/workspace/33.jsonl", blockedAnswer),
  );
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("questionDraftLimit"),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭提问，不提交答案" }));
  expect(blockedAnswer).not.toHaveBeenCalled();
  expect(cache.size).toBe(32);
  view.rerender(card(cache, request("0"), "/workspace/0.jsonl"));
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: /完整交互/ }).checked,
  ).toBe(true);
});
