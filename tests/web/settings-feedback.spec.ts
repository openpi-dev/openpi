// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebModelConfiguration } from "../../web/runtime/types.ts";
import { ModelConfigurationEditor } from "../../web/ui/src/features/settings/ModelConfigurationEditor.tsx";
import { ProviderStatusSection } from "../../web/ui/src/features/settings/ProviderStatusSection.tsx";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const model: WebModelConfiguration = {
  provider: "alpha",
  id: "a",
  name: "Alpha",
  baseUrl: "http://localhost:12345/v1",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 4096,
};
function editor() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ModelConfigurationEditor, {
      sessionId: "s",
      busy: false,
      onSaved: async () => true,
    }),
  );
}

it("edits the sidebar selection and keeps separate drafts when changing models", async () => {
  const second = { ...model, id: "b", name: "Beta" };
  const configurations = vi
    .spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValue({
      revision: "r1",
      models: [model, second],
    });
  const node = (selectedKey: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey,
        busy: false,
        onSaved: async () => true,
      }),
    );
  const view = render(node("alpha/a"));
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.change(name, { target: { value: "Unfinished Alpha" } });
  view.rerender(node("alpha/b"));
  await waitFor(() => expect(name.value).toBe("Beta"));
  fireEvent.change(name, { target: { value: "Unfinished Beta" } });
  view.rerender(node("alpha/a"));
  await waitFor(() => expect(name.value).toBe("Unfinished Alpha"));
  view.rerender(node("alpha/b"));
  await waitFor(() => expect(name.value).toBe("Unfinished Beta"));
  expect(configurations).toHaveBeenCalledOnce();
});

it("keeps the current model selected when an earlier model save settles", async () => {
  vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue({
    revision: "r1",
    models: [model, { ...model, id: "b", name: "Beta" }],
  });
  let finish!: (value: { saved: true }) => void;
  vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const onSelect = vi.fn();
  const node = (selectedKey: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey,
        onSelect,
        busy: false,
        onSaved: async () => true,
      }),
    );
  const view = render(node("alpha/a"));
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  view.rerender(node("alpha/b"));
  await act(async () => finish({ saved: true }));
  await waitFor(() => expect(name.value).toBe("Beta"));
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t("modelConfigurationSaved"))).toBeNull();
});
async function selectModel() {
  const selection = await screen.findByRole("combobox", {
    name: i18n.t("configuredModels"),
  });
  await waitFor(() =>
    expect((selection as HTMLSelectElement).disabled).toBe(false),
  );
  fireEvent.change(selection, { target: { value: "alpha/a" } });
}

it.each(["maxTokens", "contextWindow", "api", "reasoning"] as const)(
  "clears the saved receipt when %s is edited",
  async (field) => {
    vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue({
      revision: "r1",
      models: [model],
    });
    vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockResolvedValue({
      saved: true,
    });
    render(editor());
    await selectModel();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
    );
    await screen.findByText(i18n.t("modelConfigurationSaved"));
    if (field === "reasoning")
      fireEvent.click(
        screen.getByRole("checkbox", { name: i18n.t("modelConfig_reasoning") }),
      );
    else if (field === "api")
      fireEvent.change(
        screen.getByRole("combobox", { name: i18n.t("modelConfig_api") }),
        { target: { value: "openai-completions" } },
      );
    else
      fireEvent.change(
        screen.getByRole("spinbutton", {
          name: i18n.t(`modelConfig_${field}`),
        }),
        { target: { value: "2048" } },
      );
    expect(screen.queryByText(i18n.t("modelConfigurationSaved"))).toBeNull();
  },
);

it("reloads the displayed values after a revision conflict instead of resubmitting stale fields", async () => {
  const latest = {
    ...model,
    name: "Changed elsewhere",
    baseUrl: "http://localhost:54321/v1",
    maxTokens: 8192,
  };
  vi.spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValueOnce({ revision: "r1", models: [model] })
    .mockResolvedValue({ revision: "r2", models: [latest] });
  const save = vi
    .spyOn(WebClient.prototype, "saveModelConfiguration")
    .mockRejectedValueOnce(new Error("Revision changed"))
    .mockResolvedValue({ saved: true });
  render(editor());
  await selectModel();
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("modelConfig_name") }),
    { target: { value: "Local draft" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  fireEvent.click(within(await screen.findByRole("alert")).getByRole("button"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("modelConfig_baseUrl"),
        }) as HTMLInputElement
      ).value,
    ).toBe(latest.baseUrl),
  );
  expect(
    (
      screen.getByRole("spinbutton", {
        name: i18n.t("modelConfig_maxTokens"),
      }) as HTMLInputElement
    ).value,
  ).toBe("8192");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      "s",
      "r2",
      latest,
      expect.any(AbortSignal),
    ),
  );
});

it("does not show a late credential save receipt under a different provider", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue({
    providers: ["alpha", "beta"].map((id) => ({
      id,
      name: id,
      configured: false,
      authMethods: ["api_key"],
      subscription: false,
      nameTruncated: false,
    })),
    truncation: {
      truncated: false,
      providersOmitted: 0,
      namesTruncated: 0,
      maxProviders: 250,
    },
  });
  let finish!: (value: { saved: true }) => void;
  vi.spyOn(WebClient.prototype, "saveProviderKey").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const node = (providerId: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderStatusSection, {
        sessionId: "s",
        providerId,
        active: true,
      }),
    );
  const { rerender } = render(node("alpha"));
  fireEvent.change(await screen.findByLabelText(i18n.t("providerApiKey")), {
    target: { value: "fixture-key" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
  );
  rerender(node("beta"));
  await act(async () => finish({ saved: true }));
  expect(screen.queryByText(i18n.t("providerKeySaved"))).toBeNull();
  expect(
    (
      screen.getByRole("combobox", {
        name: i18n.t("provider"),
      }) as HTMLSelectElement
    ).value,
  ).toBe("beta");
});
