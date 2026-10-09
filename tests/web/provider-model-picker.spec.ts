// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createServer } from "node:http";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ProviderModelPicker } from "../../web/ui/src/features/settings/ProviderModelPicker.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import type { DiscoveredProviderModel } from "../../web/runtime/provider-model-discovery.ts";
import { discoverProviderModels } from "../../web/runtime/provider-model-discovery.ts";

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
function mount(existingIds = ["existing"]) {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderModelPicker, {
        sessionId: "session",
        template,
        existingIds,
        apiKey: "draft-key",
        onClose,
        onAdd,
      }),
    ),
  );
  return { onAdd, onClose };
}
const candidates: DiscoveredProviderModel[] = [
  { id: "existing", name: "Existing" },
  {
    id: "a",
    name: "Alpha",
    contextWindow: 256000,
    maxTokens: 32000,
    input: ["text", "image"],
    reasoning: true,
  },
  { id: "b", name: "Beta" },
];

it("finds and adds a model acquired from the second Anthropic page", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url!);
    response.end(
      JSON.stringify(
        seen.length === 1
          ? {
              data: Array.from({ length: 20 }, (_, i) => ({
                id: `first-${i}`,
              })),
              has_more: true,
              last_id: "first-19",
            }
          : {
              data: [{ id: "later-model", display_name: "Later model" }],
              has_more: false,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    vi.spyOn(WebClient.prototype, "discoverProviderModels").mockImplementation(
      (_session, request, signal) =>
        discoverProviderModels(
          {
            ...request,
            baseUrl: `http://127.0.0.1:${address.port}`,
            api: "anthropic-messages",
          },
          { "x-api-key": "dummy-fixture-key" },
          signal ?? AbortSignal.timeout(2000),
        ),
    );
    const { onAdd } = mount([]);
    await screen.findByRole("checkbox", { name: "later-model" });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Later model" },
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.queryByText(i18n.t("providerPickerBounded"))).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("providerPickerSave") }),
    );
    expect(onAdd.mock.calls[0]?.[0]).toContainEqual({
      id: "later-model",
      name: "Later model",
    });
    expect(seen).toEqual(["/v1/models", "/v1/models?after_id=first-19"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("preserves hidden selections, disables existing models and adds only to the parent draft", async () => {
  const discover = vi
    .spyOn(WebClient.prototype, "discoverProviderModels")
    .mockResolvedValue({ models: candidates, truncated: false });
  const save = vi.spyOn(WebClient.prototype, "saveModelConfigurations");
  const { onAdd } = mount();
  await screen.findByRole("checkbox", { name: "a" });
  expect(discover.mock.calls[0]?.[1]).toMatchObject({ apiKey: "draft-key" });
  expect(
    (screen.getByRole("checkbox", { name: /existing/ }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: "a" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: "b" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Beta" },
  });
  expect(screen.getByText("2 selected")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerPickerClear") }),
  );
  expect(screen.getByText("1 selected")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerPickerSelectAll") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerPickerSave") }),
  );
  expect(onAdd).toHaveBeenCalledWith(candidates.slice(1));
  expect(save).not.toHaveBeenCalled();
});

it("supports safe failure, retry, no-match search and cancel without writing", async () => {
  vi.spyOn(WebClient.prototype, "discoverProviderModels")
    .mockRejectedValueOnce(new Error("private provider details"))
    .mockResolvedValue({ models: candidates, truncated: false });
  const { onAdd, onClose } = mount();
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).not.toContain(
    "private provider",
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
  );
  await screen.findByRole("checkbox", { name: "a" });
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "nothing" },
  });
  expect(screen.getByText(i18n.t("providerPickerNoMatch"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("cancel") }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onAdd).not.toHaveBeenCalled();
});

it("limits additions by the remaining capacity of the whole provider", async () => {
  vi.spyOn(WebClient.prototype, "discoverProviderModels").mockResolvedValue({
    models: candidates.slice(1),
    truncated: false,
  });
  const { onAdd } = mount(
    Array.from({ length: 99 }, (_, index) => `already-${index}`),
  );
  await screen.findByRole("checkbox", { name: "a" });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerPickerSelectAll") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerPickerSave") }),
  );
  expect(onAdd).toHaveBeenCalledWith([candidates[1]]);
});
