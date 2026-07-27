import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import uiCustomization from "./index.ts";
import {
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
} from "../shared/dashboard-state.ts";

const identityTheme = {
  fg: (_name: string, text: string) => text,
};

function createHarness() {
  const listeners = new Map<string, (value: unknown) => void>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  let footerFactory:
    | ((
        tui: unknown,
        theme: typeof identityTheme,
        data: unknown,
      ) => {
        render(width: number): string[];
      })
    | undefined;

  const api = {
    events: {
      on: (channel: string, listener: (value: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
      emit: () => undefined,
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      hooks.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  uiCustomization(api);

  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    ui: {
      setHeader: () => undefined,
      setFooter: (factory: typeof footerFactory) => {
        footerFactory = factory;
      },
      setTitle: () => undefined,
    },
  };
  hooks.get("session_start")?.({}, ctx);

  return {
    listeners,
    render: () => {
      assert.ok(footerFactory);
      return footerFactory({ requestRender: () => undefined }, identityTheme, {
        getExtensionStatuses: () => new Map(),
      }).render(120);
    },
  };
}

test("shows context capacity without a misleading unknown percentage", () => {
  const harness = createHarness();
  harness.listeners.get(MODEL_INFO_CHANNEL)?.({
    provider: "seal",
    modelId: "gpt-5.6-sol",
    modelName: "GPT-5.6 Sol",
    thinking: "high",
    contextTokens: null,
    contextWindow: 1_000_000,
    contextPercent: null,
    cost: 4.03,
    tokensPerSecond: null,
    generating: false,
  });

  const footer = harness.render().join("\n");
  assert.match(footer, /ctx 1\.0m/);
  assert.doesNotMatch(footer, /\?%/);
});

test("shows the branch but omits changed-file counts", () => {
  const harness = createHarness();
  harness.listeners.get(GIT_INFO_CHANNEL)?.({
    isRepository: true,
    branch: "main",
    changedFiles: 7,
    pullRequest: null,
  });

  const footer = harness.render().join("\n");
  assert.match(footer, /main/);
  assert.doesNotMatch(footer, /files? changed|7 files/);
});
