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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type {
  WebModelConfigurations,
  WebProviderAuthProjection,
} from "../../web/runtime/types.ts";
import { ProviderSettingsPage } from "../../web/ui/src/features/settings/ProviderSettingsPage.tsx";
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
const model = {
  provider: "alpha",
  id: "a",
  name: "Model A",
  baseUrl: "https://alpha.example/v1",
  api: "openai-responses" as const,
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 8192,
};
const configuration: WebModelConfigurations = {
  revision: "r1",
  models: [
    model,
    { ...model, id: "b", name: "Model B" },
    { ...model, provider: "beta", id: "c", name: "Model C" },
  ],
  providers: [
    {
      provider: "alpha",
      name: "Alpha",
      baseUrl: model.baseUrl,
      api: model.api,
      editable: true,
    },
    {
      provider: "beta",
      name: "Beta",
      baseUrl: model.baseUrl,
      api: model.api,
      editable: true,
    },
  ],
};
const auth: WebProviderAuthProjection = {
  providers: [
    {
      id: "alpha",
      name: "Alpha",
      authMethods: ["api_key"],
      configured: true,
      custom: true,
      subscription: false,
      nameTruncated: false,
    },
    {
      id: "beta",
      name: "Beta",
      authMethods: ["api_key"],
      configured: false,
      custom: true,
      subscription: false,
      nameTruncated: false,
    },
    {
      id: "gamma",
      name: "Gamma",
      authMethods: ["api_key"],
      configured: false,
      custom: false,
      baseUrl: model.baseUrl,
      api: model.api,
      subscription: false,
      nameTruncated: false,
    },
  ],
  truncation: {
    truncated: false,
    namesTruncated: 0,
    providersOmitted: 0,
    maxProviders: 250,
  },
};
beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(WebClient.prototype, "modelConfigurations").mockResolvedValue(
    structuredClone(configuration),
  );
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(
    structuredClone(auth),
  );
  vi.spyOn(WebClient.prototype, "settingsCatalog").mockRejectedValue(
    new Error("No catalog in model fixture"),
  );
  vi.spyOn(
    WebClient.prototype,
    "changeProviderConfiguration",
  ).mockResolvedValue({ saved: true });
  vi.spyOn(WebClient.prototype, "saveProviderKey").mockResolvedValue({
    saved: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(
  overrides: Partial<Parameters<typeof ProviderSettingsPage>[0]> = {},
) {
  const props = {
    sessionId: "session-a",
    cwd: "/fixture",
    models: [],
    thinkingLevel: "medium",
    theme: "light" as const,
    setupBusy: false,
    modelSelectionPending: false,
    onSelectModel: vi.fn(),
    onConfigureOpenPi: vi.fn(async () => true),
    onPreferencesChanged: vi.fn(async () => true),
    onOpenRuntimeStatus: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const element = (next = props) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderSettingsPage, next),
    );
  const view = render(element());
  if (!overrides.entry)
    fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  return {
    ...view,
    props,
    update: (patch: Partial<typeof props>) =>
      view.rerender(element({ ...props, ...patch })),
  };
}
async function edit(name = "Alpha") {
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("editProvider", { provider: name }),
    }),
  );
}
function advanced() {
  fireEvent.click(screen.getByText(i18n.t("providerCustomSettings")));
}
function control(label: string) {
  return screen
    .getAllByLabelText(label)
    .find((element) => !element.closest("[hidden]"))!;
}
function change(label: string, value: string) {
  fireEvent.change(control(label), { target: { value } });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("providerSave") }));
}

it("starts with compact provider rows and only expands the requested card", async () => {
  mount();
  await screen.findByRole("button", { name: "Edit Alpha" });
  expect(screen.queryByLabelText("API key")).toBeNull();
  expect(
    screen.getAllByRole("img").map((node) => node.getAttribute("aria-label")),
  ).toEqual([i18n.t("credentialConfigured"), i18n.t("credentialMissing")]);
  await edit();
  expect(control("API key")).toBeTruthy();
  expect(
    document.querySelector("details.models-customized")?.hasAttribute("open"),
  ).toBe(false);
  advanced();
  expect((control("Model 1 name") as HTMLInputElement).value).toBe("Model A");
});

