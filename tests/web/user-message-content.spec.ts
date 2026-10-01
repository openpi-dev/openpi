// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { formatSourceReference } from "../../web/protocol/session-sources.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { FullMessageText } from "../../web/ui/src/features/transcript/FullMessageText.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { UserMessageContent } from "../../web/ui/src/features/transcript/UserMessageContent.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { copyText } from "../../web/ui/src/lib/clipboard.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

vi.mock("../../web/ui/src/lib/clipboard.ts", () => ({
  copyText: vi.fn(async () => true),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const path = `/private/会话 100% [1]/${"a".repeat(64)}/中文 文档 [2].txt`;
const link = formatSourceReference(path, path);
const canonical = `第一行\n  第二行\n\n${link}\n\n最后一行\n`;

function withI18n(element: ReturnType<typeof createElement>) {
  return createElement(I18nextProvider, { i18n }, element);
}

function contentView(content: string, incomplete = false, open = vi.fn()) {
  return withI18n(
    createElement(
      ArtifactContext.Provider,
      { value: { open, parent: "parent.md" } },
      createElement(UserMessageContent, { content, incomplete }),
    ),
  );
}

it("preserves every caption character and discloses an accurate path only on demand", () => {
  const open = vi.fn();
  const { container } = render(contentView(canonical, false, open));
  const body = container.querySelector(".message-body")!;
  expect(body.textContent).toBe(
    `第一行\n  第二行\n\n中文 文档 [2].txt\n\n最后一行\n`,
  );
  expect(container.querySelector(".user-file-reference-path")).toBeNull();
  const file = screen.getByRole("button", { name: "中文 文档 [2].txt" });
  fireEvent.click(file);
  expect(open).toHaveBeenCalledWith(encodeURI(path), "parent.md", file);
  const details = screen.getByRole("button", {
    name: `${i18n.t("artifactFileDetails")} 中文 文档 [2].txt`,
  });
  fireEvent.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
  expect(
    container.querySelector(".user-file-reference-path")?.textContent,
  ).toBe(path);
  fireEvent.click(details);
  expect(container.querySelector(".user-file-reference-path")).toBeNull();
});

it.each([
  "普通文本 /private/file.txt\n[remote](<https://example.com/file.txt>)",
  "`[inline code](<file.txt>)`",
  "```md\n[fenced](<file.txt>)\n```\n",
  "    [indented](<file.txt>)\n",
  "\\[escaped](<file.txt>)",
  "![image](<file.txt>)",
  "[ordinary](file.txt)",
  "[broken](<file.txt>",
])("keeps ordinary prose, code and non-source links literal: %s", (content) => {
  const { container } = render(contentView(content));
  expect(container.querySelector(".message-body")?.textContent).toBe(content);
  expect(container.querySelector(".user-file-reference")).toBeNull();
});

it("retains a custom label verbatim and does not turn a quoted path into a filename", () => {
  const label = `我的自定义名字 ${"长".repeat(300)}`;
  const { container } = render(contentView(formatSourceReference(path, label)));
  expect(screen.getByRole("button", { name: label }).textContent).toBe(label);
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("artifactFileDetails")} ${label}`,
    }),
  );
  expect(
    container.querySelector(".user-file-reference-path")?.textContent,
  ).toBe(path);
});

it("keeps malformed percent escapes literal for inspection", () => {
  const { container } = render(contentView("[Literal](<file%ZZ.txt>)"));
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("artifactFileDetails")} Literal`,
    }),
  );
  expect(
    container.querySelector(".user-file-reference-path")?.textContent,
  ).toBe("file%ZZ.txt");
});

