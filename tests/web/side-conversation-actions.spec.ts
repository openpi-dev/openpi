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
import { afterEach, expect, it, vi } from "vitest";
import type { WebSubagentDetail } from "../../extensions/shared/web-observer-registry.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const detail: WebSubagentDetail = {
  kind: "subagents",
  id: "A",
  title: "Conversation A",
  status: "done",
  origin: "btw",
  createdAt: 1,
  cwd: "/workspace",
  prompt: "Question A",
  transcript: [
    {
      kind: "assistant",
      parts: [{ type: "thinking", text: "Child thinking" }],
    },
  ],
  liveTools: [],
  finalText: "",
  truncated: false,
  omittedEntries: 0,
};

function panel(running = false) {
  const read = vi
    .spyOn(WebClient.prototype, "subagentDetail")
    .mockResolvedValue({ sessionId: "parent", detail });
  const view = render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "side-conversation",
        requestRevision: 0,
        sessionId: "parent",
        cwd: "/workspace",
        capabilities: {
          subagents: {
            items: [{ ...detail, status: running ? "running" : "done" }],
            truncated: false,
            omitted: 0,
          },
        },
        messages: [],
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onBeforeArtifactOpen: () => {},
        onClose: () => {},
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Conversation A/u }));
  const input = screen.getByPlaceholderText<HTMLTextAreaElement>(
    i18n.t("continueSideConversation"),
  );
  fireEvent.change(input, { target: { value: "Follow up A" } });
  return { ...view, read, input, form: input.form! };
}

it.each(["send", "stop"] as const)(
  "admits only the first native %s action in one event cycle without aborting it",
  async (first) => {
    const action = vi
      .spyOn(WebClient.prototype, "subagentAction")
      .mockImplementation(() => new Promise(() => {}));
    const { form } = panel(true);
    const stop = screen.getByRole("button", { name: i18n.t("stop") });

    act(() => {
      if (first === "stop") fireEvent.click(stop);
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.click(stop);
    });

    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0]![1].action).toBe(
      first === "send" ? "send-btw" : "cancel-btw",
    );
    expect(action.mock.calls[0]![2]!.aborted).toBe(false);
  },
);

it("retains the failed payload and releases the native action lock for an explicit retry", async () => {
  const action = vi
    .spyOn(WebClient.prototype, "subagentAction")
    .mockRejectedValueOnce(new Error("Action failed"))
    .mockImplementation(() => new Promise(() => {}));
  const { form, input } = panel();
  fireEvent.submit(form);
  await screen.findByText("Action failed");
  expect(input.value).toBe("Follow up A");
  expect(input.disabled).toBe(false);

  fireEvent.submit(form);
  expect(action).toHaveBeenCalledTimes(2);
  expect(action.mock.calls[1]![1]).toEqual({
    kind: "subagents",
    action: "send-btw",
    id: "A",
    text: "Follow up A",
  });
});

it.each([
  { shiftKey: true },
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { isComposing: true },
  { keyCode: 229 },
])("leaves modified or composing Enter to the editor: %j", (keyboard) => {
  const action = vi.spyOn(WebClient.prototype, "subagentAction");
  const { input } = panel();

  expect(fireEvent.keyDown(input, { key: "Enter", ...keyboard })).toBe(true);
  expect(action).not.toHaveBeenCalled();
  expect(input.value).toBe("Follow up A");
});

it("submits ordinary Enter once through the native action", () => {
  const action = vi
    .spyOn(WebClient.prototype, "subagentAction")
    .mockImplementation(() => new Promise(() => {}));
  const { input } = panel();

  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  expect(action).toHaveBeenCalledOnce();
});

it("preserves the displayed child while refreshing after a successful send", async () => {
  const action = vi
    .spyOn(WebClient.prototype, "subagentAction")
    .mockResolvedValue({ sessionId: "parent", detail });
  const { container, form, read, input } = panel();
  await screen.findByText("Child thinking");
  const thinking =
    container.querySelector<HTMLDetailsElement>(".subagent-thinking")!;
  thinking.open = true;
  const viewport = container.querySelector<HTMLElement>(
    ".subagent-transcript",
  )!;
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 },
  });
  viewport.scrollTop = 150;
  fireEvent.scroll(viewport);

  fireEvent.submit(form);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(action).toHaveBeenCalledOnce();
  expect(input.value).toBe("");
  expect(container.querySelector(".subagent-thinking")).toBe(thinking);
  expect(thinking.open).toBe(true);
  expect(container.querySelector(".subagent-transcript")).toBe(viewport);
  expect(viewport.scrollTop).toBe(150);
});
