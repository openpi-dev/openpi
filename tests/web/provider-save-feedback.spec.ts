// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebProviderAuthProjection } from "../../web/runtime/types.ts";
import { ProviderStatusSection } from "../../web/ui/src/features/settings/ProviderStatusSection.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
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
afterAll(() => {
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

const auth: WebProviderAuthProjection = {
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
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(
  overrides: Partial<Parameters<typeof ProviderStatusSection>[0]> = {},
) {
  const props = {
    sessionId: "session",
    providerId: "alpha",
    active: true,
    onDraftChange: vi.fn(),
    onSavingChange: vi.fn(),
    onSaved: vi.fn(async () => true),
    ...overrides,
  };
  const node = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderStatusSection, props),
    );
  const view = render(node());
  return {
    props,
    rerender(next: Partial<Parameters<typeof ProviderStatusSection>[0]>) {
      Object.assign(props, next);
      view.rerender(node());
    },
  };
}

async function credential() {
  return screen.findByLabelText<HTMLInputElement>(i18n.t("providerApiKey"));
}

it("shows only a fixed load failure and lets the initial load retry", async () => {
  const load = vi
    .spyOn(WebClient.prototype, "providerAuth")
    .mockRejectedValueOnce(new Error("private provider response"))
    .mockResolvedValue(auth);
  setup();
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("providerLoadFailed"),
  );
  expect(screen.queryByText("private provider response")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
  );
  expect((await credential()).value).toBe("");
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps loaded status and the editable form after a safe credential save error", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const save = vi
    .spyOn(WebClient.prototype, "saveProviderKey")
    .mockRejectedValue(new Error("server echoed fixture-not-real-secret"));
  const { props } = setup();
  const input = await credential();
  fireEvent.change(input, { target: { value: "fixture-not-real-secret" } });
  expect(props.onDraftChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
  );
  await screen.findByText(i18n.t("providerSaveFailed"));
  expect(input.value).toBe("");
  expect(input.disabled).toBe(false);
  expect(screen.getByText(i18n.t("credentialMissing"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("providerLoadFailed"))).toBeNull();
  expect(
    screen.queryByText("server echoed fixture-not-real-secret"),
  ).toBeNull();
  expect(props.onDraftChange).toHaveBeenLastCalledWith(false);
  expect(props.onSavingChange).toHaveBeenLastCalledWith(false);
  expect(save).toHaveBeenCalledWith(
    "session",
    "alpha",
    "fixture-not-real-secret",
    expect.any(AbortSignal),
  );
  fireEvent.change(input, { target: { value: "fixture-retry-secret" } });
  expect(screen.queryByText(i18n.t("providerSaveFailed"))).toBeNull();
});

it("retains an unsent credential and loaded status throughout refresh and refresh failure", async () => {
  const next = deferred<WebProviderAuthProjection>();
  const load = vi
    .spyOn(WebClient.prototype, "providerAuth")
    .mockResolvedValueOnce(auth)
    .mockReturnValueOnce(next.promise)
    .mockResolvedValue(auth);
  const { props, rerender } = setup();
  const input = await credential();
  fireEvent.change(input, { target: { value: "fixture-unsent-secret" } });
  rerender({ refreshRevision: 1 });
  expect(input.value).toBe("fixture-unsent-secret");
  expect(screen.getByText(i18n.t("credentialMissing"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("providerLoading"))).toBeNull();
  await act(async () => next.reject(new Error("private refresh response")));
  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("providerLoadFailed"),
  );
  expect(input.value).toBe("fixture-unsent-secret");
  expect(input.disabled).toBe(false);
  expect(props.onDraftChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByText("private refresh response")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  expect(input.value).toBe("fixture-unsent-secret");
});

it("confirms provider changes before discarding an unsent credential", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const { props } = setup();
  const input = await credential();
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: i18n.t("provider"),
  });
  fireEvent.change(input, { target: { value: "fixture-unsent-secret" } });
  fireEvent.change(select, { target: { value: "beta" } });
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(select.value).toBe("alpha");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("keepEditing") }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(input.value).toBe("fixture-unsent-secret");
  expect(props.onDraftChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(select, { target: { value: "beta" } });
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("discardAndContinue") }),
  );
  expect(select.value).toBe("beta");
  expect(input.value).toBe("");
  expect(props.onDraftChange).toHaveBeenLastCalledWith(false);
});

