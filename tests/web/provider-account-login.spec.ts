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
import type { WebProviderLogin } from "../../web/protocol/provider-login.ts";
import { ProviderAccountLogin } from "../../web/ui/src/features/settings/ProviderAccountLogin.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const provider = {
  id: "openai",
  name: "OpenAI",
  loginLabel: "ChatGPT",
  authMethods: ["oauth"] as const,
  configured: false,
  subscription: false,
  nameTruncated: false,
};
const base: WebProviderLogin = {
  id: "flow-a",
  sessionId: "session-a",
  provider: provider.id,
  status: "running",
  expiresAt: Date.now() + 60_000,
  messages: [],
};
let state: WebProviderLogin | null;
beforeEach(() => {
  state = null;
  vi.spyOn(WebClient.prototype, "providerLogin").mockImplementation(async () =>
    structuredClone(state),
  );
  vi.spyOn(WebClient.prototype, "startProviderLogin").mockImplementation(
    async () => {
      state = {
        ...base,
        prompt: {
          id: "choose",
          type: "select",
          message: "Choose a method",
          options: [
            { id: "browser", label: "Browser login" },
            { id: "device_code", label: "Device login" },
          ],
        },
      };
      return structuredClone(state);
    },
  );
  vi.spyOn(WebClient.prototype, "cancelProviderLogin").mockImplementation(
    async () => {
      state = { ...base, status: "cancelled" };
      return structuredClone(state);
    },
  );
  vi.spyOn(WebClient.prototype, "respondProviderLogin").mockImplementation(
    async (_session, _flow, prompt, value) => {
      if (prompt === "choose" && value === "browser")
        state = {
          ...base,
          auth: {
            url: "https://accounts.example/authorize?state=private-state",
          },
          prompt: {
            id: "manual",
            type: "manual_code",
            message: "Paste callback",
          },
        };
      else state = { ...base };
      return structuredClone(state);
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const onAuthenticated = vi.fn();
  const onSaving = vi.fn();
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderAccountLogin, {
        sessionId: "session-a",
        auth: provider,
        busy: false,
        onSaving,
        onAuthenticated,
        onReload: vi.fn(),
      }),
    ),
  );
  return { ...view, onAuthenticated, onSaving };
}

it("keeps browser authorization readable and reveals manual code only on request", async () => {
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(i18n.t("accountLoginBrowser")),
    }),
  );
  const link = await screen.findByRole("link", {
    name: i18n.t("accountLoginOpen"),
  });
  expect(link.getAttribute("href")).toBe(
    "https://accounts.example/authorize?state=private-state",
  );
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.queryByText(/private-state/u)).toBeNull();
  expect(
    document.querySelector(".models-login-fallback")?.hasAttribute("open"),
  ).toBe(false);
  fireEvent.click(screen.getByText(i18n.t("accountLoginFallback")));
  const input = screen.getByLabelText(i18n.t("accountLoginPaste"));
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.change(input, { target: { value: "private-code" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(WebClient.prototype.respondProviderLogin).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginContinue") }),
  );
  await waitFor(() =>
    expect(WebClient.prototype.respondProviderLogin).toHaveBeenCalledWith(
      "session-a",
      "flow-a",
      "manual",
      "private-code",
    ),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText(i18n.t("accountLoginPaste"))).toBeNull(),
  );
  state = { ...base, status: "succeeded" };
  await waitFor(() => expect(view.onAuthenticated).toHaveBeenCalledTimes(1), {
    timeout: 2200,
  });
  expect(document.body.textContent).not.toContain("private-code");
});

it("shows the device code, copies it and cancels the exact native flow", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  vi.mocked(WebClient.prototype.startProviderLogin).mockImplementation(
    async () => {
      state = {
        ...base,
        device: { code: "CODE-1234", url: "https://accounts.example/device" },
      };
      return structuredClone(state);
    },
  );
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  await screen.findByText("CODE-1234");
  expect(screen.queryByText(i18n.t("accountLoginFallback"))).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginCopyCode") }),
  );
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("CODE-1234"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginCancel") }),
  );
  await screen.findByText(i18n.t("accountLogin_cancelled"));
  expect(WebClient.prototype.cancelProviderLogin).toHaveBeenCalledWith(
    "session-a",
    "flow-a",
  );
});

it("recovers a lost start response without creating a second login", async () => {
  vi.mocked(WebClient.prototype.startProviderLogin).mockRejectedValue(
    new Error("Connection lost"),
  );
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  await screen.findByText(i18n.t("accountLoginRequestFailed"));
  state = {
    ...base,
    device: { code: "RECOVERED", url: "https://accounts.example/device" },
  };
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await screen.findByText("RECOVERED");
  expect(WebClient.prototype.startProviderLogin).toHaveBeenCalledTimes(1);
  expect(view.onAuthenticated).not.toHaveBeenCalled();
});

it("cancels an orphaned start result after the panel has unmounted", async () => {
  const start = Promise.withResolvers<WebProviderLogin>();
  vi.mocked(WebClient.prototype.startProviderLogin).mockReturnValue(
    start.promise,
  );
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  view.unmount();
  await act(async () => start.resolve({ ...base }));
  await waitFor(() =>
    expect(WebClient.prototype.cancelProviderLogin).toHaveBeenCalledWith(
      "session-a",
      "flow-a",
    ),
  );
  expect(view.onAuthenticated).not.toHaveBeenCalled();
});

it("keeps a committed credential with failed availability refresh distinct from successful setup", async () => {
  const view = mount();
  vi.mocked(WebClient.prototype.startProviderLogin).mockResolvedValue({
    ...base,
    status: "succeeded",
    refreshRequired: true,
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  await screen.findByText(i18n.t("accountLoginRefreshRequired"));
  expect(view.onAuthenticated).not.toHaveBeenCalled();
});