it("makes native account providers discoverable without adding a custom endpoint", async () => {
  vi.mocked(WebClient.prototype.providerAuth).mockResolvedValue({
    ...auth,
    providers: [
      ...auth.providers,
      {
        id: "openai",
        name: "OpenAI",
        authMethods: ["api_key", "oauth"],
        configured: false,
        subscription: false,
        nameTruncated: false,
        custom: false,
      },
    ],
  });
  vi.spyOn(WebClient.prototype, "providerLogin").mockResolvedValue(null);
  mount();
  await edit("OpenAI");
  expect(
    screen.getByRole("button", {
      name: i18n.t("accountLoginStart"),
    }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(i18n.t("providerApiKey"))).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("providerSave") }),
  ).toBeNull();
  expect(
    document.querySelector("details.models-customized")?.hasAttribute("open"),
  ).toBe(false);
  expect(
    WebClient.prototype.changeProviderConfiguration,
  ).not.toHaveBeenCalled();
});

it("preserves per-provider credentials and model drafts across cards and settings tabs", async () => {
  mount();
  await edit();
  advanced();
  change("Model 1 name", "Unfinished A");
  change("API key", "alpha-private-draft");
  await edit("Beta");
  change("API key", "beta-private-draft");
  await edit();
  expect((control("API key") as HTMLInputElement).value).toBe(
    "alpha-private-draft",
  );
  expect((control("Model 1 name") as HTMLInputElement).value).toBe(
    "Unfinished A",
  );
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("generalSettings") }));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  expect((control("API key") as HTMLInputElement).value).toBe(
    "alpha-private-draft",
  );
  expect(WebClient.prototype.modelConfigurations).toHaveBeenCalledOnce();
});

it("keeps the active account flow visible until native cancellation settles", async () => {
  vi.mocked(WebClient.prototype.providerAuth).mockResolvedValue({
    ...auth,
    providers: [
      ...auth.providers,
      {
        id: "openai",
        name: "OpenAI",
        authMethods: ["oauth"],
        configured: false,
        subscription: false,
        nameTruncated: false,
      },
    ],
  });
  let state: Awaited<ReturnType<WebClient["startProviderLogin"]>> | null = null;
  vi.spyOn(WebClient.prototype, "providerLogin").mockImplementation(
    async () => state,
  );
  vi.spyOn(WebClient.prototype, "startProviderLogin").mockImplementation(
    async () => {
      state = {
        id: "flow-a",
        sessionId: "session-a",
        provider: "openai",
        status: "running",
        expiresAt: Date.now() + 60_000,
        messages: [],
        device: {
          code: "FIXTURE-CODE",
          url: "https://accounts.example/device",
        },
      };
      return state;
    },
  );
  const cancellation =
    Promise.withResolvers<
      Awaited<ReturnType<WebClient["cancelProviderLogin"]>>
    >();
  vi.spyOn(WebClient.prototype, "cancelProviderLogin").mockReturnValue(
    cancellation.promise,
  );
  mount();
  await edit("OpenAI");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginStart") }),
  );
  await screen.findByText("FIXTURE-CODE");
  const skills = screen.getByRole<HTMLButtonElement>("tab", {
    name: i18n.t("skillsSettings"),
  });
  await waitFor(() => expect(skills.disabled).toBe(true));
  fireEvent.click(skills);
  expect(screen.getByText("FIXTURE-CODE")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("accountLoginCancel") }),
  );
  expect(skills.disabled).toBe(true);
  state = { ...state!, status: "cancelled" };
  await act(async () => cancellation.resolve(state!));
  await waitFor(() => expect(skills.disabled).toBe(false));
});

