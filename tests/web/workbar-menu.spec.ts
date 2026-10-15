// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import type { WorkbarTool } from "../../web/ui/src/features/workbar/types.ts";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
vi.mock("../../web/ui/src/features/files/FilesPanel.tsx", () => ({
  FilesPanel: () => createElement("div", null, "Fixture files"),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function panel(
  tool: WorkbarTool = "browser",
  revision = 0,
  { visible = true, sessionPath = "/workspace/a.jsonl" } = {},
) {
  return createElement(
    Providers,
    null,
    createElement(WorkbarPanel, {
      visible,
      requestedTool: tool,
      requestRevision: revision,
      sessionId: "session-a",
      sessionPath,
      cwd: "/workspace",
      capabilities: {},
      review: {
        result: null,
        loading: false,
        error: null,
        refresh: async () => {},
      },
      conversationCollapsed: false,
      onRestoreConversation: () => {},
      onClose: () => {},
    }),
  );
}

function tab(name: string) {
  return within(
    screen.getByRole("toolbar", { name: i18n.t("openTools") }),
  ).getByRole<HTMLButtonElement>("button", { name });
}

async function menuItem(name: string) {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("openTools") }));
  const launcher = await screen.findByRole("menu");
  return within(launcher).getByRole("menuitem", {
    name: new RegExp(`^${name}`),
  });
}

function navigate() {
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
    { target: { value: "https://example.invalid/menu-retained" } },
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
}

it.each(["active", "inactive"])(
  "returns focus to the surviving tab when the focused %s tab is closed",
  async (kind) => {
    const view = render(panel());
    navigate();
    const frame = view.container.querySelector("iframe");
    view.rerender(panel("files", 1));
    if (kind === "inactive") fireEvent.click(tab(i18n.t("browser")));
    const close = screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("files")}`,
    });
    close.focus();
    fireEvent.click(close);
    const remaining = tab(i18n.t("browser"));
    expect(remaining.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector("iframe")).toBe(frame);
    await waitFor(() => expect(document.activeElement).toBe(remaining));
  },
);

it("returns focus to Open tools after the focused final tab is closed", async () => {
  render(panel());
  const close = screen.getByRole("button", {
    name: `${i18n.t("close")} ${i18n.t("browser")}`,
  });
  close.focus();
  fireEvent.click(close);
  expect(screen.queryByRole("toolbar")).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: i18n.t("openTools") }),
    ),
  );
});

it("does not transfer close focus away from an outside draft", () => {
  const view = render(panel());
  view.rerender(panel("files", 1));
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("files")}`,
    }),
  );
  expect(document.activeElement).toBe(input);
  input.remove();
});

it("keeps an input in the active tool focused when an unrelated close does not own focus", async () => {
  const view = render(panel());
  view.rerender(panel("files", 1));
  fireEvent.click(tab(i18n.t("browser")));
  const address = screen.getByRole("textbox", {
    name: i18n.t("browserAddress"),
  });
  address.focus();
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("files")}`,
    }),
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(document.activeElement).toBe(address);
});

it.each(["hidden", "scope", "unmount", "outside focus"])(
  "cancels pending close focus after %s",
  (change) => {
    const view = render(panel());
    view.rerender(panel("files", 1));
    const close = screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("files")}`,
    });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    close.focus();
    fireEvent.click(close);
    expect(frames.size).toBeGreaterThan(0);
    if (change === "unmount") view.unmount();
    else if (change !== "outside focus")
      view.rerender(
        panel("browser", 1, {
          visible: change !== "hidden",
          sessionPath:
            change === "scope" ? "/workspace/copy.jsonl" : "/workspace/a.jsonl",
        }),
      );
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    for (const callback of frames.values()) callback(0);
    expect(document.activeElement).toBe(input);
    input.remove();
  },
);

it("reactivates an already opened inactive tool from the full launcher without replacing its iframe", async () => {
  const view = render(panel());
  navigate();
  const frame = view.container.querySelector("iframe");
  const browserTab = tab(i18n.t("browser"));
  view.rerender(panel("files", 1));
  const row = await menuItem(i18n.t("browser"));
  expect(row.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(row);

  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(browserTab.getAttribute("aria-pressed")).toBe("true");
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(frame?.closest("[hidden]")).toBeNull();
  expect(view.container.querySelectorAll('[data-tool="browser"]')).toHaveLength(
    1,
  );
  await waitFor(() => expect(document.activeElement).toBe(browserTab));
});

it("lets the currently active tool dismiss the launcher and focus its existing tab repeatedly", async () => {
  const view = render(panel());
  navigate();
  const frame = view.container.querySelector("iframe");
  const browserTab = tab(i18n.t("browser"));
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await menuItem(i18n.t("browser"));
    expect(row.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(browserTab.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector("iframe")).toBe(frame);
    await waitFor(() => expect(document.activeElement).toBe(browserTab));
  }
  expect(view.container.querySelectorAll('[data-tool="browser"]')).toHaveLength(
    1,
  );
});

it("activates a newly opened tool and focuses the newly committed tab", async () => {
  render(panel());
  const row = await menuItem(i18n.t("files"));
  expect(row.querySelector(".lucide-check")).toBeNull();
  row.focus();
  fireEvent.click(row);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const filesTab = tab(i18n.t("files"));
  expect(filesTab.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Fixture files").closest("[hidden]")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(filesTab));
});

it("focuses the selected Review tab after its panel's initial reading focus", async () => {
  render(panel());
  fireEvent.click(await menuItem(i18n.t("changeEvidence")));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  const reviewTab = tab(i18n.t("changeEvidence"));
  expect(reviewTab.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(reviewTab));
});

it("dismisses the full launcher with Escape and focuses the previously active tool", async () => {
  render(panel());
  const row = await menuItem(i18n.t("files"));
  row.focus();
  fireEvent.keyDown(row, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(tab(i18n.t("browser")).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByText("Fixture files")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(tab(i18n.t("browser"))),
  );
});

it.each(["hidden", "scope", "unmount", "outside focus"])(
  "cancels pending menu focus when the Workbar is %s",
  async (change) => {
    const view = render(panel());
    const row = await menuItem(i18n.t("files"));
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    fireEvent.click(row);
    expect(frames.size).toBeGreaterThan(0);
    if (change === "unmount") view.unmount();
    else if (change !== "outside focus")
      view.rerender(
        panel("browser", 0, {
          visible: change !== "hidden",
          sessionPath:
            change === "scope" ? "/workspace/copy.jsonl" : "/workspace/a.jsonl",
        }),
      );
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    for (const callback of frames.values()) callback(0);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  },
);