it("disables provider changes while saving and reports the exact save lifetime", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const pending = deferred<{ saved: true }>();
  vi.spyOn(WebClient.prototype, "saveProviderKey").mockReturnValue(
    pending.promise,
  );
  const { props } = setup();
  fireEvent.change(await credential(), {
    target: { value: "fixture-submit-secret" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
  );
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: i18n.t("provider"),
  });
  expect(select.disabled).toBe(true);
  expect(props.onSavingChange).toHaveBeenLastCalledWith(true);
  fireEvent.change(select, { target: { value: "beta" } });
  expect(select.value).toBe("alpha");
  await act(async () => pending.resolve({ saved: true }));
  await screen.findByText(i18n.t("providerKeySaved"));
  expect(select.disabled).toBe(false);
  expect(props.onSavingChange).toHaveBeenLastCalledWith(false);
  expect(props.onSaved).toHaveBeenCalledOnce();
});

it.each(["success", "failure"] as const)(
  "ignores a late %s receipt after an authorized provider change",
  async (outcome) => {
    vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
    const pending = deferred<{ saved: true }>();
    const save = vi
      .spyOn(WebClient.prototype, "saveProviderKey")
      .mockReturnValue(pending.promise);
    const { props, rerender } = setup();
    fireEvent.change(await credential(), {
      target: { value: "fixture-submit-secret" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
    );
    const signal = save.mock.calls[0]?.[3];
    rerender({ providerId: "beta" });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") pending.resolve({ saved: true });
      else pending.reject(new Error("private late response"));
    });
    expect(screen.queryByText(i18n.t("providerKeySaved"))).toBeNull();
    expect(screen.queryByText(i18n.t("providerSaveFailed"))).toBeNull();
    expect(props.onSaved).not.toHaveBeenCalled();
    expect((await credential()).value).toBe("");
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: i18n.t("provider"),
      }).value,
    ).toBe("beta");
  },
);

it("focuses the credential once after entry and does not steal focus during refresh", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const { rerender } = setup({ focusOnOpen: true });
  const input = await credential();
  await waitFor(() => expect(document.activeElement).toBe(input));
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: i18n.t("provider"),
  });
  select.focus();
  rerender({ refreshRevision: 1 });
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(document.activeElement).toBe(select);
});

it("does not request credential focus again when returning to the settings tab", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  render(createElement("button", { type: "button" }, "Models tab"));
  const { rerender } = setup({ focusOnOpen: true });
  const input = await credential();
  await act(async () => frames[0]?.(0));
  expect(document.activeElement).toBe(input);
  rerender({ active: false });
  const tab = screen.getByRole("button", { name: "Models tab" });
  tab.focus();
  rerender({ active: true });
  expect(frames).toHaveLength(1);
  expect(document.activeElement).toBe(tab);
});

it("retains the one-shot entry focus through StrictMode's initial effect cleanup", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue(auth);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const cancelFrame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => {});
  render(
    createElement(
      StrictMode,
      null,
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ProviderStatusSection, {
          sessionId: "session",
          providerId: "alpha",
          active: true,
          focusOnOpen: true,
        }),
      ),
    ),
  );
  const input = await credential();
  expect(cancelFrame).toHaveBeenCalledWith(1);
  await act(async () => frames.at(-1)?.(0));
  expect(document.activeElement).toBe(input);
});

it("does not move focus when the user navigated while entry data was loading", async () => {
  const pending = deferred<WebProviderAuthProjection>();
  vi.spyOn(WebClient.prototype, "providerAuth").mockReturnValue(
    pending.promise,
  );
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  render(createElement("button", { type: "button" }, "Elsewhere"));
  setup({ focusOnOpen: true });
  await act(async () => frames[0]?.(0));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  await act(async () => pending.resolve(auth));
  await credential();
  expect(document.activeElement).toBe(elsewhere);
});

it("focuses the provider selector when the selected provider has no credential input", async () => {
  vi.spyOn(WebClient.prototype, "providerAuth").mockResolvedValue({
    ...auth,
    providers: [{ ...auth.providers[0]!, authMethods: ["oauth"] }],
  });
  setup({ focusOnOpen: true });
  const select = await screen.findByRole<HTMLSelectElement>("combobox", {
    name: i18n.t("provider"),
  });
  await waitFor(() => expect(document.activeElement).toBe(select));
});
