// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

const parsing = vi.hoisted(() => ({ inputs: [] as string[] }));
vi.mock("react-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-markdown")>();
  return {
    ...original,
    default(props: ComponentProps<typeof original.default>) {
      parsing.inputs.push(props.children ?? "");
      return createElement(original.default, props);
    },
  };
});
afterEach(() => {
  cleanup();
  parsing.inputs.length = 0;
});

it("scrolls overflowing code blocks with deterministic arrow-key controls", () => {
  const { container } = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        Markdown,
        null,
        `\`\`\`ts\nconst value = "${"wide-".repeat(40)}";\n\`\`\``,
      ),
    ),
  );
  const scroll = container.querySelector<HTMLElement>(".markdown-code-scroll");
  expect(scroll).toBeTruthy();
  Object.defineProperties(scroll!, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 300 },
    scrollLeft: { configurable: true, value: 0, writable: true },
  });

  fireEvent.keyDown(scroll!, { key: "ArrowRight" });
  expect(scroll!.scrollLeft).toBe(40);
  fireEvent.keyDown(scroll!, { key: "ArrowLeft" });
  expect(scroll!.scrollLeft).toBe(0);
});

it("keeps code-copy feedback across artifact context refreshes", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const renderMarkdown = (parent: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        ArtifactContext.Provider,
        { value: { open: vi.fn(), parent } },
        createElement(Markdown, null, "```ts\nconst value = 42;\n```"),
      ),
    );
  const view = render(renderMarkdown("first.ts"));

  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") })),
  );
  expect(writeText).toHaveBeenCalledWith("const value = 42;\n");
  expect(
    screen.getByRole("button", { name: i18n.t("copiedCode") }),
  ).toBeTruthy();

  view.rerender(renderMarkdown("second.ts"));
  expect(
    screen.getByRole("button", { name: i18n.t("copiedCode") }),
  ).toBeTruthy();
});

it("parses changed text without reparsing mounted history during streaming or snapshot refresh", () => {
  const history = Array.from(
    { length: 24 },
    (_, index) => `History ${index}\n\n**Verified**\n\n- [x] complete`,
  );
  const snapshot: WebSnapshot = {
    protocolVersion: 1,
    generatedAt: "2026-09-07T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: "current",
    workspaces: [],
    sessions: [],
    models: [],
    selectedSession: {
      id: "current",
      path: "/tmp/current.jsonl",
      cwd: "/tmp",
      entries: history.map((content, index) => ({
        id: `history-${index}`,
        timestamp: "2026-09-07T00:00:00Z",
        type: "message",
        message: { role: "assistant", content },
      })),
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    runtime: { status: "running", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 4194304,
      bytes: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
    },
  };
  const props = {
    liveRunning: true,
    livePhase: "running" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
    scrollToBottom: 0,
    onResend: async () => true,
  };
  const node = (content: string, current = snapshot) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        ...props,
        snapshot: current,
        liveMessages: [
          { key: "stream", message: { role: "assistant", content } },
        ],
      }),
    );
  const { container, rerender, unmount } = render(node("Live 0"));
  const initialHistoryParses = parsing.inputs.filter((text) =>
    history.includes(text),
  ).length;
  expect(initialHistoryParses).toBe(history.length);
  for (let chunk = 1; chunk <= 8; chunk++) rerender(node(`Live ${chunk}`));
  expect(container.textContent).toContain("Live 8");
  expect(
    parsing.inputs.filter((text) => text.startsWith("Live ")),
  ).toHaveLength(9);
  expect(parsing.inputs.filter((text) => history.includes(text))).toHaveLength(
    initialHistoryParses,
  );

  const refreshed = structuredClone(snapshot);
  const beforeRefresh = parsing.inputs.length;
  rerender(node("Live 8", refreshed));
  expect(parsing.inputs).toHaveLength(beforeRefresh);

  refreshed.selectedSession!.entries[0].message!.content =
    "Corrected **historical evidence**";
  rerender(node("Live 8", structuredClone(refreshed)));
  expect(parsing.inputs).toHaveLength(beforeRefresh + 1);
  expect(container.querySelector("strong")?.textContent).toBe(
    "historical evidence",
  );

  const other = structuredClone(snapshot);
  other.currentSessionId = "other";
  other.selectedSession!.id = "other";
  other.selectedSession!.path = "/tmp/other.jsonl";
  other.selectedSession!.entries[0].message!.content =
    "Other Session **evidence**";
  rerender(node("Other live", other));
  expect(container.textContent).toContain("Other Session evidence");
  expect(container.textContent).not.toContain("Corrected historical evidence");

  unmount();
  const beforeRemount = parsing.inputs.length;
  render(node("Live 0"));
  expect(parsing.inputs.length - beforeRemount).toBe(history.length + 1);
});
