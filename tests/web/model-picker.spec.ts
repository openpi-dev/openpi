// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { ModelPicker } from "../../web/ui/src/features/composer/ModelPicker.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

const models = [
  {
    provider: "seal",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    label: "DeepSeek V4 Flash",
    current: true,
    contextWindow: 256_000,
    reasoning: true,
    imageInput: true,
  },
  {
    provider: "seal",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    label: "GPT-5.6 Sol",
    current: false,
    contextWindow: 1_000_000,
  },
  {
    provider: "managed:kimi-code",
    id: "k3",
    name: "K3",
    label: "K3",
    current: false,
    contextWindow: 1_048_576,
    reasoning: true,
  },
];

function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-17T10:00:00Z",
    cursor: 1,
    currentSessionId: "session",
    preferences: { theme: "system" },
    workspaces: [],
    sessions: [],
    models,
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4_000_000,
      bytes: 0,
    },
  };
}

function renderPicker(
  overrides: { selectModel?: (ref: string) => Promise<void> } = {},
) {
  const store = createWebStore();
  const actions = {
    ...store.getState().actions,
    ...(overrides.selectModel ? { selectModel: overrides.selectModel } : {}),
  };
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelPicker, {
        snapshot: snapshot(),
        currentModel: models[0],
        draftModel: null,
        modelSearch: store.getState().modelSearch,
        modelSelectionPending: false,
        promptAdmissionPending: false,
        sessionSwitching: false,
        liveRunning: false,
        workspaceDraft: true,
        actions,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "DeepSeek V4 Flash (seal/deepseek-v4-flash)",
    }),
  );
}

afterEach(cleanup);

it("always offers search and filters loaded models client-side", async () => {
  const store = createWebStore();
  const searchModels = vi.fn(async (_query: string) => {});
  const actions = { ...store.getState().actions, searchModels };
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ModelPicker, {
        snapshot: snapshot(),
        currentModel: models[0],
        draftModel: null,
        modelSearch: store.getState().modelSearch,
        modelSelectionPending: false,
        promptAdmissionPending: false,
        sessionSwitching: false,
        liveRunning: false,
        workspaceDraft: true,
        actions,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "DeepSeek V4 Flash (seal/deepseek-v4-flash)",
    }),
  );

  const input = await screen.findByPlaceholderText(
    "Search provider, model name, or ID...",
  );
  fireEvent.change(input, { target: { value: "kimi" } });
  expect(screen.queryByRole("option", { name: /GPT-5.6 Sol/u })).toBeNull();
  expect(screen.getByRole("option", { name: /K3/u })).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(searchModels).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: "no-such-model" } });
  expect(screen.getByText("No matching models")).toBeTruthy();
});

it("filters the list through provider chips", async () => {
  renderPicker();
  fireEvent.click(
    await screen.findByRole("button", { name: "managed:kimi-code" }),
  );
  expect(screen.queryByRole("option", { name: /GPT-5.6 Sol/u })).toBeNull();
  expect(screen.getByRole("option", { name: /K3/u })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByRole("option", { name: /GPT-5.6 Sol/u })).toBeTruthy();
});

it("renders context window and capability metadata for each model", async () => {
  renderPicker();
  expect(
    await screen.findByText("seal · 256k ctx · Reasoning · Image input"),
  ).toBeTruthy();
  expect(
    screen.getByText("managed:kimi-code · 1M ctx · Reasoning"),
  ).toBeTruthy();
  expect(screen.getByText("seal · 1M ctx")).toBeTruthy();
});

it("selects an option through the store action", async () => {
  const selectModel = vi.fn(async (_ref: string) => {});
  renderPicker({ selectModel });
  fireEvent.click(await screen.findByRole("option", { name: /K3/u }));
  expect(selectModel).toHaveBeenCalledWith("managed:kimi-code/k3");
});

it("moves focus from the search input into the options", async () => {
  renderPicker();
  const input = await screen.findByPlaceholderText(
    "Search provider, model name, or ID...",
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const first = screen.getByRole("option", {
    name: "DeepSeek V4 Flash (seal/deepseek-v4-flash)",
  });
  expect(document.activeElement).toBe(first);
});
