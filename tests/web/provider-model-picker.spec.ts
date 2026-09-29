// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { ProviderModelPicker } from "../../web/ui/src/features/settings/ProviderModelPicker.tsx";

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const template = {
  provider: "fixture",
  baseUrl: "https://fixture.example/v1",
  api: "openai-responses" as const,
  id: "existing",
  name: "Existing",
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 8192,
};

it("preserves hidden selections, excludes configured models and retains selection after save failure", async () => {
  const discover = vi
    .spyOn(WebClient.prototype, "discoverProviderModels")
    .mockResolvedValue({
      models: [
        { id: "existing", name: "Existing" },
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
      truncated: false,
    });
  const save = vi
    .spyOn(WebClient.prototype, "saveModelConfigurations")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ saved: true });
  const saved = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderModelPicker, {
        sessionId: "session",
        template,
        configuration: { revision: "original", models: [template] },
        onClose: vi.fn(),
        onSaved: saved,
      }),
    ),
  );
  await screen.findByText("Alpha");
  expect(discover.mock.calls[0]?.[1]).not.toHaveProperty("apiKey");
  expect(
    (screen.getByRole("checkbox", { name: /Existing/ }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Beta" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
  expect(save.mock.calls[0]?.[2].map((model) => model.id)).toEqual(["a", "b"]);
  expect(screen.getByText("2 selected · up to 100")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith({ ...template, id: "a", name: "Alpha" }),
  );
});
