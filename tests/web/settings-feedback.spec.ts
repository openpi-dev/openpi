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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { WebModelConfiguration } from "../../web/runtime/types.ts";
import { ModelConfigurationEditor } from "../../web/ui/src/features/settings/ModelConfigurationEditor.tsx";
import { ProviderStatusSection } from "../../web/ui/src/features/settings/ProviderStatusSection.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";

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

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it("confirms discarding a model draft before loading a revision conflict", async () => {
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
    .mockRejectedValueOnce(
      new WebApiError("Revision changed", 409, "MODEL_CONFIGURATION_CONFLICT"),
    )
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
  const confirmation = await screen.findByRole("alertdialog");
  expect(
    (
      screen.getByRole("textbox", {
        name: i18n.t("modelConfig_name"),
      }) as HTMLInputElement
    ).value,
  ).toBe("Local draft");
  fireEvent.click(
    within(confirmation).getByRole("button", {
      name: i18n.t("keepEditing"),
    }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reloadModelConfiguration") }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: i18n.t("discardAndReload"),
    }),
  );
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

it("keeps aggregate draft state across models and clears it after reverting every edit", async () => {
  const second = { ...model, id: "b", name: "Beta" };
  vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue({
    revision: "r1",
    models: [model, second],
  });
  const onDraftChange = vi.fn();
  const node = (selectedKey: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey,
        busy: false,
        onDraftChange,
        onSaved: async () => true,
      }),
    );
  const view = render(node("alpha/a"));
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  expect(onDraftChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(name, { target: { value: "Draft Alpha" } });
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  view.rerender(node("alpha/b"));
  await waitFor(() => expect(name.value).toBe("Beta"));
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByText(i18n.t("modelConfigurationUnsaved"))).toBeNull();
  fireEvent.change(name, { target: { value: "Draft Beta" } });
  fireEvent.change(name, { target: { value: "Beta" } });
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  view.rerender(node("alpha/a"));
  await waitFor(() => expect(name.value).toBe("Draft Alpha"));
  fireEvent.change(name, { target: { value: "Alpha" } });
  expect(onDraftChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByText(i18n.t("modelConfigurationUnsaved"))).toBeNull();
});

it("treats prefilled native model values as a clean baseline", async () => {
  vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue({
    revision: "r1",
    models: [],
  });
  const onDraftChange = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey: "alpha/a",
        selectedModel: model,
        busy: false,
        onDraftChange,
        onSaved: async () => true,
      }),
    ),
  );
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  expect(onDraftChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(name, { target: { value: "Draft" } });
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(name, { target: { value: "Alpha" } });
  expect(onDraftChange).toHaveBeenLastCalledWith(false);
});

it("preserves the draft when confirmed reload fails and when its read is retried", async () => {
  const latest = { ...model, name: "Changed elsewhere" };
  const configurations = vi
    .spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValueOnce({ revision: "r1", models: [model] })
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue({ revision: "r2", models: [latest] });
  vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockRejectedValue(
    new WebApiError("Revision changed", 409, "MODEL_CONFIGURATION_CONFLICT"),
  );
  const onDraftChange = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey: "alpha/a",
        busy: false,
        onDraftChange,
        onSaved: async () => true,
      }),
    ),
  );
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.change(name, { target: { value: "Local draft" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("reloadModelConfiguration"),
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: i18n.t("discardAndReload"),
    }),
  );
  const retry = await screen.findByRole("button", {
    name: i18n.t("retryModelConfiguration"),
  });
  expect(name.value).toBe("Local draft");
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(retry);
  await waitFor(() => expect(configurations).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(retry.isConnected).toBe(false));
  expect(name.value).toBe("Local draft");
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  expect(
    (
      screen.getByRole("button", {
        name: i18n.t("saveModelConfiguration"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("retries a failed save without reloading or changing the model draft", async () => {
  const configurations = vi
    .spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValue({ revision: "r1", models: [model] });
  const save = vi
    .spyOn(WebClient.prototype, "saveModelConfiguration")
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue({ saved: true });
  const onDraftChange = vi.fn();
  const onSavingChange = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey: "alpha/a",
        busy: false,
        onDraftChange,
        onSavingChange,
        onSaved: async () => true,
      }),
    ),
  );
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.change(name, { target: { value: "Local draft" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  await screen.findByRole("alert");
  expect(name.value).toBe("Local draft");
  expect(configurations).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
  expect(onSavingChange).toHaveBeenCalledWith(true);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      "s",
      "r1",
      { ...model, name: "Local draft" },
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(false));
});

it("does not reload when navigation callback identities change", async () => {
  const configurations = vi
    .spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValue({ revision: "r1", models: [model] });
  const node = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey: "alpha/a",
        onSelect: vi.fn(),
        onModelsLoaded: vi.fn(),
        busy: false,
        onSaved: async () => true,
      }),
    );
  const view = render(node());
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.change(name, { target: { value: "Local draft" } });
  view.rerender(node());
  expect(name.value).toBe("Local draft");
  expect(configurations).toHaveBeenCalledOnce();
});

