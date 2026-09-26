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
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebCommandSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { filterWebCommands } from "../../web/ui/src/features/composer/SlashCommandMenu.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  type CommandDiscoveryState,
  createWebStore,
} from "../../web/ui/src/store/web-store.ts";

afterEach(cleanup);

const commands: WebCommandSummary[] = [
  {
    name: "extension:setup",
    description: "Configure an extension",
    source: "extension",
    availability: "unsupported",
  },
  {
    name: "review",
    description: "Review this pull request",
    source: "prompt",
    availability: "available",
    argumentHint: "[arguments]",
  },
  {
    name: "release",
    description: "Prepare a release",
    source: "skill",
    availability: "available",
    argumentHint: "[arguments]",
  },
  {
    name: "ps",
    description: "List background terminals",
    source: "extension",
    availability: "available",
    action: "terminal",
  },
  {
    name: "btw",
    description: "Keeps working while asking a side question",
    source: "extension",
    availability: "available",
    action: "side-conversation",
  },
  {
    name: "openpi-setup",
    description: "Configure OpenPI",
    source: "extension",
    availability: "available",
    argumentHint: "[request]",
  },
];

function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-09T00:00:00Z",
    cursor: 1,
    currentSessionId: "session-1",
    currentSessionPath: "/tmp/workspace/session.jsonl",
    workspaces: [{ path: "/tmp/workspace", name: "Workspace", current: true }],
    sessions: [],
    selectedSession: {
      id: "session-1",
      path: "/tmp/workspace/session.jsonl",
      cwd: "/tmp/workspace",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2 * 1024 * 1024,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

function renderComposer(
  options: {
    draft?: boolean;
    landing?: boolean;
    commandDiscovery?: Partial<CommandDiscoveryState>;
    onCommandAction?: (
      action: NonNullable<WebCommandSummary["action"]>,
    ) => boolean;
  } = {},
) {
  const store = createWebStore();
  const discoverCommands = vi.fn(async () => {});
  const sendPrompt = vi.fn(async () => true);
  const onCommandAction = options.onCommandAction ?? vi.fn(() => true);
  const props = {
    snapshot: snapshot(),
    selectedWorkspace: "/tmp/workspace",
    workspaceDraft: options.draft ?? false,
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: options.landing ?? false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    onCommandAction,
    commandDiscovery: {
      sessionId: "session-1",
      status: "ready" as const,
      commands,
      totalAvailable: commands.length,
      commandsOmitted: 0,
      error: null,
      ...options.commandDiscovery,
    },
    actions: {
      ...store.getState().actions,
      discoverCommands,
      sendPrompt,
    },
  };
  render(
    createElement(I18nextProvider, { i18n }, createElement(Composer, props)),
  );
  return { discoverCommands, sendPrompt, onCommandAction };
}

function enterCommand(value: string) {
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.focus(input);
  fireEvent.change(input, {
    target: { value, selectionStart: value.length },
  });
  return input;
}

describe("Web slash command discovery", () => {
  it("lists runnable commands first and keeps unsupported commands discoverable", () => {
    expect(filterWebCommands(commands, "").map((item) => item.name)).toEqual([
      "review",
      "release",
      "ps",
      "btw",
      "openpi-setup",
      "extension:setup",
    ]);
    expect(
      filterWebCommands(commands, "review").map((item) => item.name),
    ).toEqual(["review"]);
    expect(
      filterWebCommands(commands, "configure").map((item) => item.name),
    ).toEqual(["openpi-setup", "extension:setup"]);
    expect(
      filterWebCommands(commands, "skill").map((item) => item.name),
    ).toEqual(["release"]);
    expect(filterWebCommands(commands, "ps").map((item) => item.name)).toEqual([
      "ps",
    ]);
  });

  it("shows a loading state while commands are being discovered", () => {
    renderComposer({ commandDiscovery: { status: "loading", commands: [] } });
    enterCommand("/");

    expect(screen.getByText(i18n.t("commandsLoading"))).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows an explicit empty state when no command matches", () => {
    renderComposer();
    enterCommand("/missing-command");

    expect(screen.getByText(i18n.t("commandsNoMatch"))).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the command and its reason instead of an empty dead end when all commands are unsupported", () => {
    renderComposer({
      commandDiscovery: { commands: [commands[0]!], totalAvailable: 1 },
    });
    enterCommand("/");

    expect(
      screen.getByRole<HTMLButtonElement>("option", {
        name: /extension:setup/u,
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByText(i18n.t("commandUnavailable_not_integrated")),
    ).toBeTruthy();
    expect(screen.queryByText(i18n.t("commandsNoAvailable"))).toBeNull();
  });

  it("keeps no-match distinct when all discovered commands are unsupported", () => {
    renderComposer({
      commandDiscovery: { commands: [commands[0]!], totalAvailable: 1 },
    });
    enterCommand("/missing-command");

    expect(screen.getByText(i18n.t("commandsNoMatch"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("commandsNoAvailable"))).toBeNull();
  });

  it("shows command discovery errors separately from an empty result", () => {
    renderComposer({
      commandDiscovery: {
        status: "error",
        commands: [],
        error: "discovery failed",
      },
    });
    enterCommand("/");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(i18n.t("commandsUnavailable"));
    expect(alert.textContent).toContain("discovery failed");
    expect(screen.queryByText(i18n.t("commandsNoMatch"))).toBeNull();
  });

  it("completes a prompt template without submitting it", () => {
    const { discoverCommands, sendPrompt } = renderComposer();
    const input = enterCommand("/rev");

    expect(
      screen.getByRole("listbox", { name: i18n.t("commands") }),
    ).toBeTruthy();
    expect(discoverCommands).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("/review ");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports arrow navigation, Tab completion, Escape, and pointer completion", () => {
    const { sendPrompt } = renderComposer();
    const input = enterCommand("/");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/release ");
    expect(sendPrompt).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/", selectionStart: 1 } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.blur(input);
    fireEvent.focus(input);
    fireEvent.click(screen.getByRole("option", { name: /\/review/u }));
    expect(input.value).toBe("/review ");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("scrolls the keyboard-active command to the nearest visible edge", () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderComposer();
      const input = enterCommand("/");
      scrollIntoView.mockClear();
      fireEvent.keyDown(input, { key: "ArrowDown" });

      expect(input.getAttribute("aria-activedescendant")).toBe(
        "openpi-slash-command-1",
      );
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("shows extension commands as disabled and cannot complete them", () => {
    const { sendPrompt } = renderComposer();
    const input = enterCommand("/extension");
    const option = screen.getByRole<HTMLButtonElement>("option", {
      name: /\/extension:setup/u,
    });

    expect(option.disabled).toBe(true);
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(i18n.t("commandUnsupported"));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("/extension");
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not request commands for a draft workspace", () => {
    const { discoverCommands } = renderComposer({ draft: true });
    enterCommand("/");

    expect(screen.getByText(i18n.t("commandSessionRequired"))).toBeTruthy();
    expect(discoverCommands).not.toHaveBeenCalled();
  });

  it.each([
    ["ps", "terminal"],
    ["lg", "review"],
    ["subagents", "subagents"],
    ["usage", "runtime"],
    ["btw", "side-conversation"],
  ] as const)(
    "completes then opens /%s without sending a model prompt",
    (name, action) => {
      const { sendPrompt, onCommandAction } = renderComposer({
        commandDiscovery: {
          commands: [
            { name, source: "extension", availability: "available", action },
          ],
        },
      });
      const input = enterCommand(`/${name}`);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe(`/${name} `);
      expect(onCommandAction).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommandAction).toHaveBeenCalledWith(action);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    },
  );

  it("keeps panel command arguments and attachments instead of dropping them", async () => {
    const { sendPrompt, onCommandAction } = renderComposer();
    const input = enterCommand("/ps retain these arguments");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("commandPanelArguments"),
    );
    expect(input.value).toBe("/ps retain these arguments");
    fireEvent.change(input, { target: { value: "/ps " } });
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "image.png",
      { type: "image/png" },
    );
    fireEvent.change(
      input.closest("form")!.querySelector('input[type="file"]')!,
      { target: { files: [file] } },
    );
    await waitFor(() => expect(screen.getByText("image.png")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("commandPanelArguments"),
    );
    expect(screen.getByText("image.png")).toBeTruthy();
    expect(input.value).toBe("/ps ");
    expect(onCommandAction).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("retains the command if its panel cannot open", () => {
    const action = vi.fn(() => false);
    const { sendPrompt } = renderComposer({ onCommandAction: action });
    const input = enterCommand("/ps ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(action).toHaveBeenCalledWith("terminal");
    expect(input.value).toBe("/ps ");
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("commandPanelUnavailable"),
    );
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("executes canonical setup through Pi and rejects unsupported commands with arguments", () => {
    const { sendPrompt } = renderComposer();
    const input = enterCommand("/extension:setup inspect this");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain(
      i18n.t("commandUnavailable_not_integrated"),
    );
    expect(sendPrompt).not.toHaveBeenCalled();
    fireEvent.change(input, {
      target: { value: "/openpi-setup inspect settings" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).toHaveBeenCalledWith("/openpi-setup inspect settings");
  });
});
