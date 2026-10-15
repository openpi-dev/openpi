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
import { afterAll, beforeAll, afterEach, expect, it, vi } from "vitest";
import { TerminalHistory } from "../../web/ui/src/features/sessions/TerminalHistory.tsx";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";
installCheckVisibilityFixture();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const row = (cwd: string) => ({
  id: cwd,
  path: `${cwd}/terminal.jsonl`,
  cwd,
  name: `${cwd} native`,
  modified: "2026-01-01",
  created: "2026-01-01",
  messageCount: 1,
  metadataPartial: false,
  firstMessage: "proof",
  source: "pi-default" as const,
  origin: "terminal" as const,
  readOnly: true as const,
});
const page = (cwd: string) => ({
  sessions: [row(cwd)],
  cursor: 0,
  total: 1,
  partial: false,
});
it("passes explicit workspace for list/detail and exposes read-only text only", async () => {
  await i18n.changeLanguage("en");
  const list = vi
    .spyOn(WebClient.prototype, "terminalSessions")
    .mockResolvedValue(page("/B"));
  const detail = vi
    .spyOn(WebClient.prototype, "terminalSession")
    .mockResolvedValue({
      ...row("/B"),
      preview: {
        messages: [{ role: "user", content: "private native text" }],
        totalMessages: 1,
        bytesRead: 10,
        retainedBytes: 10,
        truncatedBytes: 0,
      },
    });
  render(
    createElement(TerminalHistory, {
      open: true,
      workspace: "/B",
      onClose() {},
    }),
  );
  fireEvent.click(await screen.findByText("/B native", { exact: false }));
  await screen.findByText("user: private native text");
  expect(list).toHaveBeenCalledWith("/B", "", 0, expect.any(AbortSignal));
  expect(detail).toHaveBeenCalledWith(
    "/B",
    "/B/terminal.jsonl",
    expect.any(AbortSignal),
  );
  expect(
    screen.queryByRole("button", { name: /fork|restore|delete|send/i }),
  ).toBeNull();
});
it("aborts and ignores an old workspace response", async () => {
  await i18n.changeLanguage("en");
  let resolveA!: (value: ReturnType<typeof page>) => void;
  const list = vi
    .spyOn(WebClient.prototype, "terminalSessions")
    .mockImplementation((workspace) =>
      workspace === "/A"
        ? new Promise((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve(page(workspace)),
    );
  const props = { open: true, workspace: "/A", onClose() {} };
  const view = render(createElement(TerminalHistory, props));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  const signal = list.mock.calls[0]![3]!;
  view.rerender(createElement(TerminalHistory, { ...props, workspace: "/B" }));
  await screen.findByText("/B native", { exact: false });
  await act(async () => resolveA(page("/A")));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText("/A native", { exact: false })).toBeNull();
});
it("rejects cross-workspace rows before displaying them", async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(WebClient.prototype, "terminalSessions").mockResolvedValue(
    page("/A"),
  );
  render(
    createElement(TerminalHistory, {
      open: true,
      workspace: "/B",
      onClose() {},
    }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("/A native", { exact: false })).toBeNull();
});

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
