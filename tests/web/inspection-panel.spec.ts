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
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  InspectionPanel,
  type InspectionTarget,
} from "../../web/ui/src/features/inspection/InspectionPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

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

const target: InspectionTarget = {
  sessionId: "session-a",
  sessionPath: "/ws/a.jsonl",
  cwd: "/ws",
  model: "Example",
};
function show(value = target) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(InspectionPanel, { target: value, onClose: vi.fn() }),
    ),
  );
}
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows independent status failures without claiming that configured credentials were tested", async () => {
  const fetcher = vi.fn(async (url: string) => {
    expect(url).toContain("sessionId=session-a");
    if (url.startsWith("/api/thinking"))
      return reply({ error: "unavailable" }, 501);
    if (url.startsWith("/api/trust"))
      return reply({
        workspace: "/ws",
        state: "restricted",
        refreshRequired: false,
      });
    return reply({
      providers: [
        { id: "example", name: "Example provider", configured: true },
      ],
      truncation: { truncated: false },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  show();
  expect(
    await screen.findByText("Thinking state is unavailable."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Project resources are restricted pending a trust decision.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Configured")).toBeTruthy();
  expect(
    screen.getByText(
      "Configured credentials do not guarantee a successful model request.",
    ),
  ).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
});

it("aborts closed-panel reads and ignores late old-session results on reopening", async () => {
  let resolveOld!: (value: Response) => void;
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options: RequestInit) => {
      if (url.includes("sessionId=session-a")) {
        oldSignal = options.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(
        reply({
          sessionId: "session-b",
          detail: {
            id: "bt-1",
            title: "NEW",
            command: "new command",
            cwd: "/ws",
            status: "running",
            createdAt: 1,
            stdout: { text: "new output" },
            stderr: { text: "" },
          },
        }),
      );
    }),
  );
  const first = show({ ...target, terminalId: "bt-1" });
  first.unmount();
  expect(oldSignal?.aborted).toBe(true);
  show({
    ...target,
    sessionId: "session-b",
    sessionPath: "/ws/b.jsonl",
    terminalId: "bt-1",
  });
  expect(await screen.findByText("new output")).toBeTruthy();
  await act(async () =>
    resolveOld(
      reply({ sessionId: "session-a", detail: { id: "bt-1", title: "OLD" } }),
    ),
  );
  expect(screen.queryByText("OLD")).toBeNull();
  expect(screen.getByText("new output")).toBeTruthy();
});

it("rejects another Session's same-id terminal and renders output as plain text", async () => {
  const detail = {
    id: "bt-1",
    title: "Terminal",
    command: "printf",
    cwd: "/ws",
    status: "running",
    createdAt: 1,
    stdout: {
      text: '<img src="https://external.example/x" onerror="alert(1)">',
      truncated: true,
      omittedBytes: 15,
    },
    stderr: { text: "" },
    truncated: true,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ sessionId: "wrong", detail }))
    .mockResolvedValueOnce(reply({ sessionId: "session-a", detail }));
  vi.stubGlobal("fetch", fetcher);
  const view = show({ ...target, terminalId: "bt-1" });
  expect(
    await screen.findByText("The active session changed. Reopen this panel."),
  ).toBeTruthy();
  expect(screen.queryByText("printf")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(await screen.findByText(detail.stdout.text)).toBeTruthy();
  expect(
    view.container.ownerDocument.querySelector(".terminal-evidence img"),
  ).toBeNull();
  expect(
    screen.getByText("15 bytes omitted from this output view."),
  ).toBeTruthy();
});

function thinkingFetcher(thinking: unknown) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/thinking")) return reply(thinking);
    if (url.startsWith("/api/trust"))
      return reply({
        workspace: "/ws",
        state: "trusted",
        refreshRequired: false,
      });
    return reply({ providers: [], truncation: { truncated: false } });
  });
}

it("reports an unsupported thinking projection without a mismatch warning", async () => {
  vi.stubGlobal(
    "fetch",
    thinkingFetcher({
      sessionId: "session-a",
      level: "off",
      available: [],
      supported: false,
    }),
  );
  show();
  expect(await screen.findByText(i18n.t("thinkingUnsupported"))).toBeTruthy();
  expect(screen.getByText(i18n.t("thinkingUnsupportedHint"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("thinkingLevelMismatch"))).toBeNull();
});

it("warns with role status when the confirmed level is not available", async () => {
  vi.stubGlobal(
    "fetch",
    thinkingFetcher({
      sessionId: "session-a",
      level: "ultra",
      available: ["off", "low"],
      supported: true,
    }),
  );
  show();
  expect(await screen.findByText("ultra")).toBeTruthy();
  expect(screen.getByText("off · low")).toBeTruthy();
  const warning = screen.getByText(i18n.t("thinkingLevelMismatch"));
  expect(warning.getAttribute("role")).toBe("status");
});