it("edits K/M capacities without rewriting keystrokes and keeps independent expanded rows", async () => {
  mount();
  await edit();
  advanced();
  fireEvent.click(
    screen.getByRole("button", { name: "Model details: Model A" }),
  );
  expect((control("Context window 1") as HTMLInputElement).value).toBe("128K");
  expect((control("Max output tokens 1") as HTMLInputElement).value).toBe(
    "8192",
  );
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Supports reasoning",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  change("Context window 1", "2.");
  fireEvent.click(screen.getByRole("checkbox", { name: "Supports reasoning" }));
  fireEvent.blur(control("Context window 1"));
  fireEvent.click(
    screen.getByRole("button", { name: "Model details: Model B" }),
  );
  expect((control("Context window 1") as HTMLInputElement).value).toBe("2.");
  expect((control("Context window 2") as HTMLInputElement).value).toBe("128K");
  expect(
    (
      screen.getByRole("button", {
        name: "Save",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Model 1");
  change("Context window 1", "2.3M");
  change("Max output tokens 1", "32k");
  fireEvent.blur(control("Max output tokens 1"));
  expect((control("Max output tokens 1") as HTMLInputElement).value).toBe(
    "32k",
  );
  save();
  await waitFor(() =>
    expect(
      WebClient.prototype.changeProviderConfiguration,
    ).toHaveBeenCalledOnce(),
  );
  expect(
    vi.mocked(WebClient.prototype.changeProviderConfiguration).mock
      .calls[0]?.[2],
  ).toMatchObject({
    configuration: {
      models: [
        {
          ...model,
          reasoning: false,
          contextWindow: 2300000,
          maxTokens: 32000,
        },
        { ...model, id: "b", name: "Model B" },
      ],
    },
  });
});

it("keeps model options attached after deleting a sibling and lets empty capacities use native defaults", async () => {
  mount();
  await edit();
  advanced();
  fireEvent.click(
    screen.getByRole("button", { name: "Model details: Model A" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Model details: Model B" }),
  );
  change("Context window 2", "1M");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove model: Model A" }),
  );
  expect((control("Context window 1") as HTMLInputElement).value).toBe("1M");
  change("Context window 1", "");
  change("Max output tokens 1", "");
  change("Model 1 name", "");
  expect((control("Context window 1") as HTMLInputElement).placeholder).toBe(
    "256K",
  );
  save();
  await waitFor(() =>
    expect(
      WebClient.prototype.changeProviderConfiguration,
    ).toHaveBeenCalledOnce(),
  );
  const request = vi.mocked(WebClient.prototype.changeProviderConfiguration)
    .mock.calls[0]?.[2];
  expect(request?.action).toBe("save");
  if (request?.action !== "save") throw new Error("Missing provider save");
  expect(request.configuration.models).toHaveLength(1);
  expect(request.configuration.models[0]).toMatchObject({
    id: "b",
    name: "b",
    reasoning: true,
  });
  expect(request.configuration.models[0]?.contextWindow).toBeUndefined();
  expect(request.configuration.models[0]?.maxTokens).toBeUndefined();
});

it("guards closing dirty settings and allows closing after every edit is reverted", async () => {
  const { props } = mount();
  await edit();
  advanced();
  change("Model 1 name", "Draft");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(confirm).getByRole("button", { name: i18n.t("keepEditing") }),
  );
  expect(props.onClose).not.toHaveBeenCalled();
  change("Model 1 name", "Model A");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  expect(props.onClose).toHaveBeenCalledOnce();
});

it("keeps both add-mode drafts and writes nothing when cancelled", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("providerAdd") }),
  );
  change("API key", "gamma-draft");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerAddCustom") }),
  );
  change(i18n.t("modelConfig_provider"), "new-provider");
  change("Provider name", "New Provider");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerAddCatalog") }),
  );
  expect((control("API key") as HTMLInputElement).value).toBe("gamma-draft");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerAddCustom") }),
  );
  expect((control("Provider name") as HTMLInputElement).value).toBe(
    "New Provider",
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("cancel") }));
  expect(
    WebClient.prototype.changeProviderConfiguration,
  ).not.toHaveBeenCalled();
  expect(WebClient.prototype.saveProviderKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("providerAdd") }));
  expect((control("Provider name") as HTMLInputElement).value).toBe("");
});

