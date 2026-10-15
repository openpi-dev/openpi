// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  QuestionCard,
  QuestionPanel,
} from "../../web/ui/src/features/questions/QuestionPanel.tsx";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import type {
  WebQuestionRequest,
  WebQuestionReceipt,
  WebQuestionAnswers,
} from "../../web/protocol/questions.ts";
import { questionFixture } from "./question-fixtures.ts";

beforeEach(async () => {
  await i18n.changeLanguage("zh");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const request: WebQuestionRequest = {
  requestId: "request",
  sessionId: "session",
  toolCallId: "tool",
  expiresAt: Date.now() + 900000,
  questions: questionFixture,
};
function setup(
  answer = vi.fn(
    async (
      _request: WebQuestionRequest,
      _answers: WebQuestionAnswers | null,
      _signal: AbortSignal,
    ): Promise<WebQuestionReceipt> => ({ state: "answered" }),
  ),
) {
  const settled = vi.fn();
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(QuestionCard, { request, answer, onSettled: settled }),
    ),
  );
  return { answer, settled, view };
}
function chooseFirst() {
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "补充说明（选填）" }));
  fireEvent.change(screen.getByRole("textbox", { name: "补充说明（选填）" }), {
    target: { value: "保持现有主题" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "你的答案" }), {
    target: { value: "桌面与手机" },
  });
  fireEvent.click(screen.getByRole("button", { name: "复核答案" }));
}

it.each(["answered", "dismissed"] as const)(
  "settles the panel without a success banner, retaining non-success feedback (%s)",
  async (state) => {
    vi.spyOn(WebClient.prototype, "pendingQuestions")
      .mockResolvedValueOnce({ pending: request })
      .mockResolvedValue({ pending: null });
    vi.spyOn(WebClient.prototype, "answerQuestions").mockResolvedValue({
      state,
    });
    const view = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(QuestionPanel, {
          sessionId: "session",
          revision: 1,
          connected: true,
        }),
      ),
    );
    await screen.findByRole("radio", { name: /完整交互/ });
    chooseFirst();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
    );
    expect(screen.queryByText("答案已提交，助手可以继续了。")).toBeNull();
    expect(view.container.querySelector(".question-card")).toBeNull();
    expect(Boolean(view.container.querySelector(".question-receipt"))).toBe(
      state !== "answered",
    );
  },
);

it("keeps choices as drafts, permits revision and submits only from explicit review", async () => {
  const { answer, settled } = setup();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "下一题" }).disabled,
  ).toBe(true);
  chooseFirst();
  expect(answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "修改答案：实现范围" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "补充说明（选填）",
    }).value,
  ).toBe("保持现有主题");
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "你的答案" })
      .value,
  ).toBe("桌面与手机");
  fireEvent.click(screen.getByRole("button", { name: "复核答案" }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
  );
  expect(answer).toHaveBeenCalledOnce();
  expect(answer.mock.calls[0]![1]).toEqual([
    {
      id: "scope",
      selected: questionFixture[0]!.options[0]!.label,
      note: "保持现有主题",
    },
    { id: "validation", custom: "桌面与手机" },
  ]);
  expect(settled).toHaveBeenCalledWith({ state: "answered" });
});

it("dismisses without leaking draft answers", async () => {
  const { answer } = setup();
  fireEvent.click(screen.getByRole("radio", { name: /完整交互/ }));
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "关闭提问，不提交答案" }),
    ),
  );
  expect(answer.mock.calls[0]![1]).toBeNull();
});

it("locks uncertain submissions and retries the original payload", async () => {
  const answer = vi.fn(
    async (
      _request: WebQuestionRequest,
      _answers: WebQuestionAnswers | null,
      _signal: AbortSignal,
    ): Promise<WebQuestionReceipt> => ({ state: "answered", replayed: true }),
  );
  answer.mockRejectedValueOnce(new Error("response lost"));
  const { settled } = setup(answer);
  chooseFirst();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("暂时无法确认");
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "修改答案：实现范围",
    }).disabled,
  ).toBe(true);
  expect(settled).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "核对提交结果" })),
  );
  expect(answer.mock.calls[1]![1]).toEqual(answer.mock.calls[0]![1]);
  expect(settled).toHaveBeenCalledWith({ state: "answered", replayed: true });
});

it("rejects oversized UTF-8 drafts without discarding text", () => {
  setup();
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "你的答案",
  });
  fireEvent.change(input, { target: { value: "中".repeat(2667) } });
  expect(input.value.length).toBe(2667);
  expect(screen.getByRole("alert").textContent).toContain("8000");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "下一题" }).disabled,
  ).toBe(true);
});

it("blank custom answers explicitly request rephrasing", async () => {
  const { answer } = setup();
  fireEvent.click(screen.getByRole("radio", { name: /或自行撰写回复/ }));
  fireEvent.click(screen.getByRole("button", { name: "下一题" }));
  fireEvent.click(screen.getByRole("radio", { name: /自动测试与浏览器验收/ }));
  fireEvent.click(screen.getByRole("button", { name: "复核答案" }));
  expect(screen.getByText("请助手把问题说清楚或拆小")).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "提交答案" })),
  );
  expect(answer.mock.calls[0]![1]?.[0]).toEqual({
    id: "scope",
    rephrase: true,
  });
});