it("preserves an expanded reference through unrelated transcript rerenders", () => {
  const { container, rerender } = render(contentView(canonical));
  const name = `${i18n.t("artifactFileDetails")} 中文 文档 [2].txt`;
  fireEvent.click(screen.getByRole("button", { name }));
  expect(
    container.querySelector(".user-file-reference-path")?.textContent,
  ).toBe(path);
  rerender(contentView(canonical));
  expect(
    screen.getByRole("button", { name }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    container.querySelector(".user-file-reference-path")?.textContent,
  ).toBe(path);
  fireEvent.click(screen.getByRole("button", { name }));
  expect(container.querySelector(".user-file-reference-path")).toBeNull();
});

it("leaves an incomplete native text preview entirely literal", () => {
  const { container, rerender } = render(contentView(canonical, true));
  expect(container.querySelector(".message-body")?.textContent).toBe(canonical);
  expect(container.querySelector(".user-file-reference")).toBeNull();
  rerender(contentView(canonical));
  expect(
    screen.getByRole("button", { name: "中文 文档 [2].txt" }),
  ).toBeTruthy();
});

it("does not replace references in code when a real reference exists alongside it", () => {
  const content = [
    " ",
    link,
    "`[example](<fake.txt>)`",
    "",
    "```md",
    "[code](<fake2.txt>)",
    "```",
    formatSourceReference("real.txt"),
    "",
  ].join("\n");
  const { container } = render(contentView(content));
  expect(container.querySelectorAll(".user-file-reference")).toHaveLength(2);
  expect(container.querySelector(".message-body")?.textContent).toBe(
    content
      .replace(link, "中文 文档 [2].txt")
      .replace(formatSourceReference("real.txt"), "real.txt"),
  );
});

it("hydrates user text in full before projecting links, retaining the reading focus", async () => {
  const half = canonical.indexOf("最后");
  vi.spyOn(WebClient.prototype, "sessionItem")
    .mockResolvedValueOnce({
      entryId: "prompt",
      text: canonical.slice(0, half),
      nextCursor: half,
      totalChars: canonical.length,
    })
    .mockResolvedValueOnce({
      entryId: "prompt",
      text: canonical.slice(half),
      nextCursor: null,
      totalChars: canonical.length,
    });
  const { container } = render(
    withI18n(
      createElement(FullMessageText, {
        preview: link,
        sessionId: "session",
        sessionPath: "/tmp/session",
        entryId: "prompt",
        markdown: false,
      }),
    ),
  );
  expect(container.querySelector(".user-file-reference")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Load full message" })),
  );
  expect(container.querySelector(".message-body")?.textContent).toBe(
    canonical.slice(0, half),
  );
  expect(container.querySelector(".user-file-reference")).toBeNull();
  const more = screen.getByRole("button", { name: "Load more" });
  more.focus();
  await act(async () => fireEvent.click(more));
  expect(
    screen.getByRole("button", { name: "中文 文档 [2].txt" }),
  ).toBeTruthy();
  expect(document.activeElement?.classList.contains("message-full-text")).toBe(
    true,
  );
});

it("copies and edits canonical native text after rendering compact references", async () => {
  const snapshot: WebSnapshot = {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-10-01T00:00:00Z",
    cursor: 1,
    currentSessionId: "session",
    currentSessionPath: "/tmp/session",
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
    },
    selectedSession: {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      bytes: 1,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2 * 1024 * 1024,
      },
      entries: [
        {
          id: "prompt",
          type: "message",
          timestamp: "2026-10-01T00:00:00Z",
          message: { role: "user", content: canonical },
        },
      ],
    },
  };
  const { container } = render(
    withI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    ),
  );
  const question = container.querySelector<HTMLElement>(".message-row.user")!;
  expect(
    within(question).getByRole("button", { name: "中文 文档 [2].txt" }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(
      within(question).getByRole("button", { name: "Copy message" }),
    ),
  );
  expect(copyText).toHaveBeenCalledWith(canonical);
  fireEvent.click(
    within(question).getByRole("button", { name: "Revise and resend" }),
  );
  expect(
    within(question).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Revise and resend",
    }).value,
  ).toBe(canonical);
  expect(snapshot.selectedSession?.entries[0]?.message?.content).toBe(
    canonical,
  );
});