it("saves an API key through native Pi authentication without a model call or profile rewrite", async () => {
  const { props } = mount();
  await edit();
  change("API key", "new-secret");
  save();
  await screen.findByRole("status", { name: "" });
  await waitFor(() =>
    expect(props.onPreferencesChanged).toHaveBeenCalledOnce(),
  );
  expect(WebClient.prototype.saveProviderKey).toHaveBeenCalledWith(
    "session-a",
    "alpha",
    "new-secret",
    expect.any(AbortSignal),
  );
  expect(
    WebClient.prototype.changeProviderConfiguration,
  ).not.toHaveBeenCalled();
  expect(props.onConfigureOpenPi).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue("new-secret")).toBeNull();
});

it("saves sibling models together and retains per-model endpoint overrides", async () => {
  vi.mocked(WebClient.prototype.modelConfigurations).mockResolvedValue({
    ...configuration,
    models: [
      model,
      {
        ...model,
        id: "b",
        name: "Model B",
        baseUrl: "https://override.example/v1",
      },
    ],
  });
  mount();
  await edit();
  advanced();
  change("Model 1 name", "Changed");
  save();
  await waitFor(() =>
    expect(
      WebClient.prototype.changeProviderConfiguration,
    ).toHaveBeenCalledOnce(),
  );
  const payload = vi.mocked(WebClient.prototype.changeProviderConfiguration)
    .mock.calls[0]![2];
  expect(payload.action).toBe("save");
  if (payload.action !== "save") throw Error("Expected save");
  expect(
    payload.configuration.models.map((item) => [item.name, item.baseUrl]),
  ).toEqual([
    ["Changed", model.baseUrl],
    ["Model B", "https://override.example/v1"],
  ]);
  expect(payload.configuration.models[0]).not.toHaveProperty("rowKey");
});

it("edits text/image inputs without allowing an empty input capability", async () => {
  mount();
  await edit();
  advanced();
  fireEvent.click(
    screen.getByRole("button", { name: "Model details: Model A" }),
  );
  const textInput = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "Text",
  });
  const imageInput = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "Images",
  });
  expect(textInput.disabled).toBe(true);
  fireEvent.click(imageInput);
  expect(textInput.disabled).toBe(false);
  fireEvent.click(textInput);
  expect(imageInput.disabled).toBe(true);
  save();
  await waitFor(() =>
    expect(
      WebClient.prototype.changeProviderConfiguration,
    ).toHaveBeenCalledOnce(),
  );
  const change = vi.mocked(WebClient.prototype.changeProviderConfiguration).mock
    .calls[0]![2];
  expect(
    change.action === "save" && change.configuration.models[0]?.input,
  ).toEqual(["image"]);
});

