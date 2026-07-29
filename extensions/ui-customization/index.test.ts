import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import uiCustomization, { buildFooterContent } from "./index.ts";
import {
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
} from "../shared/dashboard-state.ts";
import { SETUP_CONFIG_CHANGED_CHANNEL } from "../shared/setup-config.ts";

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
  let setFooterCount = 0;

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
        setFooterCount += 1;
        footerFactory = factory;
      },
      setTitle: () => undefined,
    },
  };
  hooks.get("session_start")?.({}, ctx);

  return {
    listeners,
    hooks,
    ctx,
    setFooterCount: () => setFooterCount,
    render: (statuses: ReadonlyMap<string, string> = new Map()) => {
      assert.ok(footerFactory);
      return footerFactory({ requestRender: () => undefined }, identityTheme, {
        getExtensionStatuses: () => statuses,
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
    cachePercent: 82.4,
    cost: 4.03,
    tokensPerSecond: null,
    generating: false,
  });

  const footer = harness.render().join("\n");
  assert.match(footer, /ctx 1\.0m/);
  assert.doesNotMatch(footer, /\?%/);
});

test("renders only selected footer items", () => {
  const content = buildFooterContent(
    {
      provider: "seal",
      modelId: "gpt-5.6-sol",
      modelName: "GPT-5.6 Sol",
      thinking: "high",
      contextTokens: 250_000,
      contextWindow: 1_000_000,
      contextPercent: 25,
      cachePercent: 82.4,
      cost: 4.03,
      tokensPerSecond: 41,
      generating: false,
    },
    {
      isRepository: true,
      branch: "main",
      changedFiles: 7,
      pullRequest: null,
    },
    ["model", "context", "cache"],
  );

  assert.deepEqual(content, {
    showCwd: false,
    model: "seal/gpt-5.6-sol",
    usage: "25%/1.0m · cache 82%",
    git: "",
  });
});

test("always renders operational activity while custom footer is enabled", () => {
  const footer = createHarness()
    .render(new Map([["subagents", "1 running"]]))
    .join("\n");
  assert.match(footer, /1 running/);
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

test("config change event reinstalls footer for the active session", () => {
  const harness = createHarness();
  const before = harness.setFooterCount();
  harness.listeners.get(SETUP_CONFIG_CHANGED_CHANNEL)?.({});
  assert.ok(harness.setFooterCount() > before);
});

test("session_shutdown clears active session so config events do not reinstall", () => {
  const harness = createHarness();
  harness.hooks.get("session_shutdown")?.({}, harness.ctx);
  const before = harness.setFooterCount();
  harness.listeners.get(SETUP_CONFIG_CHANGED_CHANNEL)?.({});
  assert.equal(harness.setFooterCount(), before);
});
