// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupQuestions } from "../../extensions/shared/web-cleanup-confirmation.ts";
import { QuestionPanel } from "../../web/ui/src/features/questions/QuestionPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const target = { workspace: "/workspace", paths: ["keep.txt"] };
const request = {
  requestId: "request",
  sessionId: "session",
  toolCallId: "tool",
  expiresAt: Date.now() + 900000,
  questions: cleanupQuestions(target),
  cleanup: target,
};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it("lost approval response and pending disappearance recover the original exact receipt", async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(WebClient.prototype, "pendingQuestions")
    .mockResolvedValueOnce({ pending: request })
    .mockResolvedValue({ pending: null });
  vi.spyOn(WebClient.prototype, "answerQuestions").mockRejectedValue(
    new Error("response lost"),
  );
  const read = vi
    .spyOn(WebClient.prototype, "questionReceipt")
    .mockResolvedValue({
      receipt: {
        state: "answered",
        cleanupDecision: "approved",
        cleanupTarget: target,
        replayed: true,
      },
    });
  const view = render(
    createElement(QuestionPanel, {
      sessionId: "session",
      revision: 1,
      connected: true,
    }),
  );
  fireEvent.click(
    await screen.findByRole("radio", { name: /Approve exact deletion/ }),
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText("Or write your own reply")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review answers" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
  await screen.findByRole("alert");
  view.rerender(
    createElement(QuestionPanel, {
      sessionId: "session",
      revision: 2,
      connected: true,
    }),
  );
  await screen.findByText(/Deletion approved for the listed targets/);
  expect(read).toHaveBeenCalledWith(
    "session",
    "request",
    expect.any(AbortSignal),
  );
  expect(screen.getByText(/keep.txt/)).toBeTruthy();
  expect(WebClient.prototype.answerQuestions).toHaveBeenCalledTimes(1);
});

it("reload recovers only stored IDs and an evicted receipt is uncertain, never denied", async () => {
  await i18n.changeLanguage("en");
  sessionStorage.setItem("openpi:cleanup-receipt:session", "request");
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: null,
  });
  vi.spyOn(WebClient.prototype, "questionReceipt").mockResolvedValue({
    receipt: null,
  });
  const answer = vi.spyOn(WebClient.prototype, "answerQuestions");
  render(
    createElement(QuestionPanel, {
      sessionId: "session",
      revision: 1,
      connected: true,
    }),
  );
  await screen.findByText(/original deletion decision could not be verified/);
  expect(answer).not.toHaveBeenCalled();
  expect(JSON.stringify(sessionStorage)).not.toContain("keep.txt");
});

it("Escape dismisses cleanup once and repeated submission cannot widen its decision", async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: request,
  });
  const answer = vi
    .spyOn(WebClient.prototype, "answerQuestions")
    .mockImplementation(() => new Promise(() => {}));
  render(
    createElement(QuestionPanel, {
      sessionId: "session",
      revision: 1,
      connected: true,
    }),
  );
  const radio = await screen.findByRole("radio", {
    name: /Approve exact deletion/,
  });
  fireEvent.keyDown(radio, { key: "Escape" });
  fireEvent.keyDown(radio, { key: "Escape" });
  expect(answer).toHaveBeenCalledTimes(1);
  expect(answer.mock.calls[0]?.[1]).toBeNull();
});
