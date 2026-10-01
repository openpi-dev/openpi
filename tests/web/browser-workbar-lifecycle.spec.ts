// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import type { WorkbarTool } from "../../web/ui/src/features/workbar/types.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

vi.mock("../../web/ui/src/features/files/FilesPanel.tsx", () => ({
  FilesPanel: () => createElement("div", null, "Fixture files"),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function panel({
  visible = true,
  tool = "browser",
  revision = 0,
  sessionPath = "/workspace/a.jsonl",
  canControl = true,
}: {
  visible?: boolean;
  tool?: WorkbarTool;
  revision?: number;
  sessionPath?: string;
  canControl?: boolean;
} = {}) {
  return createElement(
    Providers,
    null,
    createElement(WorkbarPanel, {
      visible,
      requestedTool: tool,
      requestRevision: revision,
      sessionId: "session-a",
      sessionPath,
      canControl,
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

function navigate() {
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
    { target: { value: "https://example.invalid/retained" } },
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
}

it("retains an opened iframe across tools, makes it inert, and disposes it on explicit close", () => {
  const view = render(panel());
  navigate();
  const iframe = view.container.querySelector("iframe")!;
  expect(iframe).not.toBeNull();
  view.rerender(panel({ tool: "files", revision: 1 }));
  expect(screen.getByText("Fixture files").closest("[hidden]")).toBeNull();
  expect(view.container.querySelector("iframe")).toBe(iframe);
  const hiddenBrowser = iframe.closest('[data-tool="browser"]')!;
  expect(hiddenBrowser.hasAttribute("hidden")).toBe(true);
  expect(hiddenBrowser.hasAttribute("inert")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browser") }));
  expect(view.container.querySelector("iframe")).toBe(iframe);
  expect(hiddenBrowser.hasAttribute("hidden")).toBe(false);
  expect(hiddenBrowser.hasAttribute("inert")).toBe(false);
  view.rerender(panel({ visible: false, tool: "files", revision: 2 }));
  expect(view.container.querySelector("iframe")).toBeNull();
  view.rerender(panel({ tool: "files", revision: 2 }));
  // A restored tab list alone cannot reopen a hidden page.
  expect(view.container.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browser") }));
  const reopened = view.container.querySelector("iframe")!;
  expect(reopened).not.toBe(iframe);
  view.rerender(panel({ tool: "files", revision: 3 }));
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("close")} ${i18n.t("browser")}`,
    }),
  );
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(reopened.isConnected).toBe(false);
});

it("releases the old exact Session's browser and never restores it under a changed controller", () => {
  const view = render(panel());
  navigate();
  const iframe = view.container.querySelector("iframe")!;
  view.rerender(panel({ tool: "files", revision: 1 }));
  view.rerender(
    panel({ tool: "files", revision: 1, sessionPath: "/workspace/copy.jsonl" }),
  );
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(iframe.isConnected).toBe(false);
  view.rerender(panel({ tool: "browser", revision: 2, canControl: false }));
  expect(view.container.querySelector("iframe")).toBeNull();
  expect(screen.getByText(i18n.t("toolsRequireCurrentSession"))).not.toBeNull();
});

it("keeps the existing eight-page bound when a browser is hidden behind another tool", () => {
  const view = render(panel());
  for (let index = 0; index < 8; index++) {
    navigate();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("browserAddTab") }),
    );
  }
  const pages = within(
    screen.getByRole("tablist", { name: i18n.t("browserTabs") }),
  );
  expect(pages.getAllByRole("tab")).toHaveLength(8);
  expect(view.container.querySelectorAll("iframe")).toHaveLength(8);
  view.rerender(panel({ tool: "files", revision: 1 }));
  expect(view.container.querySelectorAll("iframe")).toHaveLength(8);
  view.unmount();
  expect(document.querySelectorAll("iframe")).toHaveLength(0);
});
