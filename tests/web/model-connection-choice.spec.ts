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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConnectionChoice } from "../../web/ui/src/features/settings/ModelConnectionChoice.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";

const models = ["alpha", "beta"].map((provider) => ({
  provider,
  id: "same-id",
  name: "Shared model",
  label: "Shared model",
  current: provider === "alpha",
}));
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(WebClient.prototype, "searchModels").mockImplementation(
    async (query, _session, _signal, provider) =>
      projectWebModelSearch(
        models.filter((model) => !provider || model.provider === provider),
        query,
      ),
  );
  vi.spyOn(WebClient.prototype, "saveModelDefault").mockImplementation(
    async (provider, id) => ({ model: { provider, id } }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  overrides: Partial<Parameters<typeof ModelConnectionChoice>[0]> = {},
) {
  const props = {
    sessionId: "A",
    sessionPath: "/workspace/a.jsonl",
    purpose: "use" as const,
    provider: "beta",
    busy: false,
    onSelectModel: vi.fn(async () => true),
    onDefaultSaved: vi.fn(),
    onSaving: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConnectionChoice, props),
    ),
  );
  return props;
}

it("uses the exact connection for a shared model ID and only writes a default after opt-in", async () => {
  const props = mount();
  const button = await screen.findByRole("button", {
    name: i18n.t("modelConnectionUse"),
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(WebClient.prototype.searchModels).toHaveBeenCalledWith(
    "",
    "A",
    expect.any(AbortSignal),
    "beta",
  );
  expect(WebClient.prototype.saveModelDefault).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(props.onSelectModel).toHaveBeenCalledWith("beta/same-id"),
  );
  expect(WebClient.prototype.saveModelDefault).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledOnce();
});

it("sets a future default without invoking current-session model selection", async () => {
  const props = mount({
    purpose: "default",
    provider: undefined,
    initialModel: { provider: "beta", id: "same-id" },
  });
  const button = await screen.findByRole("button", {
    name: i18n.t("modelDefaultSave"),
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(WebClient.prototype.saveModelDefault).toHaveBeenCalledWith(
      "beta",
      "same-id",
      "A",
      "/workspace/a.jsonl",
    ),
  );
  expect(props.onSelectModel).not.toHaveBeenCalled();
  expect(props.onDefaultSaved).toHaveBeenCalledWith({
    model: { provider: "beta", id: "same-id" },
  });
});

it("keeps the choice open when default persistence fails after a confirmed model switch", async () => {
  vi.mocked(WebClient.prototype.saveModelDefault).mockRejectedValue(
    new Error("offline"),
  );
  const props = mount();
  await screen.findByRole("combobox");
  fireEvent.click(
    screen.getByRole("checkbox", { name: i18n.t("modelMakeDefault") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("modelConnectionUse") }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("modelDefaultPartial"),
  );
  expect(props.onSelectModel).toHaveBeenCalledWith("beta/same-id");
  expect(props.onDefaultSaved).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("does not persist a default when current-model selection was rejected", async () => {
  const props = mount({ onSelectModel: vi.fn(async () => false) });
  await screen.findByRole("combobox");
  fireEvent.click(
    screen.getByRole("checkbox", { name: i18n.t("modelMakeDefault") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("modelConnectionUse") }),
  );
  await screen.findByRole("alert");
  expect(WebClient.prototype.saveModelDefault).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("keeps a small connection compact and searches beyond the first catalog page", async () => {
  const many = Array.from({ length: 70 }, (_, index) => ({
    ...models[1]!,
    id: `model-${index}`,
    name: `Model ${index}`,
  }));
  vi.mocked(WebClient.prototype.searchModels).mockImplementation(
    async (query) => projectWebModelSearch(many, query),
  );
  const props = mount();
  const search = await screen.findByRole("searchbox");
  fireEvent.change(search, { target: { value: "model-69" } });
  await waitFor(() =>
    expect(screen.getByRole("combobox").textContent).toContain("Model 69"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("modelConnectionUse") }),
  );
  await waitFor(() =>
    expect(props.onSelectModel).toHaveBeenCalledWith("beta/model-69"),
  );
});