it("locks navigation for the full save and never shows success on a failed request", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(WebClient.prototype.saveProviderKey).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  mount();
  await edit();
  change("API key", "retry-key");
  save();
  expect(
    (screen.getByRole("button", { name: "Edit Beta" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: i18n.t("close") }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => reject(new Error("secret must not be displayed")));
  expect((control("API key") as HTMLInputElement).value).toBe("retry-key");
  expect(screen.getByRole("alert").textContent).not.toContain("secret must");
  expect(screen.queryByText("Saved Alpha.")).toBeNull();
  vi.mocked(WebClient.prototype.saveProviderKey).mockResolvedValue({
    saved: true,
  });
  save();
  await screen.findByText("Saved Alpha.");
});

it("retries only credentials after the provider profile was saved", async () => {
  vi.mocked(WebClient.prototype.saveProviderKey).mockRejectedValueOnce(
    new Error("offline"),
  );
  mount();
  await edit();
  advanced();
  change("Model 1 name", "Updated");
  change("API key", "retry");
  save();
  await screen.findByText(i18n.t("providerProfileSavedKeyFailed"));
  expect((control("Model 1 name") as HTMLInputElement).disabled).toBe(true);
  save();
  await screen.findByText("Saved Alpha.");
  expect(
    WebClient.prototype.changeProviderConfiguration,
  ).toHaveBeenCalledOnce();
  expect(WebClient.prototype.saveProviderKey).toHaveBeenCalledTimes(2);
});

it("keeps a conflicted draft and prevents silently overwriting a newer revision", async () => {
  vi.mocked(WebClient.prototype.changeProviderConfiguration).mockRejectedValue(
    new WebApiError("conflict", 409, "MODEL_CONFIGURATION_CONFLICT"),
  );
  mount();
  await edit();
  advanced();
  change("Model 1 name", "Draft");
  save();
  await screen.findByRole("alert");
  expect((control("Model 1 name") as HTMLInputElement).value).toBe("Draft");
  expect(
    (
      screen.getByRole("button", {
        name: i18n.t("providerSave"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("does not announce a complete save when cancelling a partially saved provider", async () => {
  vi.mocked(WebClient.prototype.saveProviderKey).mockRejectedValue(
    new Error("offline"),
  );
  mount();
  await edit();
  advanced();
  change("Model 1 name", "Updated");
  change("API key", "failed-key");
  save();
  await screen.findByText(i18n.t("providerProfileSavedKeyFailed"));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("cancel") }));
  await waitFor(() =>
    expect(WebClient.prototype.modelConfigurations).toHaveBeenCalledTimes(2),
  );
  expect(screen.queryByText("Saved Alpha.")).toBeNull();
});

it("blocks saves during an active session while keeping drafts editable", async () => {
  mount({ setupBusy: true });
  await edit();
  change("API key", "draft");
  expect(
    (
      screen.getByRole("button", {
        name: i18n.t("providerSave"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(WebClient.prototype.saveProviderKey).not.toHaveBeenCalled();
});

it("shows an initial load error and retries without discarding the surrounding settings", async () => {
  vi.mocked(WebClient.prototype.modelConfigurations).mockRejectedValueOnce(
    new Error("private details"),
  );
  mount();
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).not.toContain(
    "private details",
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
  );
  await screen.findByRole("button", { name: "Edit Alpha" });
});

it("confirms removing a provider and does not remove the current provider", async () => {
  mount({
    currentModel: {
      provider: "alpha",
      id: "a",
      name: "Model A",
      label: "Model A",
      current: true,
    },
  });
  const current = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Delete Alpha",
  });
  expect(current.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Beta" }));
  expect(
    WebClient.prototype.changeProviderConfiguration,
  ).not.toHaveBeenCalled();
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(confirm).getByRole("button", { name: i18n.t("providerRemove") }),
  );
  await waitFor(() =>
    expect(
      WebClient.prototype.changeProviderConfiguration,
    ).toHaveBeenCalledWith(
      "session-a",
      "r1",
      { action: "remove", provider: "beta" },
      expect.any(AbortSignal),
    ),
  );
});

it("does not move a delayed save receipt or secret into a replacement session", async () => {
  let resolve!: (value: { saved: true }) => void;
  vi.mocked(WebClient.prototype.saveProviderKey).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = mount();
  await edit();
  change("API key", "private-old-key");
  save();
  view.update({ sessionId: "session-b" });
  await act(async () => resolve({ saved: true }));
  expect(screen.queryByDisplayValue("private-old-key")).toBeNull();
  expect(screen.queryByText("Saved Alpha.")).toBeNull();
});