it("protects externally changed draft baselines without blocking unchanged model drafts", async () => {
  const second = { ...model, id: "b", name: "Beta" };
  const third = { ...model, id: "c", name: "Gamma" };
  const updatedSecond = { ...second, name: "External Beta" };
  vi.spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValueOnce({ revision: "r1", models: [model, second, third] })
    .mockResolvedValue({
      revision: "r2",
      models: [model, updatedSecond, third],
    });
  vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockResolvedValue({
    saved: true,
  });
  const onDraftChange = vi.fn();
  const node = (selectedKey: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelConfigurationEditor, {
        sessionId: "s",
        selectedKey,
        busy: false,
        onDraftChange,
        onSaved: async () => true,
      }),
    );
  const view = render(node("alpha/b"));
  const name = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_name"),
  });
  await waitFor(() => expect(name.value).toBe("Beta"));
  fireEvent.change(name, { target: { value: "Draft Beta" } });
  view.rerender(node("alpha/c"));
  await waitFor(() => expect(name.value).toBe("Gamma"));
  fireEvent.change(name, { target: { value: "Draft Gamma" } });
  view.rerender(node("alpha/a"));
  await waitFor(() => expect(name.value).toBe("Alpha"));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  await screen.findByText(i18n.t("modelConfigurationSaved"));
  view.rerender(node("alpha/b"));
  await waitFor(() => expect(name.value).toBe("Draft Beta"));
  expect(screen.getByText(i18n.t("modelConfigurationConflict"))).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: i18n.t("saveModelConfiguration"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  view.rerender(node("alpha/c"));
  await waitFor(() => expect(name.value).toBe("Draft Gamma"));
  expect(screen.queryByText(i18n.t("modelConfigurationConflict"))).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: i18n.t("saveModelConfiguration"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  view.rerender(node("alpha/b"));
  await waitFor(() => expect(name.value).toBe("Draft Beta"));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reloadModelConfiguration") }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: i18n.t("discardAndReload"),
    }),
  );
  await waitFor(() => expect(name.value).toBe("External Beta"));
  expect(screen.queryByText(i18n.t("modelConfigurationConflict"))).toBeNull();
  expect(onDraftChange).toHaveBeenLastCalledWith(true);
  view.rerender(node("alpha/c"));
  await waitFor(() => expect(name.value).toBe("Draft Gamma"));
});

it("does not change selection when a saved model's authoritative reload settles late", async () => {
  const second = { ...model, id: "b", name: "Beta" };
  let finish!: (value: {
    revision: string;
    models: WebModelConfiguration[];
  }) => void;
  const configurations = vi
    .spyOn(WebClient.prototype, "modelConfigurations")
    .mockResolvedValueOnce({ revision: "r1", models: [model, second] })
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockResolvedValue({
    saved: true,
  });
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
  await waitFor(() => expect(configurations).toHaveBeenCalledTimes(2));
  view.rerender(node("alpha/b"));
  await act(async () => finish({ revision: "r2", models: [model, second] }));
  await waitFor(() => expect(name.value).toBe("Beta"));
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByText(i18n.t("modelConfigurationSaved"))).toBeNull();
});

it("does not show a late model save failure under another model", async () => {
  const second = { ...model, id: "b", name: "Beta" };
  vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue({
    revision: "r1",
    models: [model, second],
  });
  let fail!: (reason: Error) => void;
  vi.spyOn(WebClient.prototype, "saveModelConfiguration").mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
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
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  view.rerender(node("alpha/b"));
  await act(async () => fail(new Error("Disconnected")));
  await waitFor(() => expect(name.value).toBe("Beta"));
  expect(screen.queryByRole("alert")).toBeNull();
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
