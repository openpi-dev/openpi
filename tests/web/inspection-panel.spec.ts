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
function show(value = target, onOpenProviders = vi.fn()) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(InspectionPanel, {
        target: value,
        onClose: vi.fn(),
        onOpenProviders,
      }),
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

it("keeps provider discovery out of runtime status and links to its page", async () => {
  const onOpenProviders = vi.fn();
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
    throw new Error(`Unexpected status request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  show(target, onOpenProviders);
  expect(
    await screen.findByText("Thinking state is unavailable."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Project resources are restricted pending a trust decision.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Configured credentials do not guarantee a successful model request.",
    ),
  ).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openProviderSettings") }),
  );
  expect(onOpenProviders).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
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

it("separates saved trust from active Session authority and copies only the canonical setup command", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.startsWith("/api/thinking")
        ? reply({
            sessionId: target.sessionId,
            level: "medium",
            available: ["medium"],
            supported: true,
          })
        : url.startsWith("/api/trust")
          ? reply({
              source: "pi-project-trust",
              workspace: "/ws",
              state: "trusted",
              decision: "denied",
              sessionTrusted: true,
              refreshRequired: true,
            })
          : reply({ providers: [], truncation: { truncated: false } }),
    ),
  );
  show();
  expect(await screen.findByText("Denied")).toBeTruthy();
  expect(screen.getByText("Trusted in this Session")).toBeTruthy();
  expect(screen.getByText(i18n.t("trustRefreshNeeded"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("/openpi-setup"));
  expect(screen.getByRole("status").textContent).toContain("Copied");
  Reflect.deleteProperty(navigator, "clipboard");
});
