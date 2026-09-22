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
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const detail = (id: string): WebSubagentDetail => ({
  kind: "subagents",
  id,
  title: `Conversation ${id}`,
  status: "done",
  origin: "btw",
  createdAt: 1,
  cwd: "/workspace",
  prompt: `Question ${id}`,
  transcript: [],
  liveTools: [],
  finalText: `Response ${id}`,
  truncated: false,
  omittedEntries: 0,
});
function panel() {
  vi.spyOn(WebClient.prototype, "subagentDetail").mockImplementation(
    async (_session, id) => ({ sessionId: "session-a", detail: detail(id) }),
  );
  return render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "side-conversation",
        requestRevision: 0,
        sessionId: "session-a",
        cwd: "/workspace",
        capabilities: {
          subagents: {
            items: [detail("A"), detail("B")],
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
}
function choose(id: string) {
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`Conversation ${id}`) }),
  );
}
function back() {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("backToSideConversations") }),
  );
}
const input = () =>
  screen.getByPlaceholderText<HTMLTextAreaElement>(
    i18n.t("continueSideConversation"),
  );

it("keeps the user's navigation when an earlier send returns without cancelling the background task", async () => {
  let finish!: (value: {
    sessionId: string;
    detail: WebSubagentDetail;
  }) => void;
  const send = vi
    .spyOn(WebClient.prototype, "subagentAction")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  panel();
  choose("B");
  fireEvent.change(input(), { target: { value: "Retained draft B" } });
  back();
  choose("A");
  fireEvent.change(input(), { target: { value: "Follow up A" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  back();
  choose("B");
  expect(send.mock.calls[0]![2]?.aborted).toBe(false);
  await act(async () =>
    finish({ sessionId: "session-a", detail: detail("A") }),
  );
  expect(screen.getByText("Question B")).toBeTruthy();
  expect(screen.queryByText("Question A")).toBeNull();
  expect(input().value).toBe("Retained draft B");
  expect(send).toHaveBeenCalledOnce();
  back();
  choose("A");
  expect(input().value).toBe("");
});

it("keeps unsent drafts attached to their side conversation", async () => {
  panel();
  choose("A");
  fireEvent.change(input(), { target: { value: "Draft A" } });
  back();
  choose("B");
  expect(input().value).toBe("");
  fireEvent.change(input(), { target: { value: "Draft B" } });
  back();
  choose("A");
  expect(input().value).toBe("Draft A");
  back();
  choose("B");
  expect(input().value).toBe("Draft B");
});
