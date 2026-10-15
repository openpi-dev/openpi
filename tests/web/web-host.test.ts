import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fsPromises, {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { WEB_TURN_TIMING_ENTRY } from "../../web/protocol/turn-timing.ts";
import {
  registerWebCapability,
  registerWebCapabilityActions,
} from "../../extensions/shared/web-observer-registry.ts";
import {
  PiWebAdapter,
  WEB_SESSION_MARKDOWN_MAX_BYTES,
} from "../../web/adapter/pi-adapter.ts";
import type { GitReviewService } from "../../web/host/git-review.ts";
import {
  InteractiveTerminalManager,
  type InteractiveTerminalService,
} from "../../web/host/interactive-terminal.ts";
import type { WebHostOptions } from "../../web/host/web-host.ts";
import {
  WEB_PROMPT_IMAGE_MAX_BYTES,
  WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES,
  WEB_PROMPT_MAX_TEXT_LENGTH,
  type WebInteractiveTerminalEvent,
} from "../../web/protocol/types.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import { WebProviderLoginService } from "../../web/runtime/provider-login.ts";
import {
  type WebRuntimeController,
  type WebRuntimeEvent,
  WebRuntimeRequestError,
  type WebSessionDeleteResult,
} from "../../web/runtime/types.ts";

// Setup paths are resolved when the Host imports the shared config module.
// Never make snapshot/theme assertions depend on the developer's preferences.
const hostAgentDirectory = await mkdtemp(join(tmpdir(), "openpi-host-agent-"));
const previousHostAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = hostAgentDirectory;
const { WebHost } = await import("../../web/host/web-host.ts");
const {
  loadSetupConfig,
  formatSetupConfig,
  updateSetupConfig,
  DEFAULT_WEB_APPEARANCE,
} = await import("../../extensions/shared/setup-config.ts");
after(async () => {
  if (previousHostAgentDirectory === undefined)
    delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousHostAgentDirectory;
  await rm(hostAgentDirectory, { recursive: true, force: true });
});

test("browser preferences require setup and native credentials cannot authorize Web APIs", async () => {
  const path = join(hostAgentDirectory, "my-pi-setup.json");
  const before = await readFile(path, "utf8").catch(() => undefined);
  const cwd = await mkdtemp(join(tmpdir(), "openpi-browser-host-"));
  const runtime = testRuntime(cwd);
  runtime.isIdle = () => false;
  let applied = 0;
  let prompted = 0;
  runtime.applySetupConfiguration = async () => {
    applied++;
  };
  runtime.sendPrompt = async () => {
    prompted++;
    return { pendingFollowUps: 0 };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const controller = "795239cc-8ff9-49cb-9894-e16b3ba86af7";
  const post = (
    route: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${launched.origin}${route}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-OpenPI-Web-Controller": controller,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    for (const body of [
      { externalBrowsers: ["unknown-browser"] },
      { defaultBrowser: "shell" },
      { command: "open" },
      { control: "true" },
      { embedded: null },
      { externalBrowsers: ["chrome", "chrome"] },
    ])
      assert.equal((await post("/api/settings/browser", body)).status, 400);
    for (const body of [
      { browser: "chrome", action: "install" },
      { browser: "chrome", action: "folder", path: "/arbitrary" },
      {
        browser: "chrome",
        action: "connect",
        url: "https://arbitrary.example",
      },
      { browser: "shell", action: "manage" },
    ])
      assert.equal(
        (await post("/api/settings/browser/action", body)).status,
        400,
      );
    const saved = await post("/api/settings/browser", {
      control: true,
      defaultBrowser: "chrome",
      externalBrowsers: ["chrome"],
    });
    assert.equal(saved.status, 403);
    assert.match((await saved.json()).error, /\/openpi-setup/);
    assert.equal(loadSetupConfig().browser.control, false);
    assert.equal(loadSetupConfig().browser.defaultBrowser, "embedded");
    assert.deepEqual(loadSetupConfig().browser.externalBrowsers, []);
    assert.equal(applied, 0);
    assert.equal(prompted, 0);
    // Simulate the canonical setup writer for the transport authorization checks.
    await updateSetupConfig((current) => ({
      ...current,
      browser: {
        ...current.browser,
        control: true,
        defaultBrowser: "chrome",
        externalBrowsers: ["chrome"],
      },
    }));
    const identity = {
      browser: "chrome",
      profileId: controller,
      extensionId: "a".repeat(32),
      version: "0.3.0",
    };
    assert.equal(
      (
        await post("/api/browser/connections", {
          ...identity,
          browser: "unknown",
        })
      ).status,
      400,
    );
    const paired = await post("/api/browser/connections", identity);
    assert.equal(paired.status, 200);
    const connection = await paired.json();
    const scoped = {
      Authorization: `Bearer ${connection.token}`,
      Origin: `chrome-extension://${identity.extensionId}`,
    };
    const route = `/api/browser/native?connectionId=${connection.connectionId}`;
    assert.equal(
      (
        await post(
          route,
          { pages: [] },
          { ...scoped, Origin: "https://foreign.example" },
        )
      ).status,
      401,
    );
    assert.equal((await post(route, { pages: [] }, scoped)).status, 200);
    const page = {
      id: "wrong-connection/1",
      document: controller,
      title: "No",
      url: "https://example.com/",
    };
    assert.equal((await post(route, { pages: [page] }, scoped)).status, 400);
    const nativePage = {
      ...page,
      id: `${connection.connectionId}/123`,
      document: "C172E720FA2F839B12DE8D2D9E5709F0",
    };
    assert.equal(
      (await post(route, { pages: [nativePage] }, scoped)).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/snapshot`, {
          headers: { Authorization: scoped.Authorization },
        })
      ).status,
      401,
    );
    assert.equal(
      (await post("/api/settings/browser", { control: false }, scoped)).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/settings/browser/action",
          { browser: "chrome", action: "folder" },
          scoped,
        )
      ).status,
      403,
    );
    const revoked = await post("/api/settings/browser", { control: false });
    assert.equal(revoked.status, 403);
    assert.equal(loadSetupConfig().browser.control, true);
    await updateSetupConfig((current) => ({
      ...current,
      browser: { ...current.browser, control: false },
    }));
    host.publish("settings_changed", {});
    const polling = await post(route, { pages: [] }, scoped);
    assert.equal((await polling.json()).enabled, false);
    assert.equal(applied, 0);
    assert.equal(prompted, 0);
  } finally {
    await host.stop();
    if (before === undefined) await rm(path, { force: true });
    else await writeFile(path, before);
    await rm(cwd, { force: true, recursive: true });
  }
});

test("appearance writes preserve package config, reject extra authority, and never prompt the agent", async () => {
  const path = join(hostAgentDirectory, "my-pi-setup.json");
  const original = await readFile(path, "utf8").catch(() => undefined);
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-appearance-"));
  const runtime = testRuntime(cwd);
  runtime.isIdle = () => false;
  let prompts = 0;
  runtime.sendPrompt = async () => {
    prompts++;
    return { pendingFollowUps: 0 };
  };
  const before = {
    ...loadSetupConfig(),
    configVersion: 1,
    futureSetting: { keep: true },
  };
  await writeFile(path, JSON.stringify(before));
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    const post = (
      body: unknown,
      headers: Record<string, string> = { Authorization: `Bearer ${token}` },
    ) =>
      fetch(`${launched.origin}/api/settings/preferences`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ theme: "dark" }, {})).status, 401);
    assert.equal(
      (
        await post(
          { theme: "dark" },
          {
            Authorization: `Bearer ${token}`,
            Origin: "https://foreign.example",
          },
        )
      ).status,
      403,
    );
    for (const body of [
      {},
      { workflows: { concurrency: 64 } },
      { theme: ["dark"] },
      { theme: null },
      { appearance: null },
      { appearance: {} },
      {
        theme: "light",
        appearance: { ...DEFAULT_WEB_APPEARANCE, unknown: true },
      },
      { appearance: { ...DEFAULT_WEB_APPEARANCE, palette: "unknown" } },
      { appearance: { ...DEFAULT_WEB_APPEARANCE, font: "unknown" } },
      { appearance: { ...DEFAULT_WEB_APPEARANCE, accent: "#123" } },
      { appearance: { ...DEFAULT_WEB_APPEARANCE, background: "red" } },
      { appearance: { ...DEFAULT_WEB_APPEARANCE, foreground: "#12345678" } },
      { chatWidth: 819 },
      { chatWidth: 2001 },
      { chatWidth: "1040" },
      { sidebarWidth: 219 },
      { sidebarWidth: 521 },
      { auxiliaryWidth: 359 },
      { auxiliaryWidth: 721 },
      { sidebarWidth: "320" },
      { auxiliaryWidth: 520.5 },
      { chatFontSize: 12.5 },
      { expandThinking: "true" },
      { pinnedSort: "unknown" },
      { sidebarGrouping: "connection" },
      { chatsSort: "updated_at" },
      { projectsInRecents: "false" },
      { subagentResultDisplay: "unknown" },
      { bashToolDisplay: true },
      { fileMutationDisplay: null },
      { customFooter: "false" },
      { footerStyle: "compact" },
    ]) {
      assert.equal((await post(body)).status, 400);
      assert.equal(await readFile(path, "utf8"), JSON.stringify(before));
    }
    const appearance = {
      palette: "mist",
      accent: "#123aBC",
      background: "#F0F0F0",
      foreground: "",
      font: "mono",
    };
    const saved = await post({
      theme: "dark",
      appearance,
      chatWidth: 1040,
      sidebarWidth: 320,
      auxiliaryWidth: 600,
      chatFontSize: 16,
      expandThinking: true,
      pinnedSort: "updated",
      sidebarGrouping: "list",
      chatsSort: "manual",
      projectsInRecents: false,
      subagentResultDisplay: "full",
      bashToolDisplay: "full",
      fileMutationDisplay: "full",
      customFooter: false,
      footerStyle: "powerline-mono",
    });
    assert.equal(saved.status, 200);
    const savedSetup = (await saved.json()).setup;
    assert.equal(savedSetup.ui.webChatWidth, 1040);
    assert.deepEqual(savedSetup.ui.webAppearance, appearance);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(after, {
      ...before,
      ui: {
        ...before.ui,
        webTheme: "dark",
        webAppearance: appearance,
        webChatWidth: 1040,
        webSidebarWidth: 320,
        webAuxiliaryWidth: 600,
        webChatFontSize: 16,
        webExpandThinking: true,
        webPinnedSort: "updated",
        webSidebarGrouping: "list",
        webChatsSort: "manual",
        webProjectsInRecents: false,
        subagentResultDisplay: "full",
        bashToolDisplay: "full",
        fileMutationDisplay: "full",
        customFooter: false,
        footerStyle: "powerline-mono",
      },
    });
    const status = formatSetupConfig(loadSetupConfig());
    assert.match(status, /Subagent results: full by default/u);
    assert.match(status, /Bash operations: expanded by default/u);
    assert.match(status, /Write\/Edit operations: expanded by default/u);
    assert.match(status, /custom footer off/u);
    assert.match(
      status,
      /sidebar list \/ chats manual \/ pinned updated \/ projects in recents off/u,
    );
    // Concurrent partial edits share the existing lock and preserve one another.
    const concurrent = await Promise.all([
      post({ chatWidth: 1200 }),
      post({ chatFontSize: 18 }),
    ]);
    assert.ok(concurrent.every((response) => response.status === 200));
    assert.equal(loadSetupConfig().ui.webChatWidth, 1200);
    assert.equal(loadSetupConfig().ui.webChatFontSize, 18);
    assert.equal(loadSetupConfig().ui.webPinnedSort, "updated");
    assert.equal(prompts, 0);
    assert.equal(runtime.sessionManager.getEntries().length, 0);
    const snapshot = await fetch(`${launched.origin}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const preferences = (await snapshot.json()).preferences;
    assert.deepEqual(preferences.appearance, appearance);
    assert.equal(preferences.chatWidth, 1200);
    assert.equal(preferences.sidebarWidth, 320);
    assert.equal(preferences.auxiliaryWidth, 600);
    assert.equal(preferences.subagentResultDisplay, "full");
    assert.equal(preferences.bashToolDisplay, "full");
    assert.equal(preferences.fileMutationDisplay, "full");
    assert.equal(preferences.sidebarGrouping, "list");
    assert.equal(preferences.chatsSort, "manual");
    assert.equal(preferences.projectsInRecents, false);
    // Each browser sends its field intent, so an older view cannot resend
    // another window's accent, mode or hidden-level snapshot.
    const partial = await Promise.all([
      post({ appearance: { accent: "#112233" } }),
      post({ appearance: { font: "serif" } }),
      post({ theme: "light" }),
      post({ thinkingLevelVisibility: { level: "low", visible: false } }),
      post({ thinkingLevelVisibility: { level: "high", visible: false } }),
    ]);
    assert.ok(partial.every((response) => response.status === 200));
    assert.deepEqual(loadSetupConfig().ui.webAppearance, {
      ...appearance,
      accent: "#112233",
      font: "serif",
    });
    assert.equal(loadSetupConfig().ui.webTheme, "light");
    assert.deepEqual(
      new Set(loadSetupConfig().ui.webHiddenThinkingLevels),
      new Set(["low", "high"]),
    );
    assert.equal(
      (await post({ thinkingLevelVisibility: { level: "low", visible: true } }))
        .status,
      200,
    );
    assert.deepEqual(loadSetupConfig().ui.webHiddenThinkingLevels, ["high"]);
    for (const body of [
      { thinkingLevelVisibility: null },
      { thinkingLevelVisibility: { level: "unknown", visible: false } },
      { thinkingLevelVisibility: { level: "high", visible: "false" } },
      {
        thinkingLevelVisibility: { level: "high", visible: false, extra: true },
      },
      {
        thinkingLevelVisibility: { level: "high", visible: false },
        hiddenThinkingLevels: [],
      },
    ])
      assert.equal((await post(body)).status, 400);
    // Legacy palettes migrate under the same lock when mode/palette changes.
    for (const legacy of ["mist", "rose", "pine"] as const) {
      assert.equal(
        (await post({ theme: legacy, appearance: DEFAULT_WEB_APPEARANCE }))
          .status,
        200,
      );
      assert.equal((await post({ appearance: { font: "mono" } })).status, 200);
      assert.equal(loadSetupConfig().ui.webTheme, legacy);
      assert.equal((await post({ theme: "dark" })).status, 200);
      assert.equal(loadSetupConfig().ui.webTheme, "dark");
      assert.deepEqual(loadSetupConfig().ui.webAppearance, {
        ...DEFAULT_WEB_APPEARANCE,
        palette: legacy,
        font: "mono",
      });
      assert.equal(
        (await post({ theme: legacy, appearance: DEFAULT_WEB_APPEARANCE }))
          .status,
        200,
      );
      assert.equal(
        (await post({ appearance: { palette: "rose" } })).status,
        200,
      );
      assert.equal(
        loadSetupConfig().ui.webTheme,
        legacy === "pine" ? "dark" : "light",
      );
      assert.equal(loadSetupConfig().ui.webAppearance.palette, "rose");
    }
    await writeFile(path, "{invalid-private-config");
    const blocked = await post({
      theme: "light",
      appearance: DEFAULT_WEB_APPEARANCE,
    });
    assert.equal(blocked.status, 422);
    assert.ok(!(await blocked.text()).includes("invalid-private-config"));
    assert.equal(await readFile(path, "utf8"), "{invalid-private-config");
  } finally {
    await host.stop();
    if (original !== undefined) await writeFile(path, original);
    else await rm(path, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

function mutationSessionPath(manager: WebRuntimeController["sessionManager"]) {
  return manager.getSessionFile() ?? `current:${manager.getSessionId()}`;
}

function persistHostConversation(manager: SessionManager, content: string) {
  manager.appendMessage({ role: "user", content, timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Saved reply" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
}

// Use a raw document request: fetch always sets Sec-Fetch-Mode to cors.
function documentRequest(url: string, headers: Record<string, string> = {}) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: responseHeaders,
          }),
        );
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("serves workspaces through a runtime isolated from terminal sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-host-"));
  const imported = await mkdtemp(join(tmpdir(), "openpi-web-import-"));
  let runtimeCwd = cwd;
  let sessionManager = SessionManager.inMemory(cwd);
  const unregister = registerWebCapability(sessionManager, {
    kind: "workflows",
    snapshot: () => ({
      items: [
        {
          runId: "wf-test",
          status: "running",
          startedAt: 1,
          agents: { total: 1, running: 1, done: 0, error: 0, uncertain: 0 },
        },
      ],
      omitted: 0,
      truncated: false,
    }),
  });
  const unregisterTerminalDetails = registerWebCapability(sessionManager, {
    kind: "background-terminals",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
    detail: (id) =>
      id === "bt-test"
        ? {
            kind: "background-terminals",
            id,
            title: "server",
            command: "run-server",
            cwd,
            status: "running",
            createdAt: 1,
            stdout: {
              text: "ready",
              totalBytes: 5,
              retainedBytes: 5,
              omittedBytes: 0,
              truncated: false,
              recoveryAvailable: false,
            },
            stderr: {
              text: "",
              totalBytes: 0,
              retainedBytes: 0,
              omittedBytes: 0,
              truncated: false,
              recoveryAvailable: false,
            },
            truncated: false,
          }
        : undefined,
  });
  const capabilityActions: string[] = [];
  const unregisterCapabilityActions = registerWebCapabilityActions(
    sessionManager,
    {
      kind: "subagents",
      async run(request) {
        capabilityActions.push(request.action);
        return {
          kind: "subagents",
          id: "btw-web",
          title: "Side question",
          origin: "btw",
          status: "running",
          createdAt: 1,
          cwd,
          model: "fixture/current-model",
          prompt:
            request.action === "spawn-btw" ? request.prompt : "Side question",
          transcript: [],
          liveTools: [],
          finalText: "",
          truncated: false,
          omittedEntries: 0,
        };
      },
    },
  );
  const prompts: string[] = [];
  const promptOptions: Array<
    Parameters<WebRuntimeController["sendPrompt"]>[1]
  > = [];
  const creationCommandIds: string[] = [];
  let newSessions = 0;
  let disposed = false;
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    get cwd() {
      return runtimeCwd;
    },
    get sessionManager() {
      return sessionManager;
    },
    isIdle: () => false,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async (content, options) => {
      prompts.push(content);
      promptOptions.push(options);
      return { pendingFollowUps: 0 };
    },
    newSession: async (workspacePath, options) => {
      newSessions++;
      if (options?.commandId) creationCommandIds.push(options.commandId);
      runtimeCwd = workspacePath;
      sessionManager = SessionManager.inMemory(workspacePath);
      for (const listener of listeners) listener({ type: "session_start" });
      return {
        cancelled: false,
        sessionId: sessionManager.getSessionId(),
        ...(options?.commandId ? { commandId: options.commandId } : {}),
      };
    },
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [
      {
        provider: "fixture",
        id: "current-model",
        name: "Current",
        label: "Current",
        current: true,
      },
      {
        provider: "fixture",
        id: "other-model",
        name: "Other",
        label: "Other",
        current: false,
      },
    ],
    searchModels: (query, limit) =>
      projectWebModelSearch(runtime.listModels(), query, limit),
    getProjectTrustStatus: () => ({
      source: "pi-project-trust",
      workspace: runtimeCwd,
      state: "restricted",
      decision: "undecided",
      projectResources: true,
      sessionTrusted: false,
      refreshRequired: false,
    }),
    listProviderAuth: () => ({
      providers: [
        {
          id: "fixture",
          name: "Fixture",
          authMethods: ["api_key"],
          configured: true,
          source: "environment",
          subscription: false,
          nameTruncated: false,
        },
      ],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 250,
      },
    }),
    setModel: async () => {
      throw new WebRuntimeRequestError(
        "Model is not available",
        "MODEL_NOT_AVAILABLE",
        400,
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      disposed = true;
    },
  };
  const host = new WebHost({
    runtime,
    allowedOrigins: ["http://127.0.0.1:59999"],
  });

  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const authorized = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const planRequest = {
      sessionId: sessionManager.getSessionId(),
      sessionPath: mutationSessionPath(sessionManager),
      enabled: true,
      expectedRevision: null,
    };
    const postPlan = (data: unknown, auth = authorized) =>
      fetch(`${launched.origin}/api/plan`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(data),
      });
    assert.equal(
      (
        await fetch(`${launched.origin}/api/plan`, {
          method: "POST",
          body: JSON.stringify(planRequest),
        })
      ).status,
      401,
    );
    assert.equal(
      (await postPlan({ ...planRequest, enabled: "yes" })).status,
      400,
    );
    assert.equal((await postPlan({ ...planRequest, extra: true })).status, 400);
    assert.equal((await postPlan(planRequest)).status, 501);
    let planCalls = 0;
    runtime.setPlanMode = async (request) => {
      assert.deepEqual(request, planRequest);
      planCalls++;
      return { status: "planning", revision: "plan-1", hasPrompt: false };
    };
    assert.equal(
      (
        await postPlan({
          ...planRequest,
          sessionPath: "/tmp/copied-session.jsonl",
        })
      ).status,
      409,
    );
    assert.equal(
      (await postPlan({ ...planRequest, sessionPath: undefined })).status,
      400,
    );
    assert.equal(planCalls, 0);
    const switchedPlan = await postPlan(planRequest);
    assert.equal(switchedPlan.status, 200);
    assert.deepEqual(await switchedPlan.json(), {
      sessionId: planRequest.sessionId,
      status: "planning",
      revision: "plan-1",
      hasPrompt: false,
    });
    runtime.setPlanMode = async () => {
      throw new WebRuntimeRequestError("Plan changed", "PLAN_CONFLICT", 409);
    };
    assert.equal((await postPlan(planRequest)).status, 409);
    assert.equal(planCalls, 1);
    delete runtime.setPlanMode;

    const implementationRequest = {
      sessionId: sessionManager.getSessionId(),
      sessionPath: `current:${sessionManager.getSessionId()}`,
      expectedRevision: "ready-1",
    };
    const postImplementation = (data: unknown) =>
      fetch(`${launched.origin}/api/plan/implement`, {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(data),
      });
    assert.equal((await postImplementation(implementationRequest)).status, 501);
    assert.equal(
      (await postImplementation({ ...implementationRequest, extra: true }))
        .status,
      400,
    );
    let implementationCalls = 0;
    runtime.preparePlanImplementation = async (request) => {
      assert.deepEqual(request, implementationRequest);
      implementationCalls++;
      return {
        status: "ready",
        revision: "ready-1",
        hasPrompt: false,
        prompt: "Implement the approved plan",
      };
    };
    const preparedPlan = await postImplementation(implementationRequest);
    assert.equal(preparedPlan.status, 200);
    assert.deepEqual(await preparedPlan.json(), {
      sessionId: implementationRequest.sessionId,
      status: "ready",
      revision: "ready-1",
      hasPrompt: false,
      prompt: "Implement the approved plan",
    });
    runtime.preparePlanImplementation = async () => {
      throw new WebRuntimeRequestError("Plan changed", "PLAN_CONFLICT", 409);
    };
    assert.equal((await postImplementation(implementationRequest)).status, 409);
    assert.equal(implementationCalls, 1);
    delete runtime.preparePlanImplementation;

    const page = await documentRequest(`${launched.origin}/`);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy") || "",
      /img-src 'self' data:/u,
    );
    assert.match(
      page.headers.get("content-security-policy") || "",
      /frame-src http: https: 'self' blob:/u,
    );
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const pageHtml = await page.text();
    assert.match(pageHtml, /<div id="root"><\/div>/);
    assert.ok(
      pageHtml.includes(`<meta name="openpi-web-token" content="${token}">`),
    );
    assert.equal(
      page.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const blockedHeaders: Record<string, string>[] = [
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "script" },
      { Referer: "https://attacker.example/" },
      { Origin: "https://attacker.example" },
      { Origin: "http://127.0.0.1:59999" },
    ];
    for (const headers of blockedHeaders) {
      const blocked = await documentRequest(`${launched.origin}/`, headers);
      assert.equal(blocked.status, 403);
      assert.ok(!(await blocked.text()).includes(token));
    }
    const navigation = await documentRequest(`${launched.origin}/`, {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(navigation.status, 200);
    assert.equal((await fetch(`${launched.origin}/api/snapshot`)).status, 401);
    assert.match(
      pageHtml,
      /<script type="module"[^>]*src="\/app\.js"><\/script>/,
    );
    assert.match(pageHtml, /<link rel="stylesheet"[^>]*href="\/styles\.css">/);
    assert.match(pageHtml, /href="\/favicon\.svg"/);
    assert.doesNotMatch(pageHtml, /marked\.js|https?:\/\//u);

    const app = await fetch(`${launched.origin}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") || "", /javascript/);
    const appSource = await app.text();
    assert.ok(!appSource.includes(token));
    assert.match(appSource, /OpenPI Web root is missing/);
    assert.match(appSource, /openpi\.web\.token/);
    assert.match(appSource, /\/events\?cursor=/);
    assert.match(appSource, /workspaceDeleteConfirm/);
    assert.match(appSource, /activity-card/);
    assert.doesNotMatch(appSource, /openpi\.archived-sessions/);
    assert.match(appSource, /openpi:reading-positions:v1/);
    assert.match(appSource, /openpi:workbar-positions:v1/);
    assert.doesNotMatch(appSource, /language-picker|open-settings/u);

    const styles = await fetch(`${launched.origin}/styles.css`);
    assert.equal(styles.status, 200);
    const stylesSource = await styles.text();
    assert.match(stylesSource, /\.landing \.conversation/);
    assert.match(stylesSource, /\.composer\.dormant/);
    assert.match(stylesSource, /\.activity-card/);
    assert.match(
      stylesSource,
      /@media\s*\((?:max-width:\s*760px|width\s*<=\s*760px)\)/,
    );
    assert.match(stylesSource, /prefers-reduced-motion/);

    const favicon = await fetch(`${launched.origin}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /svg/);

    const removedLegacyAsset = await fetch(`${launched.origin}/marked.js`);
    assert.equal(removedLegacyAsset.status, 401);

    let thinkingReads = 0;
    runtime.getThinkingState = () => {
      thinkingReads++;
      return { level: "high", available: ["off", "high"], supported: true };
    };
    assert.equal((await fetch(`${launched.origin}/api/thinking`)).status, 401);
    assert.equal(thinkingReads, 0);
    const thinkingRevision = (host as unknown as { sequence: number }).sequence;
    const thinkingResponse = await fetch(`${launched.origin}/api/thinking`, {
      headers: authorized,
    });
    assert.deepEqual(await thinkingResponse.json(), {
      sessionId: sessionManager.getSessionId(),
      level: "high",
      available: ["off", "high"],
      supported: true,
      revision: thinkingRevision,
    });
    assert.equal(thinkingReads, 1);
    const thinkingSnapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      cursor: number;
      thinking?: {
        level: string;
        available: string[];
        supported: boolean;
        revision: number;
      };
    };
    assert.deepEqual(thinkingSnapshot.thinking, {
      level: "high",
      available: ["off", "high"],
      supported: true,
      revision: thinkingSnapshot.cursor,
    });
    delete runtime.getThinkingState;
    const unknownThinking = await fetch(`${launched.origin}/api/thinking`, {
      headers: authorized,
    });
    assert.deepEqual(await unknownThinking.json(), {
      sessionId: sessionManager.getSessionId(),
      level: "unknown",
      available: [],
      supported: false,
      revision: thinkingRevision,
    });
    runtime.getThinkingState = () => {
      throw new Error("thinking state exploded");
    };
    const thrownThinking = await fetch(`${launched.origin}/api/thinking`, {
      headers: authorized,
    });
    assert.equal(thrownThinking.status, 200);
    assert.deepEqual(await thrownThinking.json(), {
      sessionId: sessionManager.getSessionId(),
      level: "unknown",
      available: [],
      supported: false,
      revision: thinkingRevision,
    });
    delete runtime.getThinkingState;
    assert.equal(
      (
        await fetch(
          `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test`,
        )
      ).status,
      401,
    );

    const trustGetter = runtime.getProjectTrustStatus;
    assert.ok(trustGetter);
    let trustReads = 0;
    runtime.getProjectTrustStatus = () => {
      trustReads++;
      return trustGetter();
    };
    assert.equal((await fetch(`${launched.origin}/api/trust`)).status, 401);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/trust`, {
          headers: { ...authorized, Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/trust`, {
          method: "POST",
          headers: authorized,
        })
      ).status,
      405,
    );
    assert.equal(trustReads, 0);
    delete runtime.getProjectTrustStatus;
    const unavailableTrust = await fetch(`${launched.origin}/api/trust`, {
      headers: authorized,
    });
    assert.equal(unavailableTrust.status, 501);
    assert.equal(
      (await unavailableTrust.json()).code,
      "PROJECT_TRUST_STATUS_UNAVAILABLE",
    );
    runtime.getProjectTrustStatus = trustGetter;

    const unauthorized = await fetch(`${launched.origin}/api/snapshot`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedCapabilities = await fetch(
      `${launched.origin}/api/capabilities`,
    );
    assert.equal(unauthorizedCapabilities.status, 401);
    const unauthorizedDiagnostics = await fetch(
      `${launched.origin}/api/diagnostics`,
    );
    assert.equal(unauthorizedDiagnostics.status, 401);

    const response = await fetch(`${launched.origin}/api/snapshot`, {
      headers: authorized,
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as {
      protocolVersion: number;
      cursor: number;
      preferences: { theme: string };
      currentSessionId: string;
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
      models: Array<{ provider: string; id: string }>;
      runtime: { status: string; capabilities: Record<string, unknown> };
    };
    assert.equal(snapshot.protocolVersion, 1);
    assert.equal(snapshot.preferences.theme, loadSetupConfig().ui.webTheme);
    assert.ok(snapshot.cursor >= 1);
    assert.equal(snapshot.currentSessionId, sessionManager.getSessionId());
    assert.ok(Array.isArray(snapshot.models));
    const modelsResponse = await fetch(`${launched.origin}/api/models`, {
      headers: authorized,
    });
    assert.equal(modelsResponse.status, 200);
    const modelsText = await modelsResponse.text();
    const modelsBody = JSON.parse(modelsText) as {
      models: Array<{ provider: string; id: string }>;
      totalMatches: number;
      truncation: {
        bytes: number;
        matchesOmitted: number;
        maxBytes: number;
      };
    };
    assert.deepEqual(modelsBody.models, snapshot.models);
    assert.equal(modelsBody.totalMatches, snapshot.models.length);
    assert.equal(modelsBody.truncation.matchesOmitted, 0);
    assert.equal(Buffer.byteLength(modelsText), modelsBody.truncation.bytes);
    assert.ok(modelsBody.truncation.bytes <= modelsBody.truncation.maxBytes);
    const filteredModels = await fetch(
      `${launched.origin}/api/models?query=other&limit=1`,
      { headers: authorized },
    );
    assert.equal(filteredModels.status, 200);
    assert.deepEqual((await filteredModels.json()).models, [
      snapshot.models[1],
    ]);
    const invalidQuery = await fetch(
      `${launched.origin}/api/models?query=${"x".repeat(201)}`,
      { headers: authorized },
    );
    assert.equal(invalidQuery.status, 400);
    assert.equal((await invalidQuery.json()).code, "INVALID_MODEL_QUERY");
    for (const invalidLimit of ["0", "51", "nope"]) {
      const invalidLimitResponse = await fetch(
        `${launched.origin}/api/models?limit=${invalidLimit}`,
        { headers: authorized },
      );
      assert.equal(invalidLimitResponse.status, 400);
      assert.equal(
        (await invalidLimitResponse.json()).code,
        "INVALID_MODEL_LIMIT",
      );
    }
    const staleModelSession = await fetch(
      `${launched.origin}/api/models?query=other&sessionId=another-session`,
      { headers: authorized },
    );
    assert.equal(staleModelSession.status, 409);
    assert.equal((await staleModelSession.json()).code, "SESSION_CHANGED");
    assert.equal(
      (
        await fetch(`${launched.origin}/api/models`, {
          headers: { Authorization: "Bearer invalid" },
        })
      ).status,
      401,
    );
    const trustResponse = await fetch(`${launched.origin}/api/trust`, {
      headers: authorized,
    });
    assert.equal(trustResponse.status, 200);
    assert.deepEqual(await trustResponse.json(), {
      source: "pi-project-trust",
      workspace: cwd,
      state: "restricted",
      decision: "undecided",
      projectResources: true,
      sessionTrusted: false,
      refreshRequired: false,
    });
    const providerAuthResponse = await fetch(
      `${launched.origin}/api/providers/auth-status`,
      { headers: authorized },
    );
    assert.equal(providerAuthResponse.status, 200);
    assert.deepEqual(await providerAuthResponse.json(), {
      providers: [
        {
          id: "fixture",
          name: "Fixture",
          authMethods: ["api_key"],
          configured: true,
          source: "environment",
          subscription: false,
          nameTruncated: false,
        },
      ],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 250,
      },
    });
    for (const route of [
      "/api/thinking",
      "/api/trust",
      "/api/providers/auth-status",
      "/api/capabilities/detail?kind=background-terminals&id=bt-test",
    ]) {
      const separator = route.includes("?") ? "&" : "?";
      const mismatched = await fetch(
        `${launched.origin}${route}${separator}sessionId=another-session`,
        { headers: authorized },
      );
      assert.equal(mismatched.status, 409);
      assert.equal((await mismatched.json()).code, "SESSION_CHANGED");
    }
    const scopedDetail = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test&sessionId=${encodeURIComponent(sessionManager.getSessionId())}`,
      { headers: authorized },
    );
    assert.equal(scopedDetail.status, 200);
    assert.equal(
      (await scopedDetail.json()).sessionId,
      sessionManager.getSessionId(),
    );
    const terminalDetailResponse = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test`,
      { headers: authorized },
    );
    assert.equal(terminalDetailResponse.status, 200);
    assert.deepEqual((await terminalDetailResponse.json()).detail, {
      kind: "background-terminals",
      id: "bt-test",
      title: "server",
      command: "run-server",
      cwd,
      status: "running",
      createdAt: 1,
      stdout: {
        text: "ready",
        totalBytes: 5,
        retainedBytes: 5,
        omittedBytes: 0,
        truncated: false,
        recoveryAvailable: false,
      },
      stderr: {
        text: "",
        totalBytes: 0,
        retainedBytes: 0,
        omittedBytes: 0,
        truncated: false,
        recoveryAvailable: false,
      },
      truncated: false,
    });
    const staleTerminalResponse = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-missing`,
      { headers: authorized },
    );
    assert.equal(staleTerminalResponse.status, 404);
    assert.deepEqual(await staleTerminalResponse.json(), {
      code: "CAPABILITY_NOT_FOUND",
      error: "capability resource was not found in the active Session",
    });
    assert.equal(
      (
        await fetch(`${launched.origin}/api/capabilities/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionManager.getSessionId(),
            kind: "subagents",
            action: "spawn-btw",
            prompt: "inspect this",
          }),
        })
      ).status,
      401,
    );
    const invalidCapabilityAction = await fetch(
      `${launched.origin}/api/capabilities/action`,
      {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({
          sessionId: sessionManager.getSessionId(),
          kind: "subagents",
          action: "spawn-btw",
          prompt: " ",
        }),
      },
    );
    assert.equal(invalidCapabilityAction.status, 400);
    assert.equal(
      (await invalidCapabilityAction.json()).code,
      "INVALID_CAPABILITY_ACTION",
    );
    const staleCapabilityAction = await fetch(
      `${launched.origin}/api/capabilities/action`,
      {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({
          sessionId: "another-session",
          kind: "subagents",
          action: "spawn-btw",
          prompt: "inspect this",
        }),
      },
    );
    assert.equal(staleCapabilityAction.status, 409);
    assert.equal((await staleCapabilityAction.json()).code, "SESSION_CHANGED");
    const capabilityAction = await fetch(
      `${launched.origin}/api/capabilities/action`,
      {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({
          sessionId: sessionManager.getSessionId(),
          kind: "subagents",
          action: "spawn-btw",
          prompt: "inspect this",
        }),
      },
    );
    assert.equal(capabilityAction.status, 200);
    assert.deepEqual(await capabilityAction.json(), {
      sessionId: sessionManager.getSessionId(),
      detail: {
        kind: "subagents",
        id: "btw-web",
        title: "Side question",
        origin: "btw",
        status: "running",
        createdAt: 1,
        cwd,
        model: "fixture/current-model",
        prompt: "inspect this",
        transcript: [],
        liveTools: [],
        finalText: "",
        truncated: false,
        omittedEntries: 0,
      },
    });
    assert.deepEqual(capabilityActions, ["spawn-btw"]);
    const unavailableModel = await fetch(`${launched.origin}/api/model`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        provider: "missing",
        modelId: "missing",
        sessionId: sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(sessionManager),
      }),
    });
    assert.equal(unavailableModel.status, 400);
    assert.deepEqual(await unavailableModel.json(), {
      code: "MODEL_NOT_AVAILABLE",
      error: "Model is not available",
    });
    assert.equal(snapshot.runtime.status, "running");
    assert.ok(snapshot.workspaces.some((workspace) => workspace.path === cwd));
    assert.deepEqual(snapshot.runtime.capabilities.workflows, {
      items: [
        {
          runId: "wf-test",
          status: "running",
          startedAt: 1,
          agents: { total: 1, running: 1, done: 0, error: 0, uncertain: 0 },
        },
      ],
      omitted: 0,
      truncated: false,
    });
    const capabilitiesResponse = await fetch(
      `${launched.origin}/api/capabilities`,
      { headers: authorized },
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilitiesBody = (await capabilitiesResponse.json()) as {
      sessionId: string;
      capabilities: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(capabilitiesBody).sort(), [
      "capabilities",
      "sessionId",
    ]);
    assert.equal(capabilitiesBody.sessionId, sessionManager.getSessionId());
    assert.deepEqual(
      capabilitiesBody.capabilities,
      snapshot.runtime.capabilities,
    );
    assert.doesNotMatch(
      JSON.stringify(capabilitiesBody),
      /token|Authorization|Bearer|transcript|entries|messages|apiKey|secret/i,
    );
    const writeCapabilities = await fetch(
      `${launched.origin}/api/capabilities`,
      {
        method: "POST",
        headers: authorized,
        body: "{}",
      },
    );
    assert.equal(writeCapabilities.status, 405);

    const diagnosticsResponse = await fetch(
      `${launched.origin}/api/diagnostics`,
      { headers: authorized },
    );
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsBody = await diagnosticsResponse.json();
    assert.deepEqual(diagnosticsBody, {
      node: process.version,
      cwd,
      sessionId: sessionManager.getSessionId(),
      workspaceSelected: true,
      models: [
        {
          provider: "fixture",
          id: "current-model",
          name: "Current",
          label: "Current",
          current: true,
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(diagnosticsBody),
      /token|Authorization|Bearer|transcript|entries|messages|apiKey|secret/i,
    );
    const writeDiagnostics = await fetch(`${launched.origin}/api/diagnostics`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    assert.equal(writeDiagnostics.status, 405);

    const sessionsResponse = await fetch(`${launched.origin}/api/sessions`, {
      headers: authorized,
    });
    const listedSessions = (await sessionsResponse.json()) as {
      sessions: Array<{ path: string }>;
      truncation: { truncated: boolean; sessionsOmitted: number };
    };
    assert.deepEqual(listedSessions.truncation, {
      truncated: false,
      sessionsOmitted: 0,
    });
    const archivedSessionsResponse = await fetch(
      `${launched.origin}/api/sessions/archived?limit=10&q=current`,
      { headers: authorized },
    );
    assert.equal(archivedSessionsResponse.status, 200);
    assert.deepEqual(await archivedSessionsResponse.json(), {
      sessions: [],
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        recordsUnscanned: 0,
        maxPageSize: 50,
        maxScanned: 5_000,
      },
    });
    const invalidArchiveQuery = await fetch(
      `${launched.origin}/api/sessions/archived?limit=51`,
      { headers: authorized },
    );
    assert.equal(invalidArchiveQuery.status, 400);
    assert.deepEqual(await invalidArchiveQuery.json(), {
      code: "INVALID_ARCHIVED_SESSION_QUERY",
      error: "archived Session limit must be a bounded positive integer",
    });
    const currentSessionPath = listedSessions.sessions[0]?.path;
    assert.ok(currentSessionPath);
    const sessionRename = await fetch(`${launched.origin}/api/sessions`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: currentSessionPath,
        name: "Renamed conversation",
      }),
    });
    assert.equal(sessionRename.status, 200);
    const sessionArchive = await fetch(
      `${launched.origin}/api/sessions/archive?path=${encodeURIComponent(currentSessionPath)}`,
      { method: "POST", headers: authorized },
    );
    assert.equal(sessionArchive.status, 200);
    const archivedSnapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { sessions: Array<{ path: string; archived?: boolean }> };
    assert.equal(
      archivedSnapshot.sessions.find(
        (session) => session.path === currentSessionPath,
      )?.archived,
      true,
    );

    const unarchiveUrl = `${launched.origin}/api/sessions/unarchive?path=${encodeURIComponent(currentSessionPath)}`;
    assert.equal((await fetch(unarchiveUrl, { method: "POST" })).status, 401);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/sessions/unarchive`, {
          method: "POST",
          headers: authorized,
        })
      ).status,
      400,
    );
    const unarchiveResponse = await fetch(unarchiveUrl, {
      method: "POST",
      headers: authorized,
    });
    assert.equal(unarchiveResponse.status, 200);
    assert.deepEqual(await unarchiveResponse.json(), {
      path: currentSessionPath,
      archived: false,
    });
    const restoredSnapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, {
        headers: authorized,
      })
    ).json()) as { sessions: Array<{ path: string; archived?: boolean }> };
    assert.equal(
      restoredSnapshot.sessions.find(
        (session) => session.path === currentSessionPath,
      )?.archived,
      undefined,
    );

    const wrongSession = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        sessionId: "other",
        sessionPath: mutationSessionPath(sessionManager),
        content: "wrong target",
      }),
    });
    assert.equal(wrongSession.status, 409);

    const prompt = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(sessionManager),
        content: "continue here",
        planRevision: "ready-1",
      }),
    });
    assert.equal(prompt.status, 202);
    assert.deepEqual(prompts, ["continue here"]);
    assert.equal(promptOptions[0]?.planRevision, "ready-1");

    const importResponse = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ path: imported }),
    });
    assert.equal(importResponse.status, 201);
    const importedWorkspace = (await importResponse.json()) as { path: string };
    const afterImport = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { workspaces: Array<{ path: string }> };
    assert.ok(
      afterImport.workspaces.some(
        (workspace) => workspace.path === importedWorkspace.path,
      ),
    );

    const renameResponse = await fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: importedWorkspace.path,
        name: "Reference code",
      }),
    });
    assert.equal(renameResponse.status, 200);
    const concurrentRenames = await Promise.all([
      fetch(`${launched.origin}/api/workspaces`, {
        method: "PATCH",
        headers: authorized,
        body: JSON.stringify({
          path: importedWorkspace.path,
          name: "Concurrent left",
        }),
      }),
      fetch(`${launched.origin}/api/workspaces`, {
        method: "PATCH",
        headers: authorized,
        body: JSON.stringify({
          path: importedWorkspace.path,
          name: "Concurrent right",
        }),
      }),
    ]);
    assert.deepEqual(
      concurrentRenames.map((response) => response.status),
      [200, 200],
    );
    const restoreRename = await fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: importedWorkspace.path,
        name: "Reference code",
      }),
    });
    assert.equal(restoreRename.status, 200);
    const afterRename = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { workspaces: Array<{ path: string; name: string }> };
    assert.equal(
      afterRename.workspaces.find(
        (workspace) => workspace.path === importedWorkspace.path,
      )?.name,
      "Reference code",
    );

    const importedSession = await fetch(`${launched.origin}/api/sessions`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        workspacePath: importedWorkspace.path,
        commandId: "create-imported",
      }),
    });
    assert.equal(importedSession.status, 201);
    assert.deepEqual(await importedSession.json(), {
      cancelled: false,
      commandId: "create-imported",
      sessionId: sessionManager.getSessionId(),
    });
    assert.equal(runtimeCwd, importedWorkspace.path);

    const newSession = await fetch(`${launched.origin}/api/sessions`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ workspacePath: cwd, commandId: "create-current" }),
    });
    assert.equal(newSession.status, 201);
    assert.deepEqual(await newSession.json(), {
      cancelled: false,
      commandId: "create-current",
      sessionId: sessionManager.getSessionId(),
    });
    assert.equal(runtimeCwd, cwd);
    assert.equal(newSessions, 2);
    assert.deepEqual(creationCommandIds, ["create-imported", "create-current"]);
    const beforeReplay = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { cursor: number };
    const originalNewSession = runtime.newSession;
    runtime.newSession = async (_workspacePath, options) => ({
      cancelled: false,
      replayed: true,
      commandId: options?.commandId,
      sessionId: "older-session",
    });
    try {
      const replay = await fetch(`${launched.origin}/api/sessions`, {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({
          workspacePath: importedWorkspace.path,
          commandId: "create-imported",
        }),
      });
      assert.equal(replay.status, 201);
      const afterReplay = (await (
        await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
      ).json()) as { cursor: number };
      assert.equal(
        afterReplay.cursor,
        beforeReplay.cursor,
        "a replay is not a new Session transition",
      );
      assert.equal(runtimeCwd, cwd);
    } finally {
      runtime.newSession = originalNewSession;
    }

    const removeActive = await fetch(
      `${launched.origin}/api/workspaces?path=${encodeURIComponent(cwd)}`,
      { method: "DELETE", headers: authorized },
    );
    assert.equal(removeActive.status, 200);
    const afterActiveRemove = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      currentSessionId: string;
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
    };
    assert.equal(
      afterActiveRemove.currentSessionId,
      sessionManager.getSessionId(),
    );
    assert.ok(
      !afterActiveRemove.workspaces.some((workspace) => workspace.path === cwd),
    );

    assert.equal(
      afterActiveRemove.sessions.find((session) => session.cwd === cwd)
        ?.ungrouped,
      true,
    );

    const restoreActive = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ path: cwd }),
    });
    assert.equal(restoreActive.status, 201);
    const restoredActive = (await restoreActive.json()) as { path: string };
    const afterActiveRestore = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
    };
    assert.ok(
      afterActiveRestore.workspaces.some(
        (workspace) => workspace.path === restoredActive.path,
      ),
    );
    assert.equal(
      afterActiveRestore.sessions.find((session) => session.cwd === cwd)
        ?.ungrouped,
      true,
    );

    const removeImported = await fetch(
      `${launched.origin}/api/workspaces?path=${encodeURIComponent(importedWorkspace.path)}`,
      { method: "DELETE", headers: authorized },
    );
    assert.equal(removeImported.status, 200);
    const afterRemove = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      workspaces: Array<{ path: string }>;
    };
    assert.ok(
      !afterRemove.workspaces.some(
        (workspace) => workspace.path === importedWorkspace.path,
      ),
    );
  } finally {
    await host.stop();
    assert.equal(disposed, true);
    unregisterTerminalDetails();
    unregisterCapabilityActions();
    unregister();
    await Promise.all(
      [cwd, imported].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("serves terminal Sessions through a read-only bounded endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-terminal-host-"));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  const sessionManager = SessionManager.inMemory(root);
  const terminal = SessionManager.create(root);
  terminal.appendMessage({
    role: "user",
    content: "terminal endpoint",
    timestamp: 1,
  });
  terminal.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  const runtime: WebRuntimeController = {
    cwd: root,
    workspaceSelected: true,
    sessionDirectory: join(root, "web-sessions"),
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    newSession: async () => ({
      cancelled: false,
      sessionId: runtime.sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("not available");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const listed = await fetch(
      `${launched.origin}/api/terminal-sessions?limit=1`,
      {
        headers,
      },
    );
    assert.equal(listed.status, 200);
    const page = (await listed.json()) as {
      sessions: Array<{
        path: string;
        source: string;
        origin: string;
        readOnly: boolean;
      }>;
      total: number;
    };
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0]?.path, terminal.getSessionFile());
    assert.equal(page.sessions[0]?.source, "pi-default");
    assert.equal(page.sessions[0]?.origin, "terminal");
    assert.equal(page.sessions[0]?.readOnly, true);
    assert.equal(JSON.stringify(page).includes("allMessagesText"), false);
    assert.equal(
      (
        await fetch(
          `${launched.origin}/api/terminal-sessions?query=${"x".repeat(201)}`,
          { headers },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/terminal-sessions?cursor=nope`, {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/terminal-sessions?limit=101`, {
          headers,
        })
      ).status,
      400,
    );
    const missing = await fetch(
      `${launched.origin}/api/terminal-sessions?path=${encodeURIComponent(join(root, "missing.jsonl"))}`,
      { headers },
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      code: "SESSION_NOT_FOUND",
      error: "Terminal Session is not available",
    });
    const inspected = await fetch(
      `${launched.origin}/api/terminal-sessions?path=${encodeURIComponent(terminal.getSessionFile()!)}`,
      { headers },
    );
    assert.equal(inspected.status, 200);
    const details = (await inspected.json()) as {
      readOnly: boolean;
      preview: { messages: unknown[]; retainedBytes: number };
    };
    assert.equal(details.readOnly, true);
    assert.equal(details.preview.messages.length, 2);
    assert.ok(details.preview.retainedBytes > 0);
    assert.equal(JSON.stringify(details).includes("allMessagesText"), false);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const rejected = await fetch(`${launched.origin}/api/terminal-sessions`, {
        method,
        headers,
      });
      assert.equal(rejected.status, 405);
    }
    const capabilities = await fetch(`${launched.origin}/api/capabilities`, {
      headers,
    });
    assert.equal(
      (await capabilities.json()).sessionId,
      sessionManager.getSessionId(),
    );
    const webSessions = await fetch(`${launched.origin}/api/sessions`, {
      headers,
    });
    assert.ok(!JSON.stringify(await webSessions.json()).includes("pi-default"));
  } finally {
    await host.stop();
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an unbound Host exposes no bootstrap Session and rejects prompt bypasses", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-unbound-host-"));
  const bootstrap = join(root, ".bootstrap-workspace");
  const sessionManager = SessionManager.inMemory(bootstrap);
  let prompts = 0;
  let disposed = false;
  const events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
  const runtime: WebRuntimeController = {
    cwd: bootstrap,
    workspaceSelected: false,
    sessionDirectory: root,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      prompts++;
      return { pendingFollowUps: 0 };
    },
    newSession: async () => ({
      cancelled: false,
      sessionId: sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("workspace required");
    },
    subscribe: () => () => {},
    dispose: async () => {
      disposed = true;
    },
  };
  const host = new WebHost({
    runtime,
    onEvent: (type, detail) => events.push({ type, detail }),
  });

  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const snapshotResponse = await fetch(`${launched.origin}/api/snapshot`, {
      headers,
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      currentSessionId?: string;
      selectedSession?: unknown;
      workspaces: unknown[];
      sessions: unknown[];
    };
    assert.equal(snapshot.currentSessionId, undefined);
    assert.equal(snapshot.selectedSession, undefined);
    assert.deepEqual(snapshot.workspaces, []);
    assert.deepEqual(snapshot.sessions, []);

    const prompt = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(sessionManager),
        content: "must not run",
      }),
    });
    assert.equal(prompt.status, 409);
    assert.deepEqual(await prompt.json(), {
      code: "WORKSPACE_REQUIRED",
      error: "Choose a workspace before using the Web runtime",
    });
    assert.equal(prompts, 0);

    const cancellation = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        commandId: "command-a",
        epoch: 1,
      }),
    });
    assert.equal(cancellation.status, 409);
    assert.equal((await cancellation.json()).code, "WORKSPACE_REQUIRED");

    const started = events.find((event) => event.type === "web_host_started");
    assert.ok(started);
    assert.equal("cwd" in (started.detail ?? {}), false);
  } finally {
    await host.stop();
    assert.equal(disposed, true);
    await rm(root, { recursive: true, force: true });
  }
});

test("returns accepted only after Pi admits the prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-"));
  const sessionManager = SessionManager.inMemory(cwd);
  let resolvePrompt!: () => void;
  const promptAdmitted = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  let promptStarted = false;
  let disposed = false;
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    cwd,
    sessionManager,
    isIdle: () => false,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      promptStarted = true;
      await promptAdmitted;
      return { pendingFollowUps: 0 };
    },
    newSession: async () => ({
      cancelled: false,
      sessionId: sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe: () => () => {},
    dispose: async () => {
      disposed = true;
    },
  };
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const responsePromise = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(sessionManager),
        content: "hello",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(promptStarted, true);
    let responded = false;
    void responsePromise.then(() => {
      responded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(responded, false);
    resolvePrompt();
    const response = await responsePromise;
    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as {
      accepted: boolean;
      pendingFollowUps: number;
    };
    assert.equal(responseBody.accepted, true);
    assert.equal(responseBody.pendingFollowUps, 0);
  } finally {
    resolvePrompt();
    await host.stop();
    assert.equal(disposed, true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns an exact receipt for a turn-bound cancellation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-cancel-"));
  const runtime = testRuntime(cwd);
  const activeTurn = {
    sessionId: runtime.sessionManager.getSessionId(),
    commandId: "command-a",
    epoch: 3,
  };
  runtime.getActiveTurn = () => activeTurn;
  runtime.cancelTurn = async (options) => ({
    ...options,
    state: "accepted",
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const snapshotResponse = await fetch(`${launched.origin}/api/snapshot`, {
      headers,
    });
    assert.equal(snapshotResponse.status, 200);
    assert.deepEqual(
      (await snapshotResponse.json()).runtime.activeTurn,
      activeTurn,
    );

    const response = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(activeTurn),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ...activeTurn,
      state: "accepted",
      accepted: true,
      cursor: 1,
    });

    runtime.cancelTurn = async (options) => ({
      ...options,
      state: "stale-turn",
    });
    const stale = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(activeTurn),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).state, "stale-turn");

    const invalid = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...activeTurn, epoch: 0 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thinking selection validates its body and returns the applied projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-post-"));
  const runtime = testRuntime(cwd);
  const applied: string[] = [];
  runtime.getThinkingState = () => ({
    level: "off",
    available: ["off", "low", "high"],
    supported: true,
  });
  runtime.setThinkingLevel = async (level, options) => {
    applied.push(level);
    return {
      level,
      available: ["off", "low", "high"],
      supported: true,
    };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const missingSession = await fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ level: "high" }),
    });
    assert.equal(missingSession.status, 400);
    assert.deepEqual(await missingSession.json(), {
      error: "sessionId, sessionPath, and a valid level are required",
    });

    const invalidLevel = await fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        level: "ultra",
      }),
    });
    assert.equal(invalidLevel.status, 400);
    assert.equal(applied.length, 0);

    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        level: "high",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: runtime.sessionManager.getSessionId(),
      level: "high",
      available: ["off", "low", "high"],
      supported: true,
      revision,
    });
    assert.deepEqual(applied, ["high"]);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thinking selection requires a workspace and available runtime control", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-gates-"));
  const headers = { "Content-Type": "application/json" };
  try {
    const unbound: WebRuntimeController = {
      ...testRuntime(cwd),
      workspaceSelected: false,
      setThinkingLevel: async () => ({
        level: "high",
        available: ["off", "high"],
        supported: true,
      }),
    };
    const unboundHost = await startTestHost(unbound);
    try {
      const workspace = await fetch(
        `${unboundHost.launched.origin}/api/thinking`,
        {
          method: "POST",
          headers: { ...unboundHost.headers, ...headers },
          body: JSON.stringify({
            sessionId: unbound.sessionManager.getSessionId(),
            sessionPath: mutationSessionPath(unbound.sessionManager),
            level: "high",
          }),
        },
      );
      assert.equal(workspace.status, 409);
      assert.equal((await workspace.json()).code, "WORKSPACE_REQUIRED");
    } finally {
      await unboundHost.host.stop();
    }

    const unavailable = testRuntime(cwd);
    const unavailableHost = await startTestHost(unavailable);
    try {
      const response = await fetch(
        `${unavailableHost.launched.origin}/api/thinking`,
        {
          method: "POST",
          headers: { ...unavailableHost.headers, ...headers },
          body: JSON.stringify({
            sessionId: unavailable.sessionManager.getSessionId(),
            sessionPath: mutationSessionPath(unavailable.sessionManager),
            level: "high",
          }),
        },
      );
      assert.equal(response.status, 501);
      assert.deepEqual(await response.json(), {
        code: "THINKING_CONTROL_UNAVAILABLE",
        error: "thinking control is unavailable",
      });
    } finally {
      await unavailableHost.host.stop();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GET /api/thinking degrades instead of failing when the getter throws", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-throw-"));
  const runtime = testRuntime(cwd);
  runtime.getThinkingState = () => {
    throw new Error("thinking state exploded");
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: runtime.sessionManager.getSessionId(),
      level: "unknown",
      available: [],
      supported: false,
      revision,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GET /api/thinking degrades when the session manager cannot report an id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-session-"));
  const runtime = testRuntime(cwd);
  runtime.getThinkingState = () => ({
    level: "high",
    available: ["off", "high"],
    supported: true,
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const getSessionId = runtime.sessionManager.getSessionId.bind(
    runtime.sessionManager,
  );
  runtime.sessionManager.getSessionId = () => {
    throw new Error("session manager exploded");
  };
  try {
    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: "",
      level: "unknown",
      available: [],
      supported: false,
      revision,
    });
  } finally {
    runtime.sessionManager.getSessionId = getSessionId;
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GET /api/thinking bounds an oversized projection at the host boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-get-bounds-"));
  const runtime = testRuntime(cwd);
  const oversizedLevels = Array.from(
    { length: 30 },
    (_, index) => `level-${index}-${"a".repeat(600)}`,
  );
  runtime.getThinkingState = () => ({
    level: "l".repeat(900),
    available: oversizedLevels,
    supported: true,
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: runtime.sessionManager.getSessionId(),
      level: "l".repeat(500),
      available: oversizedLevels
        .slice(0, 16)
        .map((level) => level.slice(0, 500)),
      supported: true,
      revision,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GET /api/thinking returns the unknown fallback when the getter is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-absent-"));
  const runtime = testRuntime(cwd);
  delete runtime.getThinkingState;
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: runtime.sessionManager.getSessionId(),
      level: "unknown",
      available: [],
      supported: false,
      revision,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("POST /api/thinking bounds an oversized projection at the host boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-post-bounds-"));
  const runtime = testRuntime(cwd);
  const oversizedLevels = Array.from(
    { length: 30 },
    (_, index) => `level-${index}-${"a".repeat(600)}`,
  );
  runtime.setThinkingLevel = async () => ({
    level: "l".repeat(900),
    available: oversizedLevels,
    supported: true,
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const revision = (host as unknown as { sequence: number }).sequence;
    const response = await fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        level: "high",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: runtime.sessionManager.getSessionId(),
      level: "l".repeat(500),
      available: oversizedLevels
        .slice(0, 16)
        .map((level) => level.slice(0, 500)),
      supported: true,
      revision,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("POST /api/thinking reports unavailable levels for a non-reasoning model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-unsupported-"));
  const runtime = testRuntime(cwd);
  runtime.setThinkingLevel = async () => {
    throw new WebRuntimeRequestError(
      "Thinking level is not available for the current model",
      "THINKING_LEVEL_NOT_AVAILABLE",
      400,
    );
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const response = await fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        level: "high",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "THINKING_LEVEL_NOT_AVAILABLE",
      error: "Thinking level is not available for the current model",
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop waits for an in-flight thinking selection before disposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-lease-"));
  const runtime = testRuntime(cwd);
  let disposeCalls = 0;
  runtime.dispose = async () => {
    disposeCalls++;
  };
  let started!: () => void;
  const startedBarrier = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const selectionBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.setThinkingLevel = async (level) => {
    started();
    await selectionBarrier;
    return { level, available: ["off", level], supported: true };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const request = fetch(`${launched.origin}/api/thinking`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        level: "high",
      }),
    });
    await startedBarrier;
    const stopping = host.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disposeCalls, 0);
    release();
    await stopping;
    assert.equal(disposeCalls, 1);
    assert.equal((await request).status, 200);
  } finally {
    release();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("message search is authenticated, query-only, and opens only an exact native branch window", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-search-api-"));
  const manager = SessionManager.create(cwd, cwd);
  const target = manager.appendMessage({
    role: "user",
    content: "search API-MARKER",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Confirmed API-MARKER" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const { host, launched, headers } = await startTestHost({
    ...testRuntime(cwd),
    sessionManager: manager,
  });
  try {
    const get = (query: string, authenticated = true) =>
      fetch(`${launched.origin}/api/sessions/search?${query}`, {
        headers: authenticated ? headers : {},
      });
    assert.equal((await get("q=API-MARKER", false)).status, 401);
    for (const query of [
      "q=",
      "q=a&q=b",
      "q=API-MARKER&path=/etc/passwd",
      "q=a&includeArchived=0",
      `q=${"a".repeat(201)}`,
    ])
      assert.equal((await get(query)).status, 400);
    const found = await get("q=API-MARKER");
    assert.equal(found.status, 200);
    assert.equal((await found.json()).matches.length, 2);
    const params = new URLSearchParams({
      sessionId: manager.getSessionId(),
      path: manager.getSessionFile()!,
      entryId: target,
    });
    const located = await fetch(
      `${launched.origin}/api/session/message-window?${params}`,
      { headers },
    );
    assert.equal(located.status, 200);
    const window = (await located.json()).session;
    assert.equal(window.history.anchorEntryId, target);
    assert.ok(
      window.entries.some((entry: { id: string }) => entry.id === target),
    );
    assert.equal(window.entries.at(-1).message.content, "Confirmed API-MARKER");
    params.set("sessionId", "copied-id");
    assert.equal(
      (
        await fetch(`${launched.origin}/api/session/message-window?${params}`, {
          headers,
        })
      ).status,
      409,
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prompt navigation is authenticated read-only and rejects ambiguous native boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-index-"));
  const runtime = testRuntime(cwd);
  const manager = runtime.sessionManager;
  const prompt = manager.appendMessage({
    role: "user",
    content: "Visible prompt",
    timestamp: 1,
  });
  const anchor = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Visible reply" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const identity = {
    sessionId: manager.getSessionId(),
    path: mutationSessionPath(manager),
    anchorEntryId: anchor,
  };
  const original = JSON.stringify(manager.getEntries());
  try {
    for (const route of ["prompt-history", "prompt-preview"]) {
      const params = new URLSearchParams({
        ...identity,
        ...(route === "prompt-preview" ? { entryId: prompt } : {}),
      });
      const get = (query = params.toString(), requestHeaders = headers) =>
        fetch(`${launched.origin}/api/session/${route}?${query}`, {
          headers: requestHeaders,
        });
      assert.equal(
        (await get(params.toString(), {} as typeof headers)).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${launched.origin}/api/session/${route}?${params}`, {
            headers: { ...headers, Origin: "https://foreign.example" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${launched.origin}/api/session/${route}?${params}`, {
            headers,
            method: "POST",
          })
        ).status,
        405,
      );
      const valid = await get();
      assert.equal(valid.status, 200);
      const result = await valid.json();
      assert.equal(result.sessionId, identity.sessionId);
      assert.equal(result.sessionPath, identity.path);
      assert.equal(result.anchorEntryId, anchor);
      if (route === "prompt-history") {
        assert.deepEqual(result.entryIds, [prompt]);
        assert.equal(result.nextBeforeEntryId, null);
        assert.equal(result.requestedBeforeEntryId, null);
        assert.equal(result.prompt, undefined);
      } else {
        assert.equal(result.entryId, prompt);
        assert.equal(result.prompt, "Visible prompt");
        assert.equal(result.response, "Visible reply");
      }
      for (const suffix of [
        "&sessionId=duplicate",
        "&anchorEntryId=",
        "&extra=body",
        "&path=duplicate",
        "&anchorEntryId=" + "a".repeat(129),
        "&anchorEntryId=%20native",
        "&anchorEntryId=%00native",
      ]) {
        assert.equal((await get(params.toString() + suffix)).status, 400);
      }
      const missing = new URLSearchParams(params);
      missing.delete("anchorEntryId");
      assert.equal((await get(missing.toString())).status, 400);
      const wrongIdentity = new URLSearchParams(params);
      wrongIdentity.set("sessionId", "other");
      assert.equal((await get(wrongIdentity.toString())).status, 409);
      const unknown = new URLSearchParams(params);
      unknown.set("path", join(cwd, "unknown.jsonl"));
      assert.equal((await get(unknown.toString())).status, 404);
      if (route === "prompt-history") {
        assert.equal((await get(params + "&beforeEntryId=")).status, 400);
        assert.equal(
          (await get(params + "&beforeEntryId=" + anchor)).status,
          409,
        );
        const beforeFirst = await get(params + "&beforeEntryId=" + prompt);
        assert.equal(beforeFirst.status, 200);
        assert.deepEqual((await beforeFirst.json()).entryIds, []);
      } else {
        const assistantTarget = new URLSearchParams(params);
        assistantTarget.set("entryId", anchor);
        assert.equal((await get(assistantTarget.toString())).status, 409);
        assert.equal(
          (await get(params + "&beforeEntryId=" + prompt)).status,
          400,
        );
      }
    }
    assert.equal(
      JSON.stringify(manager.getEntries()),
      original,
      "index/preview GET cannot acknowledge or append a prompt",
    );
    manager.branch(prompt);
    for (const route of ["prompt-history", "prompt-preview"]) {
      const params = new URLSearchParams({
        ...identity,
        ...(route === "prompt-preview" ? { entryId: prompt } : {}),
      });
      assert.equal(
        (
          await fetch(`${launched.origin}/api/session/${route}?${params}`, {
            headers,
          })
        ).status,
        409,
      );
    }
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function testRuntime(
  cwd: string,
  sendPrompt: WebRuntimeController["sendPrompt"] = async () => ({
    pendingFollowUps: 0,
  }),
) {
  const sessionManager = SessionManager.inMemory(cwd);
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    cwd,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt,
    newSession: async () => ({
      cancelled: false,
      sessionId: sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  return runtime;
}

test("archived listing applies project and sort before pagination and rejects a cursor from another scope", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-archive-query-host-"));
  const project = join(cwd, "project & space");
  const otherProject = `${project}-other`;
  const runtime = testRuntime(cwd);
  const { host, launched, headers } = await startTestHost(runtime);
  t.after(async () => {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  const paths: string[] = [];
  for (const [index, workspace, created, modified] of [
    [0, project, "2020-01-01", "2024-01-03"],
    [1, otherProject, "2020-01-04", "2024-01-04"],
    [2, project, "2020-01-03", "2024-01-01"],
    [3, project, "2020-01-02", "2024-01-02"],
  ] as const) {
    const manager = SessionManager.create(workspace, cwd);
    const timestamp = Date.parse(`${modified}T00:00:00.000Z`);
    manager.appendMessage({
      role: "user",
      content: `archived ${index}`,
      timestamp,
    });
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
    const path = manager.getSessionFile()!;
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    lines[0] = JSON.stringify({
      ...JSON.parse(lines[0]!),
      timestamp: `${created}T00:00:00.000Z`,
    });
    await writeFile(path, `${lines.join("\n")}\n`);
    paths.push(path);
    assert.equal(
      (
        await fetch(
          `${launched.origin}/api/sessions/archive?path=${encodeURIComponent(path)}`,
          { method: "POST", headers },
        )
      ).status,
      200,
    );
  }
  const read = (query: Record<string, string>) =>
    fetch(
      `${launched.origin}/api/sessions/archived?${new URLSearchParams(query)}`,
      { headers },
    );
  const updated = await read({ cwd: project, limit: "1" });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    (await updated.json()).sessions.map(
      (session: { path: string }) => session.path,
    ),
    [paths[0]],
  );
  const created = await read({ cwd: project, sort: "created", limit: "1" });
  assert.equal(created.status, 200);
  const first = (await created.json()) as {
    sessions: Array<{ path: string }>;
    nextCursor: string;
  };
  assert.deepEqual(
    first.sessions.map((session) => session.path),
    [paths[2]],
  );
  assert.ok(first.nextCursor);
  const next = await read({
    cwd: project,
    sort: "created",
    limit: "1",
    cursor: first.nextCursor,
  });
  assert.equal(next.status, 200);
  assert.deepEqual(
    (await next.json()).sessions.map(
      (session: { path: string }) => session.path,
    ),
    [paths[3]],
  );
  const staleScopes: Record<string, string>[] = [
    { cwd: project, sort: "updated" },
    { cwd: otherProject, sort: "created" },
    { cwd: project, sort: "created", q: "changed" },
  ];
  for (const query of staleScopes) {
    const response = await read({ ...query, cursor: first.nextCursor });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ARCHIVED_SESSION_CURSOR_STALE");
  }
  const invalidQueries: Record<string, string>[] = [
    { sort: "unknown" },
    { cwd: "" },
    { cwd: "relative" },
    { cwd: `${project}\n` },
    { cwd: `/${"x".repeat(4096)}` },
  ];
  for (const query of invalidQueries) {
    const response = await read(query);
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).code,
      "INVALID_ARCHIVED_SESSION_QUERY",
    );
  }
  for (const query of [
    "sort=created&sort=updated",
    `cwd=${encodeURIComponent(project)}&cwd=${encodeURIComponent(otherProject)}`,
  ]) {
    const response = await fetch(
      `${launched.origin}/api/sessions/archived?${query}`,
      { headers },
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).code,
      "INVALID_ARCHIVED_SESSION_QUERY",
    );
  }
});

async function startTestHost(
  runtime: WebRuntimeController,
  options: Omit<WebHostOptions, "runtime"> = {},
) {
  const host = new WebHost({ runtime, ...options });
  await host.start();
  const launched = new URL(host.url);
  const token = new URLSearchParams(launched.hash.slice(1)).get("token");
  assert.ok(token);
  const headers = { Authorization: `Bearer ${token}` };
  return { host, launched, headers };
}

test("Session list and snapshot use the same saved sidebar sort preference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-sidebar-sort-host-"));
  const configPath = join(hostAgentDirectory, "my-pi-setup.json");
  const original = await readFile(configPath, "utf8").catch(() => undefined);
  const runtime = testRuntime(cwd);
  const managers = [
    SessionManager.create(cwd, cwd),
    SessionManager.create(cwd, cwd),
  ];
  for (const [index, manager] of managers.entries()) {
    manager.appendMessage({
      role: "user",
      content: `conversation-${index}`,
      timestamp: index + 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: index + 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
  const older = managers[0]!;
  const newer = managers[1]!;
  const olderPath = older.getSessionFile()!;
  const newerPath = newer.getSessionFile()!;
  await new PiWebAdapter(runtime).setSessionOrder(
    olderPath,
    older.getSessionId(),
    { path: newerPath, id: newer.getSessionId() },
  );
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    for (const chatsSort of ["manual", "updated"] as const) {
      const saved = await fetch(`${launched.origin}/api/settings/preferences`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ chatsSort }),
      });
      assert.equal(saved.status, 200);
      for (const route of ["/api/sessions", "/api/snapshot"]) {
        const response = await fetch(`${launched.origin}${route}`, { headers });
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          sessions: Array<{ path: string }>;
          preferences?: { chatsSort: string };
        };
        assert.deepEqual(
          page.sessions
            .map((session) => session.path)
            .filter((path) => path === olderPath || path === newerPath),
          chatsSort === "manual"
            ? [olderPath, newerPath]
            : [newerPath, olderPath],
        );
        if (route === "/api/snapshot")
          assert.equal(page.preferences?.chatsSort, chatsSort);
      }
    }
  } finally {
    await host.stop();
    if (original === undefined) await rm(configPath, { force: true });
    else await writeFile(configPath, original);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project order API validates exact paths and atomically moves pinned projects without selecting a Session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-project-order-host-"));
  const alpha = join(cwd, "alpha");
  const beta = join(cwd, "beta");
  const metadata = join(cwd, "workspace-state.json");
  await writeFile(
    metadata,
    JSON.stringify({
      version: 1,
      hiddenWorkspaces: [],
      ungroupedSessions: [],
      workspaceNames: {},
      importedWorkspaces: [alpha, beta],
      workspaceOrder: [cwd, alpha, beta],
    }),
  );
  let prompts = 0;
  let selections = 0;
  const runtime = testRuntime(cwd, async () => {
    prompts++;
    return { pendingFollowUps: 0 };
  });
  runtime.switchSession = async () => {
    selections++;
    return { cancelled: false };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const post = (route: string, body: unknown, authorized = true) =>
    fetch(`${launched.origin}${route}`, {
      method: "POST",
      headers: {
        ...(authorized ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const original = await readFile(metadata, "utf8");
    assert.equal(
      (await post("/api/workspaces/order", { path: alpha, before: cwd }, false))
        .status,
      401,
    );
    for (const body of [
      null,
      [],
      {},
      { path: 42 },
      { path: "relative/path" },
      { path: `${alpha}\u0000` },
      { path: `${alpha}\n` },
      { path: `/${"x".repeat(4096)}` },
      { path: alpha, before: "" },
      { path: alpha, before: 1 },
      { path: alpha, before: "relative/path" },
      { path: alpha, before: `${cwd}\u007f` },
      { path: alpha, before: { path: cwd } },
      { path: alpha, before: cwd, pinned: false },
    ]) {
      assert.equal(
        (await post("/api/workspaces/order", body)).status,
        400,
        JSON.stringify(body),
      );
    }
    assert.equal(await readFile(metadata, "utf8"), original);
    for (const body of [
      { path: join(cwd, "unknown"), before: alpha },
      { path: alpha, before: join(cwd, "unknown") },
    ]) {
      const response = await post("/api/workspaces/order", body);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "WORKSPACE_ORDER_CHANGED");
    }
    assert.equal(await readFile(metadata, "utf8"), original);
    assert.equal(
      (
        await post("/api/sidebar/pin", {
          target: { kind: "workspace", path: beta },
          pinned: true,
        })
      ).status,
      200,
    );
    const pinned = await readFile(metadata, "utf8");
    assert.equal(
      (await post("/api/workspaces/order", { path: alpha, before: beta }))
        .status,
      409,
    );
    assert.equal(await readFile(metadata, "utf8"), pinned);
    const moved = await post("/api/workspaces/order", {
      path: beta,
      before: alpha,
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), { saved: true });
    const snapshot = await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json();
    assert.deepEqual(
      snapshot.workspaces.map((workspace: { path: string }) => workspace.path),
      [cwd, beta, alpha],
    );
    assert.ok(
      snapshot.workspaces.every(
        (workspace: { pinOrder?: number }) => workspace.pinOrder === undefined,
      ),
    );
    assert.equal(
      snapshot.currentSessionId,
      runtime.sessionManager.getSessionId(),
    );
    const saved = JSON.parse(await readFile(metadata, "utf8"));
    assert.deepEqual(saved.workspaceOrder, [cwd, beta, alpha]);
    assert.deepEqual(saved.sidebarPins, []);
    assert.equal(
      (await post("/api/workspaces/order", { path: beta, before: null }))
        .status,
      200,
    );
    assert.deepEqual(
      JSON.parse(await readFile(metadata, "utf8")).workspaceOrder,
      [cwd, alpha, beta],
    );
    assert.equal(prompts, 0);
    assert.equal(selections, 0);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sidebar metadata APIs authenticate mixed pins and exact Session read receipts without a model turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-sidebar-host-"));
  let prompts = 0;
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "Fixture", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("Fixture result"));
  const runtime = {
    ...testRuntime(cwd, async () => {
      prompts++;
      return { pendingFollowUps: 0 };
    }),
    sessionManager: manager,
  };
  const id = runtime.sessionManager.getSessionId();
  const path = manager.getSessionFile()!;
  let turn = {
    commandId: "first",
    finishedAt: 100,
    outcome: "completed" as const,
  };
  const publish = () =>
    manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
      version: 1,
      unreadEligible: true,
      sessionId: id,
      epoch: 1,
      startedAt: turn.finishedAt - 1,
      elapsedMs: 1,
      ...turn,
    });
  publish();
  runtime.getSessionExecution = (sessionId, sessionPath) => ({
    sessionId,
    sessionPath,
    status: "idle",
    liveTools: [],
    liveToolsOmitted: 0,
    lastTurn: turn,
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const post = (route: string, body: unknown, authorized = true) =>
    fetch(`${launched.origin}${route}`, {
      method: "POST",
      headers: {
        ...(authorized ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const currentRevision = async () => {
    const snapshot = await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json();
    return snapshot.sessions.find(
      (session: { path: string }) => session.path === path,
    ).readRevision as string;
  };
  try {
    const project = { kind: "workspace", path: cwd };
    const conversation = { kind: "session", path, id };
    assert.equal(
      (await post("/api/sidebar/pin", { target: project, pinned: true }, false))
        .status,
      401,
    );
    for (const body of [
      { target: { ...project, id }, pinned: true },
      { target: { kind: "session", path }, pinned: true },
      { target: project, pinned: "true" },
      {
        target: project,
        pinned: true,
        before: { kind: "connection", path: cwd },
      },
      {
        target: project,
        pinned: true,
        before: { ...conversation, unrelated: true },
      },
      { target: project, pinned: true, command: "private" },
    ])
      assert.equal((await post("/api/sidebar/pin", body)).status, 400);
    assert.equal(
      (await post("/api/sidebar/pin", { target: conversation, pinned: true }))
        .status,
      200,
    );
    assert.equal(
      (
        await post("/api/sidebar/pin", {
          target: project,
          pinned: true,
          before: conversation,
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("/api/sessions/order", { path, id, before: null })).status,
      200,
    );
    assert.equal(
      (
        await post("/api/sessions/order", {
          path,
          id,
          before: { path, id, extra: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/sessions/read", { path, id, read: false }, false))
        .status,
      401,
    );
    assert.equal(
      (
        await post("/api/sessions/read", {
          path,
          id: "foreign",
          read: false,
          expectedRevision: await currentRevision(),
        })
      ).status,
      409,
    );
    for (const expectedRevision of [
      undefined,
      null,
      [],
      "",
      "a".repeat(201),
      "bad\nrevision",
      { commandId: "first", finishedAt: 100 },
    ])
      assert.equal(
        (
          await post("/api/sessions/read", {
            path,
            id,
            read: true,
            expectedRevision,
          })
        ).status,
        400,
      );
    const observed = await currentRevision();
    assert.equal(
      (
        await post("/api/sessions/read", {
          path,
          id,
          read: true,
          expectedRevision: observed,
        })
      ).status,
      200,
    );
    const afterRead = await currentRevision();
    assert.notEqual(afterRead, observed);
    assert.equal(
      (
        await post("/api/sessions/read", {
          path,
          id,
          read: false,
          expectedRevision: afterRead,
        })
      ).status,
      200,
    );
    const afterMark = await currentRevision();
    assert.notEqual(afterMark, afterRead);
    assert.equal(
      (
        await post("/api/sessions/read", {
          path,
          id,
          read: true,
          expectedRevision: afterRead,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("/api/sessions/read", {
          path,
          id,
          read: false,
          expectedRevision: afterRead,
        })
      ).status,
      409,
    );
    turn = { ...turn, commandId: "second", finishedAt: 200 };
    publish();
    const stale = await post("/api/sessions/read", {
      path,
      id,
      read: true,
      expectedRevision: afterMark,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "SESSION_READ_STATE_CHANGED");
    const snapshot = await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json();
    assert.equal(snapshot.workspaces[0].pinOrder, 0);
    assert.equal(snapshot.sessions[0].pinOrder, 1);
    assert.equal(snapshot.sessions[0].order, 0);
    assert.equal(snapshot.sessions[0].unread, true);
    assert.equal(prompts, 0);
    assert.equal(runtime.sessionManager.getEntries().length, 4);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("account login routes require authenticated exact ownership, validate responses and redact native failures", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-login-host-"));
  const runtime = testRuntime(cwd);
  const service = new WebProviderLoginService();
  const sessionId = runtime.sessionManager.getSessionId();
  let starts = 0;
  let logouts = 0;
  runtime.startProviderLogin = async (owner, provider) => {
    starts++;
    return service.start(owner, provider, async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "FIXTURE-CODE",
        verificationUri: "https://accounts.example/device",
      });
      await interaction.prompt({ type: "secret", message: "Code" });
      return {};
    });
  };
  runtime.readProviderLogin = (owner, id) => service.read(owner, id);
  runtime.respondProviderLogin = (owner, id, prompt, value) =>
    service.respond(owner, id, prompt, value);
  runtime.cancelProviderLogin = (owner, id) => service.cancel(owner, id);
  runtime.logoutProvider = async () => {
    logouts++;
    return {};
  };
  const { host, launched, headers } = await startTestHost(runtime);
  t.after(async () => {
    await service.dispose();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  const post = (path: string, body: object, authenticated = true) =>
    fetch(`${launched.origin}/api/providers/${path}`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const read = (query: string, authenticated = true) =>
    fetch(`${launched.origin}/api/providers/login?${query}`, {
      headers: authenticated ? headers : {},
    });
  assert.equal(
    (await post("login", { sessionId, provider: "fixture" }, false)).status,
    401,
  );
  assert.equal((await read(`sessionId=${sessionId}`, false)).status, 401);
  for (const body of [
    { sessionId, provider: "fixture", injected: true },
    { sessionId, provider: "invalid/provider" },
    { sessionId: "", provider: "fixture" },
  ])
    assert.equal((await post("login", body)).status, 400);
  assert.equal(
    (await post("login", { sessionId: "stale", provider: "fixture" })).status,
    409,
  );
  assert.equal(starts, 0);
  assert.equal(
    (await read(`sessionId=${sessionId}&sessionId=${sessionId}`)).status,
    400,
  );
  assert.equal((await read(`sessionId=${sessionId}&value=secret`)).status, 400);
  assert.equal((await read("sessionId=stale")).status, 409);
  assert.equal(await (await read(`sessionId=${sessionId}`)).json(), null);
  const response = await post("login", { sessionId, provider: "fixture" });
  assert.equal(response.status, 200);
  const flow = (await response.json()) as { id: string };
  const current = (await (
    await read(`sessionId=${sessionId}&id=${flow.id}`)
  ).json()) as { device: { code: string }; prompt: { id: string } };
  assert.equal(current.device.code, "FIXTURE-CODE");
  assert.equal(
    (
      await post("login/respond", {
        sessionId,
        id: flow.id,
        promptId: "stale",
        value: "private-response",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post("login/respond", {
        sessionId,
        id: flow.id,
        promptId: current.prompt.id,
        value: "x".repeat(8193),
      })
    ).status,
    400,
  );
  assert.equal(
    (await post("login/cancel", { sessionId: "stale", id: flow.id })).status,
    409,
  );
  assert.equal(
    (await post("login/cancel", { sessionId, id: flow.id })).status,
    200,
  );
  await service.dispose();
  assert.equal(
    (await post("logout", { sessionId: "stale", provider: "fixture" })).status,
    409,
  );
  assert.equal(logouts, 0);
  assert.equal(
    (await post("logout", { sessionId, provider: "fixture" })).status,
    200,
  );
  assert.equal(logouts, 1);
  runtime.startProviderLogin = async () => {
    throw new Error("private-native-credential-error");
  };
  const failure = await post("login", { sessionId, provider: "fixture" });
  assert.equal(failure.status, 422);
  assert.equal((await failure.text()).includes("private-native"), false);
});

test("compaction and queue endpoints require authenticated exact active ownership and bounded typed input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-compact-"));
  const runtime = testRuntime(cwd);
  const { host, launched, headers } = await startTestHost(runtime);
  const identity = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
  };
  const calls: unknown[] = [];
  const post = (route: string, body: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? headers : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    for (const [route, request] of [
      ["compact", identity],
      ["prompt-queue", { ...identity, action: "clear" }],
    ] as const) {
      assert.equal((await post(route, request, false)).status, 401);
      assert.equal((await post(route, request)).status, 501);
      assert.equal(
        (await post(route, { ...request, extra: true })).status,
        400,
      );
      assert.equal(
        (await post(route, { ...request, sessionPath: "/copied.jsonl" }))
          .status,
        409,
      );
      assert.equal(
        (await post(route, { ...request, sessionId: "another" })).status,
        409,
      );
    }
    assert.equal(
      (await post("prompt-queue", { ...identity, action: "send" })).status,
      400,
    );
    runtime.compactSession = async (request) => {
      calls.push(request);
    };
    runtime.updatePromptQueue = (request) => {
      calls.push(request);
    };
    assert.equal((await post("compact", identity)).status, 200);
    assert.equal(
      (await post("prompt-queue", { ...identity, action: "retry" })).status,
      200,
    );
    assert.deepEqual(calls, [identity, { ...identity, action: "retry" }]);
    runtime.compactSession = async () => {
      throw new WebRuntimeRequestError("Busy", "SESSION_CONFLICT", 409);
    };
    assert.equal((await post("compact", identity)).status, 409);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external file preview requires an explicit authenticated single-file grant", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-external-http-"));
  const outside = await mkdtemp(join(tmpdir(), "openpi-external-source-"));
  const file = join(outside, "index.ts");
  await writeFile(file, "export const verified = true;");
  const runtime = testRuntime(cwd);
  const sessionId = runtime.sessionManager.getSessionId();
  const { host, launched, headers } = await startTestHost(runtime);
  const body = JSON.stringify({
    sessionId,
    reference: file,
    access: "read-external-file",
  });
  try {
    assert.equal(
      (
        await fetch(`${launched.origin}/api/artifacts/authorize-file`, {
          method: "POST",
          body,
        })
      ).status,
      401,
    );
    const ordinary = await fetch(`${launched.origin}/api/artifacts/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, reference: file, access: "read-file" }),
    });
    assert.equal(ordinary.status, 403);
    const allowed = await fetch(
      `${launched.origin}/api/artifacts/authorize-file`,
      { method: "POST", headers, body },
    );
    assert.equal(allowed.status, 200);
    const { handle } = await allowed.json();
    const preview = await fetch(
      `${launched.origin}/api/artifacts/content?${new URLSearchParams({ sessionId, handle })}`,
      { headers },
    );
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).text, "export const verified = true;");
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("exposes an active-Session interactive terminal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-tools-"));
  const runtime = testRuntime(cwd);
  const sessionId = runtime.sessionManager.getSessionId();
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  let disposed = false;
  let subscribedAfter: number | undefined;
  let terminalListener:
    | ((event: WebInteractiveTerminalEvent) => void)
    | undefined;
  const terminal = {
    id: "terminal-1",
    sessionId,
    cwd,
    exited: false,
    exitCode: null,
  };
  const interactiveTerminals: InteractiveTerminalService = {
    async create(options) {
      assert.deepEqual(options, {
        sessionId,
        cwd,
        cols: 80,
        rows: 24,
        ...(options.createKey ? { createKey: "terminal:second:0" } : {}),
      });
      return { ...terminal, reused: false };
    },
    get(owner, id) {
      return owner === sessionId && id === terminal.id ? terminal : undefined;
    },
    write(owner, id, data) {
      if (owner !== sessionId || id !== terminal.id) return false;
      writes.push(data);
      return true;
    },
    resize(owner, id, cols, rows) {
      if (owner !== sessionId || id !== terminal.id) return false;
      sizes.push([cols, rows]);
      return true;
    },
    subscribe(owner, id, listener, after) {
      if (owner !== sessionId || id !== terminal.id) return undefined;
      subscribedAfter = after;
      terminalListener = listener;
      return {
        output: {
          type: "output",
          data: "prompt> ",
          offset: 8,
          reset: true,
        },
        exited: false,
        exitCode: null,
        unsubscribe() {
          terminalListener = undefined;
        },
      };
    },
    close(owner, id) {
      if (owner !== sessionId || id !== terminal.id) return false;
      terminalListener?.({ type: "closed" });
      return true;
    },
    retain() {},
    dispose() {
      disposed = true;
    },
  };
  const { host, launched, headers } = await startTestHost(runtime, {
    interactiveTerminals,
  });
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  try {
    const created = await fetch(`${launched.origin}/api/terminal`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId, cols: 80, rows: 24 }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).id, terminal.id);
    const independent = await fetch(`${launched.origin}/api/terminal`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        sessionId,
        cols: 80,
        rows: 24,
        createKey: "terminal:second:0",
      }),
    });
    assert.equal(independent.status, 201);
    for (const createKey of ["x".repeat(161), "bad\nkey", 1, null]) {
      const invalid = await fetch(`${launched.origin}/api/terminal`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ sessionId, cols: 80, rows: 24, createKey }),
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal(
      (
        await fetch(
          `${launched.origin}/api/terminal?sessionId=${sessionId}&id=${terminal.id}`,
          { headers },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/terminal/input`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ sessionId, id: terminal.id, data: "pwd\r" }),
        })
      ).status,
      200,
    );
    assert.deepEqual(writes, ["pwd\r"]);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/terminal/resize`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            sessionId,
            id: terminal.id,
            cols: 100,
            rows: 30,
          }),
        })
      ).status,
      200,
    );
    assert.deepEqual(sizes, [[100, 30]]);

    const stream = await fetch(
      `${launched.origin}/api/terminal/events?sessionId=${sessionId}&id=${terminal.id}&after=3`,
      { headers },
    );
    assert.equal(stream.status, 200);
    assert.match(
      stream.headers.get("content-type") ?? "",
      /text\/event-stream/u,
    );
    assert.equal(subscribedAfter, 3);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let streamed = "";
    while (!streamed.includes("prompt> ")) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      assert.equal(next.done, false);
      streamed += decoder.decode(next.value, { stream: true });
    }
    assert.match(streamed, /"reset":true/u);
    terminalListener?.({ type: "output", data: "ready\r\n", offset: 15 });
    while (!streamed.includes("ready\\r\\n")) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      assert.equal(next.done, false);
      streamed += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();

    const closed = await fetch(
      `${launched.origin}/api/terminal?sessionId=${sessionId}&id=${terminal.id}`,
      { method: "DELETE", headers },
    );
    assert.equal(closed.status, 200);
  } finally {
    await host.stop();
    assert.equal(disposed, true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects terminal creation when the active Session changes during admission", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-terminal-admission-"));
  const runtime = testRuntime(cwd);
  let activeSessionManager = runtime.sessionManager;
  Object.defineProperty(runtime, "sessionManager", {
    configurable: true,
    get: () => activeSessionManager,
  });
  const sessionId = activeSessionManager.getSessionId();
  let createCalls = 0;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const interactiveTerminals: InteractiveTerminalService = {
    async create() {
      createCalls += 1;
      throw new Error("stale terminal creation should be rejected");
    },
    get: () => undefined,
    write: () => false,
    resize: () => false,
    subscribe: () => undefined,
    close: () => false,
    retain() {},
    dispose() {},
  };
  const originalRequireWorkspace = PiWebAdapter.prototype.requireWorkspace;
  const { host, launched, headers } = await startTestHost(runtime, {
    interactiveTerminals,
  });
  PiWebAdapter.prototype.requireWorkspace = async function (path) {
    entered();
    await releasePromise;
    return originalRequireWorkspace.call(this, path);
  };
  try {
    const pending = fetch(`${launched.origin}/api/terminal`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, cols: 80, rows: 24 }),
    });
    await enteredPromise;
    activeSessionManager = SessionManager.inMemory(cwd);
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "SESSION_CHANGED");
    assert.equal(createCalls, 0);
  } finally {
    PiWebAdapter.prototype.requireWorkspace = originalRequireWorkspace;
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serves Session-bound command discovery with fail-closed request validation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-commands-"));
  const runtime = testRuntime(cwd);
  let workspaceSelected = true;
  Object.defineProperty(runtime, "workspaceSelected", {
    configurable: true,
    get: () => workspaceSelected,
  });
  runtime.listCommands = () => ({
    commands: [
      {
        name: "review",
        description: "Review the current change",
        source: "prompt",
        availability: "available",
        argumentHint: "[arguments]",
      },
    ],
    totalAvailable: 1,
    truncation: {
      truncated: false,
      commandsOmitted: 0,
      maxCommands: 250,
      maxBytes: 64 * 1024,
      bytes: 256,
    },
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const sessionId = runtime.sessionManager.getSessionId();
  try {
    assert.equal(
      (await fetch(`${launched.origin}/api/commands?sessionId=${sessionId}`))
        .status,
      401,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/commands?sessionId=${sessionId}`, {
          method: "POST",
          headers,
        })
      ).status,
      405,
    );
    for (const suffix of [
      "",
      "?sessionId=",
      `?sessionId=${sessionId}&extra=true`,
      `?sessionId=${sessionId}&sessionId=${sessionId}`,
    ]) {
      const response = await fetch(`${launched.origin}/api/commands${suffix}`, {
        headers,
      });
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).code,
        "INVALID_COMMAND_DISCOVERY_REQUEST",
      );
    }
    const stale = await fetch(
      `${launched.origin}/api/commands?sessionId=stale-session`,
      { headers },
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "SESSION_CHANGED");

    workspaceSelected = false;
    const noWorkspace = await fetch(
      `${launched.origin}/api/commands?sessionId=${sessionId}`,
      { headers },
    );
    assert.equal(noWorkspace.status, 409);
    assert.equal((await noWorkspace.json()).code, "WORKSPACE_REQUIRED");

    workspaceSelected = true;
    const listCommands = runtime.listCommands;
    delete runtime.listCommands;
    const unavailable = await fetch(
      `${launched.origin}/api/commands?sessionId=${sessionId}`,
      { headers },
    );
    assert.equal(unavailable.status, 501);
    assert.equal(
      (await unavailable.json()).code,
      "COMMAND_DISCOVERY_UNAVAILABLE",
    );
    runtime.listCommands = listCommands;

    const response = await fetch(
      `${launched.origin}/api/commands?sessionId=${sessionId}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"name":"review"/u);
    assert.doesNotMatch(body, /sourceInfo|\/private\/|private-fixture/u);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resource reload validates its target and reports native conflicts without a success receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-resource-reload-"));
  const runtime = testRuntime(cwd);
  const attempts: Array<{ sessionId: string; sessionPath: string }> = [];
  let conflict = false;
  runtime.reloadSettingsResources = async (sessionId, sessionPath) => {
    attempts.push({ sessionId, sessionPath });
    if (conflict)
      throw new WebRuntimeRequestError("stale target", "SESSION_CONFLICT", 409);
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const target = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: "/fixture/current.jsonl",
  };
  const post = (body: unknown) =>
    fetch(`${launched.origin}/api/settings/reload`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({ sessionId: target.sessionId })).status, 400);
    assert.equal(
      (await post({ ...target, source: "npm:unexpected" })).status,
      400,
    );
    assert.equal(attempts.length, 0);
    const success = await post(target);
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { reloaded: true });
    assert.deepEqual(attempts, [target]);
    conflict = true;
    const rejected = await post(target);
    assert.equal(rejected.status, 409);
    const receipt = await rejected.json();
    assert.equal(receipt.code, "SESSION_CONFLICT");
    assert.equal(receipt.reloaded, undefined);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serves a Session-bound settings catalog and rejects unsupported preference request shapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-settings-"));
  const runtime = testRuntime(cwd);
  let workspaceSelected = true;
  Object.defineProperty(runtime, "workspaceSelected", {
    configurable: true,
    get: () => workspaceSelected,
  });
  runtime.listSettingsResources = () => ({
    skills: [],
    plugins: [],
    totals: { extensions: 2, skills: 0, prompts: 0, themes: 1 },
    diagnostics: { extensionErrors: 0, skillErrors: 0 },
    truncation: {
      truncated: false,
      skillsOmitted: 0,
      pluginsOmitted: 0,
      resourcesOmitted: 0,
    },
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const sessionId = runtime.sessionManager.getSessionId();
  try {
    const invalid = await fetch(`${launched.origin}/api/settings/catalog`, {
      headers,
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).code,
      "INVALID_SETTINGS_CATALOG_REQUEST",
    );

    const stale = await fetch(
      `${launched.origin}/api/settings/catalog?sessionId=stale-session`,
      { headers },
    );
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "SESSION_CHANGED");

    workspaceSelected = false;
    const noWorkspace = await fetch(
      `${launched.origin}/api/settings/catalog?sessionId=${sessionId}`,
      { headers },
    );
    assert.equal(noWorkspace.status, 409);
    assert.equal((await noWorkspace.json()).code, "WORKSPACE_REQUIRED");

    workspaceSelected = true;
    const response = await fetch(
      `${launched.origin}/api/settings/catalog?sessionId=${sessionId}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sessionId: string;
      setup: {
        ui: {
          webTheme: string;
          webChatWidth: number;
          webChatFontSize: number;
          webExpandThinking: boolean;
        };
      };
      resources: { totals: { extensions: number } };
    };
    assert.equal(body.sessionId, sessionId);
    assert.equal(typeof body.setup.ui.webTheme, "string");
    assert.equal(typeof body.setup.ui.webChatWidth, "number");
    assert.equal(typeof body.setup.ui.webChatFontSize, "number");
    assert.equal(typeof body.setup.ui.webExpandThinking, "boolean");
    assert.equal(body.resources.totals.extensions, 2);

    const writeAttempt = await fetch(
      `${launched.origin}/api/settings/preferences`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          preferences: {
            theme: "dark",
            chatWidth: 960,
            chatFontSize: 16,
            expandThinking: true,
          },
        }),
      },
    );
    assert.equal(writeAttempt.status, 400);
    assert.deepEqual(await writeAttempt.json(), {
      error: "Invalid Web appearance preferences",
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("archived queries stop native discovery on browser disconnect and reject ambiguous inputs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-archive-cancel-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  let started!: (signal: AbortSignal) => void;
  const ready = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  const listing = t.mock.method(
    PiWebAdapter.prototype,
    "listArchivedSessions",
    async (_options: unknown, signal?: AbortSignal) => {
      assert.ok(signal);
      started(signal);
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      throw new Error("Cancelled listing must never complete");
    },
  );
  try {
    for (const query of [
      "q=one&q=two",
      "cursor=a&cursor=b",
      "limit=1&limit=2",
      "unexpected=true",
    ]) {
      assert.equal(
        (
          await fetch(`${launched.origin}/api/sessions/archived?${query}`, {
            headers,
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await fetch(`${launched.origin}/api/sessions/archived`, {
          method: "POST",
          headers,
        })
      ).status,
      405,
    );
    assert.equal(listing.mock.callCount(), 0);
    const controller = new AbortController();
    const pending = fetch(`${launched.origin}/api/sessions/archived`, {
      headers,
      signal: controller.signal,
    });
    const cancelled = assert.rejects(pending, { name: "AbortError" });
    const nativeSignal = await ready;
    const stopped = new Promise<void>((resolve) =>
      nativeSignal.addEventListener("abort", () => resolve(), { once: true }),
    );
    controller.abort();
    await cancelled;
    await stopped;
    assert.equal(nativeSignal.aborted, true);
    assert.equal(
      (await fetch(`${launched.origin}/api/snapshot`, { headers })).status,
      200,
    );
  } finally {
    listing.mock.restore();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("thinking filters persist as presentation only and catalog capabilities remain native Session projections", async () => {
  const path = join(hostAgentDirectory, "my-pi-setup.json");
  const before = await readFile(path, "utf8").catch(() => undefined);
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-thinking-filter-"));
  const runtime = testRuntime(cwd);
  runtime.isIdle = () => false;
  let prompted = 0;
  let changedEffort = 0;
  runtime.sendPrompt = async () => {
    prompted++;
    return { pendingFollowUps: 0 };
  };
  runtime.getThinkingState = () => ({
    level: "high",
    available: ["off", "minimal", "high"],
    supported: true,
  });
  runtime.setThinkingLevel = async () => {
    changedEffort++;
    return runtime.getThinkingState!();
  };
  runtime.getResponseSupport = () => ({
    verbosity: true,
    reasoningSummary: true,
  });
  runtime.listSettingsResources = () => ({
    skills: [],
    plugins: [],
    totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
    diagnostics: { extensionErrors: 0, skillErrors: 0 },
    truncation: {
      truncated: false,
      skillsOmitted: 0,
      pluginsOmitted: 0,
      resourcesOmitted: 0,
    },
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const post = (body: unknown) =>
    fetch(`${launched.origin}/api/settings/preferences`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await writeFile(
      path,
      JSON.stringify({
        configVersion: 1,
        response: { verbosity: "high", reasoningSummary: "concise" },
        ui: { webTheme: "pine" },
        future: { keep: true },
      }),
    );
    for (const hiddenThinkingLevels of [
      ["unknown"],
      ["high", "high"],
      "high",
      null,
      Array(8).fill("high"),
    ]) {
      assert.equal((await post({ hiddenThinkingLevels })).status, 400);
    }
    assert.equal((await post({ response: { verbosity: "low" } })).status, 400);
    const saved = await post({
      hiddenThinkingLevels: ["minimal", "high", "max"],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).setup.ui.webHiddenThinkingLevels, [
      "minimal",
      "high",
      "max",
    ]);
    const canonical = await readFile(path, "utf8");
    assert.equal(JSON.parse(canonical).future.keep, true);
    assert.deepEqual(loadSetupConfig().response, {
      verbosity: "high",
      reasoningSummary: "concise",
    });
    assert.equal(loadSetupConfig().ui.webTheme, "pine");
    const snapshot = await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json();
    assert.deepEqual(snapshot.preferences.hiddenThinkingLevels, [
      "minimal",
      "high",
      "max",
    ]);
    const catalog = await (
      await fetch(
        `${launched.origin}/api/settings/catalog?sessionId=${runtime.sessionManager.getSessionId()}`,
        { headers },
      )
    ).json();
    assert.deepEqual(catalog.responseSupport, {
      verbosity: true,
      reasoningSummary: true,
    });
    assert.deepEqual(catalog.setup.response, {
      verbosity: "high",
      reasoningSummary: "concise",
    });
    assert.equal(catalog.thinking.level, "high");
    assert.deepEqual(catalog.thinking.available, ["off", "minimal", "high"]);
    assert.equal(catalog.thinking.supported, true);
    assert.equal(catalog.setupWritable, true);
    assert.equal(prompted, 0);
    assert.equal(changedEffort, 0);
    await writeFile(path, "{invalid fixture");
    const damagedCatalog = await (
      await fetch(
        `${launched.origin}/api/settings/catalog?sessionId=${runtime.sessionManager.getSessionId()}`,
        { headers },
      )
    ).json();
    assert.equal(damagedCatalog.setupWritable, false);
    assert.deepEqual(damagedCatalog.setupDiagnostics, [
      { severity: "error", path: "", message: "Malformed JSON" },
    ]);
    assert.equal(damagedCatalog.resources.diagnostics.settingsErrors, 1);
    assert.doesNotMatch(JSON.stringify(damagedCatalog), /invalid fixture/);
    assert.equal((await post({ hiddenThinkingLevels: [] })).status, 422);
    assert.equal(await readFile(path, "utf8"), "{invalid fixture");
    await writeFile(
      path,
      JSON.stringify({
        configVersion: 1,
        response: { verbosity: "private-invalid-value" },
      }),
    );
    const invalidCatalog = await (
      await fetch(
        `${launched.origin}/api/settings/catalog?sessionId=${runtime.sessionManager.getSessionId()}`,
        { headers },
      )
    ).json();
    assert.equal(invalidCatalog.setupWritable, false);
    assert.deepEqual(invalidCatalog.setupDiagnostics, [
      {
        severity: "error",
        path: "response.verbosity",
        message: "Invalid or unsupported value",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(invalidCatalog),
      /private-invalid-value/,
    );
    await writeFile(path, canonical);
    const repairedCatalog = await (
      await fetch(
        `${launched.origin}/api/settings/catalog?sessionId=${runtime.sessionManager.getSessionId()}`,
        { headers },
      )
    ).json();
    assert.equal(repairedCatalog.setupWritable, true);
    assert.equal(repairedCatalog.resources.diagnostics.settingsErrors, 0);
    assert.deepEqual(repairedCatalog.setup.response, {
      verbosity: "high",
      reasoningSummary: "concise",
    });
    const refreshed = await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json();
    assert.deepEqual(refreshed.preferences.hiddenThinkingLevels, [
      "minimal",
      "high",
      "max",
    ]);
    assert.equal((await post({ hiddenThinkingLevels: [] })).status, 200);
    assert.deepEqual(loadSetupConfig().ui.webHiddenThinkingLevels, []);
    assert.equal(prompted, 0);
    assert.equal(changedEffort, 0);
  } finally {
    await host.stop();
    if (before === undefined) await rm(path, { force: true });
    else await writeFile(path, before);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("classifies invalid and oversized JSON bodies as client errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-request-body-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const invalidJson = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: '{"path":',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
      code: "INVALID_REQUEST_BODY",
      error: "request body is invalid JSON",
    });

    const nonObjectJson = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(nonObjectJson.status, 400);
    assert.deepEqual(await nonObjectJson.json(), {
      code: "INVALID_REQUEST_BODY",
      error: "request body must be an object",
    });

    const oversizedBody = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "x".repeat(16 * 1024) }),
    });
    assert.equal(oversizedBody.status, 413);
    assert.deepEqual(await oversizedBody.json(), {
      code: "REQUEST_BODY_TOO_LARGE",
      error: "request body is too large",
      maxBytes: 16 * 1024,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("classifies an oversized body sent in multiple chunks as a client error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-request-chunks-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const bodyLength = 64 * 1024;
  let request: ReturnType<typeof httpRequest> | undefined;
  const responsePromise = new Promise<{
    statusCode: number | undefined;
    body: string;
  }>((resolve, reject) => {
    request = httpRequest(
      {
        hostname: launched.hostname,
        port: Number(launched.port),
        path: "/api/workspaces",
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": bodyLength,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, body }),
        );
      },
    );
    request.once("error", reject);
    request.write(Buffer.alloc(20 * 1024, "a"));
  });

  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for early 413 response")),
        2_000,
      );
      timer.unref();
    });
    const response = await Promise.race([responsePromise, timeout]);
    assert.equal(response.statusCode, 413);
    assert.deepEqual(JSON.parse(response.body), {
      code: "REQUEST_BODY_TOO_LARGE",
      error: "request body is too large",
      maxBytes: 16 * 1024,
    });
  } finally {
    request?.destroy();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps unexpected Web Host failures classified as server errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-server-error-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const adapter = (
    host as unknown as {
      adapter: { importWorkspace(path: string): Promise<string> };
    }
  ).adapter;
  adapter.importWorkspace = async () => {
    throw new Error("unexpected adapter failure");
  };
  try {
    const response = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "unexpected adapter failure",
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("quiet SSE clients receive heartbeats without advancing the event cursor", {
  timeout: 2_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-heartbeat-"));
  const host = new WebHost({
    runtime: testRuntime(cwd),
    sseHeartbeatMs: 10,
  });
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const before = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for an SSE heartbeat")),
        1_000,
      );
      request = httpRequest(
        {
          hostname: launched.hostname,
          port: Number(launched.port),
          path: `/events?cursor=${before.cursor}`,
          headers,
        },
        (response) => {
          assert.equal(response.statusCode, 200);
          response.setEncoding("utf8");
          let received = "";
          response.on("data", (chunk: string) => {
            received += chunk;
            if (!received.includes(": heartbeat\n\n")) return;
            clearTimeout(timeout);
            resolve();
          });
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.end();
    });
    const after = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    assert.equal(after.cursor, before.cursor);
  } finally {
    request?.destroy();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adapter initialization fails before the Host starts listening", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-startup-failure-"));
  const runtime = testRuntime(cwd);
  const host = new WebHost({ runtime });
  const adapter = (
    host as unknown as { adapter: { initialize(): Promise<void> } }
  ).adapter;
  adapter.initialize = async () => {
    throw new Error("metadata initialization failed");
  };
  try {
    await assert.rejects(host.start(), /metadata initialization failed/u);
    assert.equal(
      (host as unknown as { server: { listening: boolean } }).server.listening,
      false,
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function readEventRecords(response: Response, count: number) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const records: Array<{
    id: number;
    event: { sequence: number; type: string; detail?: Record<string, unknown> };
  }> = [];
  while (records.length < count) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const id = frame
        .split("\n")
        .find((line) => line.startsWith("id: "))
        ?.slice(4);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!id || !data) continue;
      records.push({
        id: Number(id),
        event: JSON.parse(data) as {
          sequence: number;
          type: string;
          detail?: Record<string, unknown>;
        },
      });
    }
  }
  await reader.cancel();
  return records.slice(0, count);
}

test("rejects prompt admission with the runtime's typed receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-reject-"));
  const rejection = new WebRuntimeRequestError(
    "Pi rejected this prompt",
    "PROMPT_REJECTED",
    422,
  );
  let sendCalls = 0;
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    throw rejection;
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const response = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "reject me",
        commandId: "rejected-admission",
        retry: false,
      }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      code: "PROMPT_REJECTED",
      error: "Pi rejected this prompt",
    });
    const replay = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "reject me",
        commandId: "rejected-admission",
        retry: true,
      }),
    });
    assert.equal(replay.status, 422);
    assert.deepEqual(await replay.json(), {
      code: "PROMPT_REJECTED",
      error: "Pi rejected this prompt",
    });
    assert.equal(sendCalls, 1);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prompt delivery binds steering to one turn and replays only the same admission", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-steer-host-"));
  const calls: Parameters<WebRuntimeController["sendPrompt"]>[1][] = [];
  const runtime = testRuntime(cwd, async (_content, options) => {
    calls.push(options);
    return { pendingFollowUps: 1, pendingSteering: 2, delivery: "steer" };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const prompt = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
    content: "Use the corrected constraint",
    commandId: "steer-admission",
    streamingBehavior: "steer",
    expectedTurnCommandId: "running-turn",
  };
  const post = (body: unknown) =>
    fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const invalid of [
      { ...prompt, streamingBehavior: "unknown" },
      { ...prompt, expectedTurnCommandId: undefined },
      { ...prompt, expectedTurnCommandId: "x".repeat(129) },
      { ...prompt, expectedTurnCommandId: "bad\u0000turn" },
      { ...prompt, planRevision: "ready-plan" },
      { ...prompt, streamingBehavior: "followUp" },
    ]) {
      const response = await post(invalid);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_PROMPT_DELIVERY");
    }
    assert.equal(calls.length, 0);
    const admitted = await post(prompt);
    assert.equal(admitted.status, 202);
    const receipt = await admitted.json();
    assert.equal(receipt.pendingSteering, 2);
    assert.equal(receipt.delivery, "steer");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.streamingBehavior, "steer");
    assert.equal(calls[0]?.expectedTurnCommandId, "running-turn");
    const replay = await post({ ...prompt, retry: true });
    assert.deepEqual(await replay.json(), receipt);
    for (const conflict of [
      { ...prompt, expectedTurnCommandId: "another-turn", retry: true },
      {
        ...prompt,
        streamingBehavior: "followUp",
        expectedTurnCommandId: undefined,
        retry: true,
      },
    ]) {
      const response = await post(conflict);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "COMMAND_CONFLICT");
    }
    assert.equal(calls.length, 1);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider retry admissions bind the exact failed entry without requiring a second user prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-provider-retry-"));
  const calls: Parameters<WebRuntimeController["sendPrompt"]>[] = [];
  const runtime = testRuntime(cwd, async (...args) => {
    calls.push(args);
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const body = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
    commandId: "retry-failure",
    content: "",
    retryEntryId: "failed-entry",
  };
  const post = (data: unknown) =>
    fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    for (const invalid of [
      { ...body, retryEntryId: "" },
      { ...body, retryEntryId: "x".repeat(129) },
      { ...body, streamingBehavior: "steer", expectedTurnCommandId: "turn" },
      { ...body, planRevision: "plan" },
      { ...body, content: "A different task" },
    ])
      assert.equal((await post(invalid)).status, 400);
    const admitted = await post(body);
    assert.equal(admitted.status, 202);
    const receipt = await admitted.json();
    assert.deepEqual(
      await (await post({ ...body, retry: true })).json(),
      receipt,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "");
    assert.equal(calls[0]![1]?.retryEntryId, "failed-entry");
    const conflict = await post({
      ...body,
      retryEntryId: "other-entry",
      retry: true,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "COMMAND_CONFLICT");
    assert.equal(calls.length, 1);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fork endpoint authenticates an exact Web-owned source and rejects extra authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-fork-host-"));
  const runtime = testRuntime(cwd);
  const entryId = runtime.sessionManager.appendMessage({
    role: "user",
    content: "Saved fork target",
    timestamp: Date.now(),
  });
  const calls: unknown[] = [];
  runtime.forkSession = async (request) => {
    calls.push(request);
    return {
      state: "cancelled",
      commandId: request.commandId,
      source: {
        sessionId: request.sessionId,
        sessionPath: request.sessionPath,
        entryId: request.entryId ?? entryId,
      },
    };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const request = {
    commandId: "fork-command",
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
    entryId,
  };
  const post = (body: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/session/fork`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post(request, false)).status, 401);
    for (const invalid of [
      { ...request, position: "before" },
      { ...request, prompt: "must never dispatch" },
      { ...request, commandId: "" },
      { ...request, entryId: "x".repeat(129) },
      { ...request, sessionId: "control\u0000id" },
      { ...request, rerun: { mode: "edit", content: "" } },
      { ...request, rerun: { mode: "edit", content: "x".repeat(12_001) } },
      { ...request, rerun: { mode: "edit", content: "Changed", images: [] } },
      { ...request, rerun: { mode: "regenerate", content: "Injected" } },
    ])
      assert.equal((await post(invalid)).status, 400);
    assert.equal(
      (await post({ ...request, sessionId: "copied-session-id" })).status,
      409,
    );
    assert.equal(
      (await post({ ...request, sessionPath: join(cwd, "outside.jsonl") }))
        .status,
      409,
    );
    assert.equal(calls.length, 0);
    const response = await post(request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "cancelled");
    assert.deepEqual(calls, [request]);
    const edit = {
      ...request,
      commandId: "edit-command",
      rerun: { mode: "edit", content: "Changed question" },
    };
    assert.equal((await post(edit)).status, 200);
    assert.deepEqual(calls.at(-1), edit);
    const regenerate = {
      ...request,
      commandId: "regenerate-command",
      rerun: { mode: "regenerate" },
    };
    assert.equal((await post(regenerate)).status, 200);
    assert.deepEqual(calls.at(-1), regenerate);
    const conversation = {
      scope: "conversation",
      commandId: "conversation-command",
      sessionId: request.sessionId,
      sessionPath: request.sessionPath,
    };
    for (const invalid of [
      { ...conversation, entryId },
      { ...conversation, rerun: { mode: "regenerate" } },
      { ...conversation, scope: "all" },
      { ...conversation, scope: "message" },
      { ...conversation, source: request },
      { ...conversation, environment: "cloud" },
      { ...conversation, environment: "worktree", cwd: "/untrusted-override" },
      { ...request, environment: "worktree" },
      { ...conversation, commandId: "" },
      { ...conversation, sessionPath: "bad\u0000path" },
    ])
      assert.equal((await post(invalid)).status, 400);
    const conversationFork = await post(conversation);
    assert.equal(conversationFork.status, 200);
    assert.equal((await conversationFork.json()).state, "cancelled");
    assert.deepEqual(calls.at(-1), conversation);
    const worktreeFork = {
      ...conversation,
      commandId: "worktree-command",
      environment: "worktree",
    };
    assert.equal((await post(worktreeFork)).status, 200);
    assert.deepEqual(calls.at(-1), worktreeFork);
    const optionCalls: unknown[] = [];
    runtime.sessionForkOptions = async (identity) => {
      optionCalls.push(identity);
      return { local: true, worktree: true };
    };
    const optionsUrl = `${launched.origin}/api/sessions/fork-options?${new URLSearchParams({ sessionPath: request.sessionPath, sessionId: request.sessionId })}`;
    assert.equal((await fetch(optionsUrl)).status, 401);
    const options = await fetch(optionsUrl, { headers });
    assert.equal(options.status, 200);
    assert.deepEqual(await options.json(), { local: true, worktree: true });
    assert.deepEqual(optionCalls, [
      { sessionPath: request.sessionPath, sessionId: request.sessionId },
    ]);
    assert.equal(
      (await fetch(`${optionsUrl}&cwd=/elsewhere`, { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(optionsUrl.replace(request.sessionId, "stale-id"), {
          headers,
        })
      ).status,
      409,
    );
    const cancellationCalls: unknown[] = [];
    runtime.cancelSessionFork = async (identity) => {
      cancellationCalls.push(identity);
      return { state: "requested" };
    };
    const cancelRequest = {
      commandId: conversation.commandId,
      sessionId: request.sessionId,
      sessionPath: request.sessionPath,
    };
    const cancelFork = (body: unknown, authenticated = true) =>
      fetch(`${launched.origin}/api/session/fork/cancel`, {
        method: "POST",
        headers: {
          ...(authenticated ? headers : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await cancelFork(cancelRequest, false)).status, 401);
    assert.equal(
      (await cancelFork({ ...cancelRequest, cancelSource: true })).status,
      400,
    );
    const cancelled = await cancelFork(cancelRequest);
    assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), { state: "requested" });
    assert.deepEqual(cancellationCalls, [cancelRequest]);
    delete runtime.forkSession;
    assert.equal((await post(request)).status, 501);
    assert.equal((await post(conversation)).status, 501);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation links and expected selection identities cannot silently retarget a copied or replaced Session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-conversation-link-host-"));
  const original = SessionManager.create(cwd, cwd);
  persistHostConversation(original, "Original conversation");
  const copyPath = join(cwd, "copy.jsonl");
  await writeFile(copyPath, await readFile(original.getSessionFile()!));
  const copied = SessionManager.open(copyPath, cwd);
  persistHostConversation(copied, "Copy-only conversation text");
  const replacement = SessionManager.create(cwd, cwd);
  persistHostConversation(replacement, "Different replacement identity");
  let selected = original;
  const selections: string[] = [];
  const runtime: WebRuntimeController = {
    ...testRuntime(cwd),
    get sessionManager() {
      return selected;
    },
    switchSession: async (path) => {
      selections.push(path);
      selected = SessionManager.open(path, cwd);
      return { cancelled: false };
    },
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const identity = { path: copyPath, sessionId: copied.getSessionId() };
  const params = new URLSearchParams(identity);
  const get = (query = params.toString(), authenticated = true) =>
    fetch(`${launched.origin}/api/snapshot?${query}`, {
      headers: authenticated ? headers : {},
    });
  const post = (body: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/select`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await get(params.toString(), false)).status, 401);
    assert.equal(
      (
        await post(
          { path: copyPath, expectedSessionId: identity.sessionId },
          false,
        )
      ).status,
      401,
    );
    for (const query of [
      `sessionId=${identity.sessionId}`,
      `${params}&path=${encodeURIComponent(copyPath)}`,
      `${params}&sessionId=${identity.sessionId}`,
      ...[
        { ...identity, sessionId: "" },
        { ...identity, sessionId: "x".repeat(129) },
        { ...identity, sessionId: "bad\u0000id" },
        { ...identity, path: "" },
        { ...identity, path: "bad\u0000path" },
        { ...identity, path: "x".repeat(4097) },
      ].map((value) => new URLSearchParams(value).toString()),
    ])
      assert.equal((await get(query)).status, 400);
    const opened = await get();
    assert.equal(opened.status, 200);
    const snapshot = await opened.json();
    assert.equal(snapshot.selectedSession.id, identity.sessionId);
    assert.equal(snapshot.selectedSession.path, copyPath);
    assert.match(
      JSON.stringify(snapshot.selectedSession.entries),
      /Copy-only conversation text/u,
    );
    assert.equal(selected, original);
    assert.deepEqual(selections, []);
    for (const changed of [
      { ...identity, sessionId: replacement.getSessionId() },
      { ...identity, path: join(cwd, "missing.jsonl") },
    ]) {
      const response = await get(new URLSearchParams(changed).toString());
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "SESSION_CONFLICT");
    }
    await writeFile(copyPath, await readFile(replacement.getSessionFile()!));
    assert.equal((await get()).status, 409);
    assert.equal(selected, original);
    assert.deepEqual(selections, []);
    for (const expectedSessionId of [
      "",
      "x".repeat(129),
      "bad\u0000id",
      false,
      null,
      [],
    ])
      assert.equal(
        (await post({ path: copyPath, expectedSessionId })).status,
        400,
      );
    const stale = await post({
      path: copyPath,
      expectedSessionId: identity.sessionId,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "SESSION_CONFLICT");
    assert.equal(selected, original);
    assert.deepEqual(selections, []);
    const exact = {
      path: copyPath,
      expectedSessionId: replacement.getSessionId(),
    };
    assert.equal((await post(exact)).status, 200);
    assert.equal(selected.getSessionId(), replacement.getSessionId());
    assert.equal(selected.getSessionFile(), copyPath);
    assert.deepEqual(selections, [copyPath]);
    assert.equal((await post(exact)).status, 200);
    assert.deepEqual(selections, [copyPath]);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation delete authenticates exact native requests and preserves metadata until deletion is confirmed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-conversation-delete-host-"));
  const runtime = testRuntime(cwd);
  const manager = SessionManager.create(cwd, cwd);
  persistHostConversation(manager, "Conversation to delete");
  const exact = {
    sessionId: manager.getSessionId(),
    sessionPath: manager.getSessionFile()!,
  };
  const original = await readFile(exact.sessionPath, "utf8");
  let state: WebSessionDeleteResult["state"] = "cancelled";
  let receipt: WebSessionDeleteResult | undefined;
  let unlinks = 0;
  const calls: unknown[] = [];
  runtime.deleteSession = async (request) => {
    calls.push(request);
    if (
      request.sessionId !== exact.sessionId ||
      request.sessionPath !== exact.sessionPath
    )
      throw new WebRuntimeRequestError(
        "Native Session identity changed",
        "SESSION_CONFLICT",
        409,
      );
    if (receipt?.commandId === request.commandId)
      return { ...receipt, replayed: true };
    if (state === "deleted") {
      await rm(exact.sessionPath);
      unlinks++;
      receipt = { ...request, state };
      return receipt;
    }
    return { ...request, state };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const adapter = (host as unknown as { adapter: PiWebAdapter }).adapter;
  const body = { ...exact, commandId: "delete-command" };
  const post = (value: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/delete`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  try {
    await adapter.setSessionPin(exact.sessionPath, exact.sessionId, true);
    await adapter.setSessionRead(
      exact.sessionPath,
      exact.sessionId,
      false,
      (await adapter.requireSession(exact.sessionPath)).readRevision!,
    );
    await adapter.archiveSession(exact.sessionPath);
    const workspaceFile = join(cwd, "workspace-state.json");
    const archiveFile = join(cwd, "archived-sessions.json");
    const before = await readFile(workspaceFile, "utf8");
    const archivedBefore = await readFile(archiveFile, "utf8");
    assert.equal((await post(body, false)).status, 401);
    for (const invalid of [
      { ...body, commandId: "" },
      { ...body, commandId: "x".repeat(129) },
      { ...body, sessionId: "bad\u0000id" },
      { ...body, sessionPath: "bad\u0000path" },
      { ...body, sessionPath: "x".repeat(4097) },
      { ...body, recursive: true },
      { sessionId: exact.sessionId, sessionPath: exact.sessionPath },
    ])
      assert.equal((await post(invalid)).status, 400);
    assert.equal(calls.length, 0);
    for (const conflict of [
      { ...body, sessionId: "different-id" },
      { ...body, sessionPath: join(cwd, "outside.jsonl") },
    ]) {
      const response = await post(conflict);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "SESSION_CONFLICT");
    }
    for (const terminal of ["cancelled", "uncertain"] as const) {
      state = terminal;
      const request = { ...body, commandId: `${terminal}-command` };
      const response = await post(request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ...request, state: terminal });
      assert.deepEqual(calls.at(-1), request);
      assert.equal(await readFile(exact.sessionPath, "utf8"), original);
      assert.equal(await readFile(workspaceFile, "utf8"), before);
      assert.equal(await readFile(archiveFile, "utf8"), archivedBefore);
    }
    state = "deleted";
    const forget = adapter.forgetDeletedSession.bind(adapter);
    adapter.forgetDeletedSession = async () => {
      throw new Error("disk full");
    };
    const deleted = await post(body);
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      ...body,
      state: "deleted",
      metadataCleanupPending: true,
    });
    assert.equal(unlinks, 1);
    await assert.rejects(readFile(exact.sessionPath), { code: "ENOENT" });
    assert.equal(await readFile(workspaceFile, "utf8"), before);
    adapter.forgetDeletedSession = forget;
    const replay = await post(body);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      ...body,
      state: "deleted",
      replayed: true,
    });
    assert.equal(unlinks, 1);
    const metadata = JSON.parse(await readFile(workspaceFile, "utf8"));
    assert.deepEqual(metadata.sidebarPins, []);
    assert.deepEqual(metadata.sessionReadStates, []);
    assert.deepEqual(JSON.parse(await readFile(archiveFile, "utf8")), []);
    delete runtime.deleteSession;
    assert.equal((await post(body)).status, 501);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation rename and delete serialize both orderings without recreating a removed native file", async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), "openpi-conversation-delete-rename-"),
  );
  const runtime = testRuntime(cwd);
  const manager = SessionManager.create(cwd, cwd);
  persistHostConversation(manager, "First delete target");
  const first = {
    sessionId: manager.getSessionId(),
    sessionPath: manager.getSessionFile()!,
  };
  const secondManager = SessionManager.create(cwd, cwd);
  persistHostConversation(secondManager, "Second delete target");
  const second = {
    sessionId: secondManager.getSessionId(),
    sessionPath: secondManager.getSessionFile()!,
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const adapter = (host as unknown as { adapter: PiWebAdapter }).adapter;
  const rename = adapter.renameSession.bind(adapter);
  let releaseRename!: () => void;
  const renameBarrier = new Promise<void>((resolve) => {
    releaseRename = resolve;
  });
  let didStartRename!: () => void;
  const renameStarted = new Promise<void>((resolve) => {
    didStartRename = resolve;
  });
  let releaseDelete!: () => void;
  const deleteBarrier = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let didStartDelete!: () => void;
  const deleteStarted = new Promise<void>((resolve) => {
    didStartDelete = resolve;
  });
  const deletedPaths: string[] = [];
  runtime.deleteSession = async (request) => {
    if (request.sessionPath === second.sessionPath) {
      didStartDelete();
      await deleteBarrier;
    }
    const native = SessionManager.open(request.sessionPath, cwd);
    assert.equal(native.getSessionId(), request.sessionId);
    if (request.sessionPath === first.sessionPath)
      assert.equal(native.getSessionName(), "Renamed before deletion");
    await rm(request.sessionPath);
    deletedPaths.push(request.sessionPath);
    return { ...request, state: "deleted" };
  };
  adapter.renameSession = async (path, name) => {
    if (path === first.sessionPath) {
      didStartRename();
      await renameBarrier;
    }
    return rename(path, name);
  };
  const mutate = (route: string, method: string, body: unknown) =>
    fetch(`${launched.origin}${route}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const renaming = mutate("/api/sessions", "PATCH", {
      path: first.sessionPath,
      name: "Renamed before deletion",
    });
    await renameStarted;
    const deleting = mutate("/api/sessions/delete", "POST", {
      ...first,
      commandId: "delete-first",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(deletedPaths, []);
    releaseRename();
    assert.equal((await renaming).status, 200);
    assert.equal((await deleting).status, 200);
    await assert.rejects(readFile(first.sessionPath), { code: "ENOENT" });

    const deletingFirst = mutate("/api/sessions/delete", "POST", {
      ...second,
      commandId: "delete-second",
    });
    await deleteStarted;
    const renamingAfter = mutate("/api/sessions", "PATCH", {
      path: second.sessionPath,
      name: "Must not be recreated",
    });
    releaseDelete();
    assert.equal((await deletingFirst).status, 200);
    assert.ok((await renamingAfter).status >= 400);
    await assert.rejects(readFile(second.sessionPath), { code: "ENOENT" });
    assert.deepEqual(deletedPaths, [first.sessionPath, second.sessionPath]);
    const sessions = await SessionManager.listAll(cwd);
    assert.equal(
      sessions.some(
        (session) =>
          session.path === first.sessionPath ||
          session.path === second.sessionPath,
      ),
      false,
    );
  } finally {
    releaseRename();
    releaseDelete();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation Markdown API authenticates exact identities, returns complete content and refuses oversized JSON", async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), "openpi-conversation-markdown-host-"),
  );
  const runtime = testRuntime(cwd);
  const manager = runtime.sessionManager;
  manager.appendSessionInfo("Full export");
  const text = `START-${"界".repeat(800_000)}-END`;
  manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  let prompts = 0;
  runtime.sendPrompt = async () => {
    prompts++;
    return { pendingFollowUps: 0 };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const identity = {
    sessionId: manager.getSessionId(),
    sessionPath: mutationSessionPath(manager),
  };
  const params = new URLSearchParams(identity);
  const get = (query = params.toString(), authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/markdown?${query}`, {
      headers: authenticated ? headers : {},
    });
  try {
    assert.equal((await get(params.toString(), false)).status, 401);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/sessions/markdown?${params}`, {
          headers: { ...headers, Origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    for (const query of [
      "",
      `sessionId=${identity.sessionId}`,
      `${params}&limit=1`,
      `${params}&sessionId=${identity.sessionId}`,
      new URLSearchParams({ ...identity, sessionId: "bad\u0000id" }).toString(),
      new URLSearchParams({
        ...identity,
        sessionPath: "bad\u0000path",
      }).toString(),
    ])
      assert.equal((await get(query)).status, 400);
    for (const changed of [
      { ...identity, sessionId: "different-id" },
      { ...identity, sessionPath: join(cwd, "missing.jsonl") },
    ]) {
      const response = await get(new URLSearchParams(changed).toString());
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "SESSION_CONFLICT");
    }
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      markdown: `# Full export\n\n## User\n\n${text}\n`,
    });
    manager.appendMessage({
      role: "user",
      content: "x".repeat(WEB_SESSION_MARKDOWN_MAX_BYTES),
      timestamp: 2,
    });
    const rejected = await get();
    assert.equal(rejected.status, 413);
    const error = await rejected.json();
    assert.equal(error.code, "SESSION_MARKDOWN_TOO_LARGE");
    assert.equal("markdown" in error, false);
    assert.equal(prompts, 0);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conversation open menus expose installed targets and dispatch only a whitelisted application with the exact project directory", {
  skip: process.platform !== "darwin",
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-conversation-open-host-"));
  const project = join(cwd, "project with spaces; no shell");
  await fsPromises.mkdir(project);
  const manager = SessionManager.create(project, cwd);
  persistHostConversation(manager, "Open this project");
  const runtime = testRuntime(cwd);
  let prompts = 0;
  runtime.sendPrompt = async () => {
    prompts++;
    return { pendingFollowUps: 0 };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const identity = {
    sessionId: manager.getSessionId(),
    sessionPath: manager.getSessionFile()!,
  };
  const params = new URLSearchParams(identity);
  const originalAccess = fsPromises.access;
  const originalExecFile = childProcess.execFile;
  const installed = new Set([
    "/System/Library/CoreServices/Finder.app",
    "/Applications/Visual Studio Code.app",
  ]);
  const calls: Array<{
    file: string;
    args: readonly string[];
    options: childProcess.ExecFileOptions;
  }> = [];
  fsPromises.access = async (path, mode) => {
    if (typeof path === "string" && path.endsWith(".app")) {
      if (installed.has(path)) return;
      throw Object.assign(new Error("application absent"), { code: "ENOENT" });
    }
    return originalAccess(path, mode);
  };
  // A plain replacement has no inherited promisify.custom implementation that
  // could bypass the stub and accidentally open a real desktop application.
  childProcess.execFile = ((
    file: string,
    args: readonly string[],
    options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(null, "", ""));
    return new childProcess.ChildProcess();
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  const get = (query = params.toString(), authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/open-targets?${query}`, {
      headers: authenticated ? headers : {},
    });
  const post = (body: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/open`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await get(params.toString(), false)).status, 401);
    assert.equal(
      (await post({ ...identity, target: "finder" }, false)).status,
      401,
    );
    for (const query of [
      "",
      `${params}&limit=1`,
      `${params}&sessionId=${identity.sessionId}`,
    ])
      assert.equal((await get(query)).status, 400);
    for (const altered of [
      { ...identity, sessionId: "different-id" },
      { ...identity, sessionPath: join(cwd, "missing.jsonl") },
    ]) {
      assert.equal(
        (await get(new URLSearchParams(altered).toString())).status,
        409,
      );
      assert.equal((await post({ ...altered, target: "finder" })).status, 409);
    }
    const available = await get();
    assert.equal(available.status, 200);
    assert.deepEqual(await available.json(), {
      targets: [
        { id: "finder", label: "Finder" },
        { id: "vscode", label: "Visual Studio Code" },
      ],
    });
    for (const invalid of [
      { ...identity, target: "finder", command: "/bin/sh" },
      { ...identity, target: "finder", cwd: "/arbitrary" },
      { ...identity, target: "finder", url: "https://foreign.example" },
      { ...identity, target: "" },
      { ...identity, target: "bad\u0000target" },
    ])
      assert.equal((await post(invalid)).status, 400);
    for (const target of [
      "/bin/sh",
      "finder; echo injected",
      "https://foreign.example",
      "cursor",
      "terminal",
    ])
      assert.equal((await post({ ...identity, target })).status, 409);
    assert.deepEqual(calls, []);
    const opened = await post({ ...identity, target: "vscode" });
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), { opened: true });
    assert.deepEqual(calls, [
      {
        file: "/usr/bin/open",
        args: [
          "-a",
          "/Applications/Visual Studio Code.app",
          "--",
          await realpath(project),
        ],
        options: { timeout: 10_000 },
      },
    ]);
    installed.delete("/Applications/Visual Studio Code.app");
    const removed = await post({ ...identity, target: "vscode" });
    assert.equal(removed.status, 409);
    assert.equal((await removed.json()).code, "SESSION_OPEN_UNAVAILABLE");
    assert.equal(calls.length, 1);
    assert.deepEqual(await (await get()).json(), {
      targets: [{ id: "finder", label: "Finder" }],
    });
    assert.equal(prompts, 0);
  } finally {
    fsPromises.access = originalAccess;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects invalid prompt text with a typed admission error before runtime dispatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-limit-"));
  const contents: string[] = [];
  const runtime = testRuntime(cwd, async (content) => {
    contents.push(content);
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const prompt = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
  };
  try {
    for (const content of [
      "  ",
      "\ud83d\ude42".repeat(WEB_PROMPT_MAX_TEXT_LENGTH / 2 + 1),
    ]) {
      const response = await fetch(`${launched.origin}/api/prompt`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ...prompt, content }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        code: "INVALID_PROMPT",
        error: `prompt must contain text or images and at most ${WEB_PROMPT_MAX_TEXT_LENGTH} characters`,
      });
    }
    assert.deepEqual(contents, []);
    const accepted = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        content: `  ${"x".repeat(WEB_PROMPT_MAX_TEXT_LENGTH)}  `,
      }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(contents, ["x".repeat(WEB_PROMPT_MAX_TEXT_LENGTH)]);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("admits the advertised image byte limits through the HTTP body boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-image-body-"));
  const sizes: number[][] = [];
  const runtime = testRuntime(cwd, async (_content, options) => {
    sizes.push(
      (options?.images ?? []).map(
        (image) => Buffer.from(image.data, "base64").length,
      ),
    );
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const image = (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    return { mimeType: "image/png", data: bytes.toString("base64") };
  };
  const post = (images: unknown[]) =>
    fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "Image body boundary fixture; no provider call.",
        images,
      }),
    });
  try {
    const remaining =
      WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES - WEB_PROMPT_IMAGE_MAX_BYTES * 3;
    const response = await post([
      image(WEB_PROMPT_IMAGE_MAX_BYTES),
      image(WEB_PROMPT_IMAGE_MAX_BYTES),
      image(WEB_PROMPT_IMAGE_MAX_BYTES),
      image(remaining),
    ]);
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
    assert.deepEqual(sizes, [
      [
        WEB_PROMPT_IMAGE_MAX_BYTES,
        WEB_PROMPT_IMAGE_MAX_BYTES,
        WEB_PROMPT_IMAGE_MAX_BYTES,
        remaining,
      ],
    ]);
    assert.equal(
      (await post([image(WEB_PROMPT_IMAGE_MAX_BYTES + 1)])).status,
      400,
    );
    assert.equal(sizes.length, 1);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prompt image admission requires literal GIF and WebP signature bytes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-image-signatures-"));
  let dispatches = 0;
  const runtime = testRuntime(cwd, async () => {
    dispatches++;
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const post = (mimeType: string, bytes: Buffer) =>
    fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "Signature fixture; no model call.",
        images: [{ mimeType, data: bytes.toString("base64") }],
      }),
    });
  try {
    for (const signature of ["GIF87a", "GIF89a", "RIFF\0\0\0\0WEBP"]) {
      const mime = signature.startsWith("GIF") ? "image/gif" : "image/webp";
      const bytes = Buffer.from(signature);
      for (let index = 0; index < bytes.length; index++) {
        if (signature.startsWith("RIFF") && index >= 4 && index < 8) continue;
        const corrupted = Buffer.from(bytes);
        corrupted[index]! |= 0x80;
        const response = await post(mime, corrupted);
        assert.equal(response.status, 400, `signature byte ${index}`);
        await response.arrayBuffer();
      }
      const response = await post(mime, bytes);
      assert.equal(response.status, 202);
      await response.arrayBuffer();
    }
    assert.equal(dispatches, 3);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays one prompt admission after a browser timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-retry-"));
  let sendCalls = 0;
  let releaseAdmission!: () => void;
  const admitted = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let runtimePendingFollowUps = 2;
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    await admitted;
    const receipt = { pendingFollowUps: runtimePendingFollowUps };
    runtimePendingFollowUps = 0;
    return receipt;
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const commandId = "browser-timeout-retry";
  const prompt = {
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: mutationSessionPath(runtime.sessionManager),
    content: "send this exactly once",
    commandId,
    planRevision: "ready-1",
  };
  try {
    const abort = new AbortController();
    const timedOut = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...prompt, retry: false }),
      signal: abort.signal,
    });
    while (sendCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    abort.abort();
    await assert.rejects(timedOut, /abort/u);
    // The host can accept after the client loses its receipt. The retry must
    // replay that completed admission rather than dispatch it again.
    releaseAdmission();
    while (
      (
        (await (
          await fetch(`${launched.origin}/api/snapshot`, { headers })
        ).json()) as { cursor: number }
      ).cursor < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const replay = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...prompt, retry: true }),
    });
    const response = await replay;
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      id: commandId,
      accepted: true,
      state: "accepted",
      pendingFollowUps: 2,
      cursor: 2,
    });
    assert.equal(runtimePendingFollowUps, 0);
    assert.equal(sendCalls, 1);

    const approvalConflict = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        planRevision: "another-ready-plan",
        retry: true,
      }),
    });
    assert.equal(approvalConflict.status, 409);
    assert.equal((await approvalConflict.json()).code, "COMMAND_CONFLICT");

    const conflict = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        content: "different body",
        retry: true,
      }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      code: "COMMAND_CONFLICT",
      error: "commandId is already bound to a different prompt",
    });

    const unknown = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        commandId: "after-host-restart",
        retry: true,
      }),
    });
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), {
      code: "COMMAND_ADMISSION_UNKNOWN",
      error:
        "previous prompt admission is unknown; refresh canonical state before sending a new request",
    });
    assert.equal(sendCalls, 1);
  } finally {
    releaseAdmission?.();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fails closed instead of evicting pending prompt admissions", {
  timeout: 10_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-capacity-"));
  let sendCalls = 0;
  let releaseAdmissions!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseAdmissions = resolve;
  });
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    await held;
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const requests = Array.from({ length: 128 }, (_, index) =>
      fetch(`${launched.origin}/api/prompt`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: runtime.sessionManager.getSessionId(),
          sessionPath: mutationSessionPath(runtime.sessionManager),
          content: `pending ${index}`,
          commandId: `pending-${index}`,
          retry: false,
        }),
      }),
    );
    while (sendCalls !== 128) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const overflow = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "must not replace a pending admission",
        commandId: "overflow",
        retry: false,
      }),
    });
    assert.equal(overflow.status, 503);
    assert.deepEqual(await overflow.json(), {
      code: "PROMPT_ADMISSION_CAPACITY",
      error:
        "prompt admission capacity is full; wait for a pending admission to settle",
    });
    assert.equal(sendCalls, 128);
    releaseAdmissions();
    assert.ok(
      (await Promise.all(requests)).every(
        (response) => response.status === 202,
      ),
    );
  } finally {
    releaseAdmissions?.();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns and publishes the observed follow-up queue receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-queue-"));
  const runtime = testRuntime(cwd, async () => ({
    pendingFollowUps: 2,
  }));
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    const response = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "queue me",
      }),
    });
    assert.equal(response.status, 202);
    const receipt = (await response.json()) as {
      id: string;
      accepted: boolean;
      state: string;
      pendingFollowUps: number;
      cursor: number;
    };
    assert.match(receipt.id, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      { ...receipt, id: undefined },
      {
        id: undefined,
        accepted: true,
        state: "accepted",
        pendingFollowUps: 2,
        cursor: snapshot.cursor + 1,
      },
    );
    const events = await readEventRecords(
      await fetch(`${launched.origin}/events?cursor=${snapshot.cursor}`, {
        headers,
      }),
      1,
    );
    assert.equal(events[0].event.sequence, snapshot.cursor + 1);
    assert.equal(events[0].event.type, "prompt_accepted");
    assert.match(String(events[0].event.detail?.commandId), /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      { ...events[0].event.detail, commandId: undefined },
      {
        commandId: undefined,
        sessionId: runtime.sessionManager.getSessionId(),
        pendingFollowUps: 2,
      },
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays only events after an exact SSE cursor with event ids", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    host.publish("first");
    host.publish("second");
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const records = await readEventRecords(response, 2);
    assert.deepEqual(
      records.map(({ id, event }) => [id, event.sequence, event.type]),
      [
        [snapshot.cursor + 1, snapshot.cursor + 1, "first"],
        [snapshot.cursor + 2, snapshot.cursor + 2, "second"],
      ],
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays a bounded burst larger than Node's write high-water mark", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-burst-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 8; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const records = await readEventRecords(response, 8);
    assert.deepEqual(
      records.map(({ event }) => event.type),
      Array.from({ length: 8 }, () => "burst"),
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delivers a live burst above Node's high-water mark without disconnecting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-live-burst-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers, signal: AbortSignal.timeout(5_000) },
    );
    const received = readEventRecords(response, 8);
    for (let index = 0; index < 8; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    const records = await received;
    assert.deepEqual(
      records.map(({ event }) => event.detail?.index),
      Array.from({ length: 8 }, (_, index) => index),
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disconnects a live SSE client when its buffered burst exceeds the budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-live-budget-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers, signal: AbortSignal.timeout(5_000) },
    );
    const disconnected = assert.rejects(
      readEventRecords(response, 20),
      /terminated/,
    );
    for (let index = 0; index < 20; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    await disconnected;
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires resync before SSE headers when replay exceeds its byte budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-budget-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 13; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "RESYNC_REQUIRED");
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires resync for missing, future, or expired SSE cursors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-cursor-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const missing = await fetch(`${launched.origin}/events`, { headers });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "RESYNC_REQUIRED");

    const future = await fetch(`${launched.origin}/events?cursor=999999`, {
      headers,
    });
    assert.equal(future.status, 409);

    for (let index = 0; index < 205; index++)
      host.publish("advance", { index });
    const expired = await fetch(`${launched.origin}/events?cursor=0`, {
      headers,
    });
    assert.equal(expired.status, 409);
    const body = (await expired.json()) as {
      code: string;
      oldestCursor: number;
    };
    assert.equal(body.code, "RESYNC_REQUIRED");
    assert.ok(body.oldestCursor > 0);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("accepts Last-Event-ID and rejects cursor disagreement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-last-id-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    host.publish("after-snapshot");
    const replay = await fetch(`${launched.origin}/events`, {
      headers: { ...headers, "Last-Event-ID": String(snapshot.cursor) },
    });
    assert.equal(replay.status, 200);
    assert.equal(
      (await readEventRecords(replay, 1))[0]?.event.type,
      "after-snapshot",
    );

    const mismatch = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      {
        headers: {
          ...headers,
          "Last-Event-ID": String(snapshot.cursor + 1),
        },
      },
    );
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).code, "CURSOR_MISMATCH");
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds SSE clients and replaces oversized events with invalidation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-bounds-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const clients: Response[] = [];
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 8; index++) {
      const response = await fetch(
        `${launched.origin}/events?cursor=${snapshot.cursor}`,
        { headers },
      );
      assert.equal(response.status, 200);
      clients.push(response);
    }
    const ninth = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(ninth.status, 503);
    assert.equal((await ninth.json()).code, "SSE_CLIENT_LIMIT");

    const first = clients.shift();
    assert.ok(first);
    const firstRecord = readEventRecords(first, 1);
    host.publish("huge", { value: "x".repeat(80 * 1024) });
    assert.equal((await firstRecord)[0]?.event.type, "state_invalidated");
  } finally {
    for (const response of clients)
      await response.body?.cancel().catch(() => {});
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent stop callers await the same runtime disposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-"));
  let releaseDispose!: () => void;
  const disposeBarrier = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  let disposeCalls = 0;
  const runtime = testRuntime(cwd);
  runtime.dispose = async () => {
    disposeCalls++;
    await disposeBarrier;
  };
  const { host } = await startTestHost(runtime);
  try {
    const first = host.stop();
    const second = host.stop();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposeCalls, 1);
    assert.equal(secondSettled, false);
    releaseDispose();
    await Promise.all([first, second]);
    assert.equal(disposeCalls, 1);
  } finally {
    releaseDispose();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop waits for Git review baseline lifecycle cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-git-cleanup-"));
  let releaseCleanup!: () => void;
  const cleanupBarrier = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let disposeCalls = 0;
  const gitReviews: GitReviewService = {
    capture: async () => undefined,
    read: async () => ({ ok: false, reason: "git_failed" }),
    dispose: async () => {
      disposeCalls++;
      await cleanupBarrier;
    },
  };
  const { host } = await startTestHost(testRuntime(cwd), { gitReviews });
  try {
    const stopping = host.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposeCalls, 1);
    assert.equal(settled, false);
    releaseCleanup();
    await stopping;
  } finally {
    releaseCleanup();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop waits for lease-sensitive HTTP mutations before runtime disposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-mutation-"));
  const runtime = testRuntime(cwd);
  let disposeCalls = 0;
  runtime.dispose = async () => {
    disposeCalls++;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  let releaseMutation!: () => void;
  const mutationBarrier = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const adapter = (
    host as unknown as {
      adapter: { renameWorkspace(path: string, name: string): Promise<string> };
    }
  ).adapter;
  adapter.renameWorkspace = async (_path, name) => {
    mutationStarted();
    await mutationBarrier;
    return name;
  };
  try {
    const request = fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd, name: "renamed" }),
    });
    await started;
    const stopping = host.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disposeCalls, 0);

    releaseMutation();
    await stopping;
    assert.equal(disposeCalls, 1);
    assert.equal((await request).status, 200);
  } finally {
    releaseMutation();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop reports uncertain without releasing runtime authority past a mutation", async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), "openpi-web-stop-mutation-timeout-"),
  );
  const runtime = testRuntime(cwd);
  let disposeCalls = 0;
  runtime.dispose = async () => {
    disposeCalls++;
  };
  const host = new WebHost({ runtime, shutdownTimeoutMs: 30 });
  let releaseMutation!: () => void;
  const mutationBarrier = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const adapter = (
      host as unknown as {
        adapter: {
          renameWorkspace(path: string, name: string): Promise<string>;
        };
      }
    ).adapter;
    adapter.renameWorkspace = async (_path, name) => {
      mutationStarted();
      await mutationBarrier;
      return name;
    };
    const request = fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: cwd, name: "renamed" }),
    });
    await started;
    const startedAt = Date.now();
    await assert.rejects(host.stop(), /cleanup did not settle within 30 ms/u);
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(disposeCalls, 0);

    releaseMutation();
    assert.equal((await request).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(disposeCalls, 1);
  } finally {
    releaseMutation();
    await host.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop rejects a late keepalive mutation before it enters the drain", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-keepalive-"));
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let releasePrompt!: () => void;
  const promptBarrier = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  let releaseDispose!: () => void;
  const disposeBarrier = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const runtime = testRuntime(cwd, async () => {
    promptStarted();
    await promptBarrier;
    return { pendingFollowUps: 0 };
  });
  runtime.dispose = async () => {
    releasePrompt();
    await disposeBarrier;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  let renameCalls = 0;
  const adapter = (
    host as unknown as {
      adapter: { renameWorkspace(path: string, name: string): Promise<string> };
    }
  ).adapter;
  adapter.renameWorkspace = async (_path, name) => {
    renameCalls++;
    return name;
  };
  const socket = createConnection({
    host: launched.hostname,
    port: Number(launched.port),
  });
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  let output = "";
  let lateResponseSeen!: () => void;
  const lateResponse = new Promise<void>((resolve) => {
    lateResponseSeen = resolve;
  });
  socket.on("data", (chunk) => {
    output += chunk;
    if (output.includes("HTTP/1.1 503")) lateResponseSeen();
  });
  try {
    await once(socket, "connect");
    const promptBody = JSON.stringify({
      sessionId: runtime.sessionManager.getSessionId(),
      sessionPath: mutationSessionPath(runtime.sessionManager),
      content: "hold the first request",
    });
    socket.write(
      `POST /api/prompt HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(promptBody)}\r\nConnection: keep-alive\r\n\r\n${promptBody}`,
    );
    await started;

    const stopping = host.stop();
    const renameBody = JSON.stringify({ path: cwd, name: "too late" });
    socket.write(
      `PATCH /api/workspaces HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(renameBody)}\r\nConnection: keep-alive\r\n\r\n${renameBody}`,
    );
    await Promise.race([
      lateResponse,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("late 503 was not observed")), 2_000),
      ),
    ]);

    assert.match(output, /HTTP\/1\.1 202/u);
    assert.match(output, /HTTP\/1\.1 503/u);
    assert.match(output, /HOST_STOPPING/u);
    assert.equal(renameCalls, 0);
    releaseDispose();
    await stopping;
  } finally {
    releasePrompt();
    releaseDispose();
    socket.destroy();
    await host.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop reports uncertain cleanup when runtime disposal never settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-timeout-"));
  const runtime = testRuntime(cwd);
  runtime.dispose = () => new Promise(() => undefined);
  const host = new WebHost({ runtime, shutdownTimeoutMs: 30 });
  try {
    await host.start();
    const startedAt = Date.now();
    await assert.rejects(
      host.stop(),
      /cleanup did not settle within 30 ms; cleanup state is uncertain/u,
    );
    assert.ok(Date.now() - startedAt < 500);
    await assert.rejects(
      host.stop(),
      /cleanup did not settle within 30 ms; cleanup state is uncertain/u,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop aborts an open workspace picker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-picker-"));
  let chooserStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    chooserStarted = resolve;
  });
  let chooserAborted = false;
  const runtime = testRuntime(cwd);
  const host = new WebHost({
    runtime,
    directoryChooser: (signal) =>
      new Promise((resolve) => {
        chooserStarted();
        signal.addEventListener(
          "abort",
          () => {
            chooserAborted = true;
            resolve(undefined);
          },
          { once: true },
        );
      }),
  });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const pickerRequest = fetch(`${launched.origin}/api/workspaces/select`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    await started;

    await host.stop();

    assert.equal(chooserAborted, true);
    assert.equal((await pickerRequest).status, 200);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider configuration edits validate their native scope and redact save failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-provider-write-"));
  const runtime = testRuntime(cwd);
  let calls = 0;
  let failure: Error | undefined;
  runtime.changeProviderConfiguration = async () => {
    calls++;
    if (failure) throw failure;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const save = (change: unknown) =>
    fetch(`${launched.origin}/api/providers/configuration`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        revision: "r1",
        change,
      }),
    });
  try {
    assert.equal(
      (await save({ action: "remove", provider: "__proto__" })).status,
      400,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await save({ action: "remove", provider: "fixture" })).status,
      200,
    );
    failure = new WebRuntimeRequestError(
      "fixture-secret",
      "MODEL_CONFIGURATION_CONFLICT",
      409,
    );
    const conflict = await save({ action: "remove", provider: "fixture" });
    assert.equal(conflict.status, 409);
    const body = await conflict.text();
    assert.match(body, /MODEL_CONFIGURATION_CONFLICT/);
    assert.doesNotMatch(body, /fixture-secret/);
    failure = new Error("fixture-secret");
    const failed = await save({ action: "remove", provider: "fixture" });
    assert.equal(failed.status, 422);
    assert.doesNotMatch(await failed.text(), /fixture-secret/);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native model-default routes retain exact identity, validate input and sanitize persistence failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-model-default-"));
  const runtime = testRuntime(cwd);
  const defaults = { model: { provider: "fixture", id: "same-id" } };
  let failure: Error | undefined;
  let writes = 0;
  runtime.readModelDefaults = () => defaults;
  runtime.setModel = async () =>
    assert.fail("saving a default must not switch the active model");
  runtime.saveModelDefault = async (provider, id, options) => {
    assert.equal(provider, "fixture");
    assert.equal(id, "same-id");
    assert.equal(
      options.expectedSessionId,
      runtime.sessionManager.getSessionId(),
    );
    assert.equal(
      options.expectedSessionPath,
      `current:${runtime.sessionManager.getSessionId()}`,
    );
    writes++;
    if (failure) throw failure;
    return defaults;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const body = {
    provider: "fixture",
    modelId: "same-id",
    sessionId: runtime.sessionManager.getSessionId(),
    sessionPath: `current:${runtime.sessionManager.getSessionId()}`,
  };
  const post = (value: unknown) =>
    fetch(`${launched.origin}/api/models/default`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    const read = await fetch(
      `${launched.origin}/api/models/default?sessionId=${body.sessionId}`,
      { headers },
    );
    assert.deepEqual(await read.json(), defaults);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/models/default?sessionId=stale`, {
          headers,
        })
      ).status,
      409,
    );
    for (const invalid of [
      { ...body, extra: true },
      { ...body, provider: "bad/provider" },
      { ...body, modelId: "bad\nmodel" },
      { ...body, sessionPath: "" },
    ])
      assert.equal((await post(invalid)).status, 400);
    assert.equal(writes, 0);
    assert.deepEqual(await (await post(body)).json(), defaults);
    failure = new WebRuntimeRequestError(
      "private-secret",
      "SESSION_CONFLICT",
      409,
    );
    const conflict = await post(body);
    assert.equal(conflict.status, 409);
    assert.doesNotMatch(await conflict.text(), /private-secret/);
    failure = new Error("private-secret");
    const failed = await post(body);
    assert.equal(failed.status, 422);
    assert.doesNotMatch(await failed.text(), /private-secret/);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("model configuration saves distinguish typed conflicts from sanitized save failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-model-write-"));
  const runtime = testRuntime(cwd);
  let failure: Error | undefined;
  runtime.saveModelConfiguration = async () => {
    if (failure) throw failure;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const body = JSON.stringify({
    sessionId: runtime.sessionManager.getSessionId(),
    revision: "fixture-revision",
    model: {
      provider: "fixture",
      id: "fixture-model",
      name: "Fixture",
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-responses",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
    },
  });
  const save = () =>
    fetch(`${launched.origin}/api/models/configuration`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
  const genericMessage =
    "Could not complete model save. Wait for an idle Session and refresh configuration before retrying.";
  try {
    assert.equal((await save()).status, 200);

    failure = new WebRuntimeRequestError(
      "Provider echoed fixture-secret-conflict",
      "MODEL_CONFIGURATION_CONFLICT",
      409,
    );
    const conflict = await save();
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      code: "MODEL_CONFIGURATION_CONFLICT",
      error: "Model configuration changed; refresh before saving",
    });

    failure = new WebRuntimeRequestError(
      "Provider echoed fixture-secret-session",
      "SESSION_CONFLICT",
      409,
    );
    const sessionConflict = await save();
    assert.equal(sessionConflict.status, 409);
    assert.deepEqual(await sessionConflict.json(), {
      code: "SESSION_CONFLICT",
      error: genericMessage,
    });

    failure = new WebRuntimeRequestError(
      "Provider echoed fixture-secret-unavailable",
      "MODEL_NOT_AVAILABLE",
      422,
    );
    const unavailable = await save();
    assert.equal(unavailable.status, 422);
    assert.deepEqual(await unavailable.json(), {
      code: "MODEL_NOT_AVAILABLE",
      error: genericMessage,
    });

    failure = Object.assign(
      new Error("Provider echoed fixture-secret-failure"),
      {
        code: "MODEL_CONFIGURATION_CONFLICT",
        statusCode: 409,
      },
    );
    const generic = await save();
    assert.equal(generic.status, 422);
    assert.deepEqual(await generic.json(), { error: genericMessage });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("catalog and batch model routes validate input and keep provider secrets out of errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-model-catalog-"));
  const runtime = testRuntime(cwd);
  let calls = 0;
  runtime.discoverProviderModels = async () => {
    calls++;
    throw new Error("fixture-secret-from-provider");
  };
  runtime.saveModelConfigurations = async () => {
    throw new WebRuntimeRequestError(
      "fixture-secret-conflict",
      "MODEL_CONFIGURATION_CONFLICT",
      409,
    );
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const connection = {
    provider: "fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-responses",
  };
  const sessionId = runtime.sessionManager.getSessionId();
  const post = (path: string, body: unknown) =>
    fetch(`${launched.origin}/api/models/${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post("discover", { sessionId, connection, extra: true })).status,
      400,
    );
    assert.equal(
      (
        await post("discover", {
          sessionId,
          connection: { ...connection, apiKey: "invalid\nheader" },
        })
      ).status,
      400,
    );
    assert.equal(calls, 0);
    const response = await post("discover", { sessionId, connection });
    assert.equal(response.status, 422);
    assert.doesNotMatch(await response.text(), /fixture-secret/);
    assert.equal(
      (
        await post("configurations", {
          sessionId,
          revision: "fixture",
          models: [],
        })
      ).status,
      400,
    );
    const conflict = await post("configurations", {
      sessionId,
      revision: "fixture",
      models: [
        {
          ...connection,
          id: "example",
          name: "Example",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    assert.equal(conflict.status, 409);
    const result = await conflict.json();
    assert.equal(result.code, "MODEL_CONFIGURATION_CONFLICT");
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider key writes require authentication and sanitize provider failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-provider-write-"));
  const runtime = testRuntime(cwd);
  const calls: string[] = [];
  runtime.saveProviderKey = async (_session, _provider, key) => {
    calls.push(key);
    if (key === "fixture-secret-failure")
      throw new Error(`Provider echoed ${key}`);
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const body = JSON.stringify({
      sessionId: runtime.sessionManager.getSessionId(),
      provider: "fixture",
      apiKey: "fixture-secret-success",
    });
    assert.equal(
      (
        await fetch(`${launched.origin}/api/providers/api-key`, {
          method: "POST",
          body,
        })
      ).status,
      401,
    );
    assert.deepEqual(calls, []);
    const saved = await fetch(`${launched.origin}/api/providers/api-key`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /fixture-secret/u);
    const failure = await fetch(`${launched.origin}/api/providers/api-key`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: body.replace("fixture-secret-success", "fixture-secret-failure"),
    });
    assert.equal(failure.status, 422);
    assert.doesNotMatch(await failure.text(), /fixture-secret-failure/u);
    assert.equal(calls.length, 2);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const wallShift of [0, 120_000, -120_000]) {
  test(`stop bounds an authenticated incomplete HTTP request with wall shift ${wallShift}`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-http-"));
    const { host, launched, headers } = await startTestHost(testRuntime(cwd));
    const socket = createConnection({
      host: launched.hostname,
      port: Number(launched.port),
    });
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect");
      socket.write(
        `POST /api/workspaces HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"path":"`,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const nativeDateNow = Date.now;
      const startedAt = performance.now();
      const stopping = host.stop();
      t.mock.method(Date, "now", () => nativeDateNow() + wallShift);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stopping,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("host stop did not finish")),
            2_000,
          );
        }),
      ]);
      clearTimeout(timeout);
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 0 && elapsed < 1_500, `stop elapsed ${elapsed}ms`);
    } finally {
      t.mock.restoreAll();
      socket.destroy();
      await host.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("stop disposes the runtime before waiting for an in-flight prompt request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-prompt-"));
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let releasePrompt!: () => void;
  const pendingPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  let disposeCalls = 0;
  const runtime = testRuntime(cwd, async () => {
    promptStarted();
    await pendingPrompt;
    return { pendingFollowUps: 0 };
  });
  runtime.dispose = async () => {
    disposeCalls++;
    releasePrompt();
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const response = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        sessionPath: mutationSessionPath(runtime.sessionManager),
        content: "pending during shutdown",
      }),
    });
    await started;
    await host.stop();
    assert.equal(disposeCalls, 1);
    assert.equal((await response).status, 202);
  } finally {
    releasePrompt();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed worktree endpoints bind discovery to a known workspace and forward only exact release identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-worktree-host-"));
  const runtime = testRuntime(cwd);
  const calls: unknown[] = [];
  const target = {
    sessionId: "deleted-native-child",
    sessionPath: join(runtime.sessionDirectory, "deleted.jsonl"),
    worktreePath: join(cwd, ".git", "pi-worktrees", "retained"),
  };
  runtime.listRetainedWorktrees = async (path, cursor) => {
    calls.push({ path, cursor });
    return {
      worktrees: [target],
      truncated: true,
      unavailable: 1,
      nextCursor: "opaque-next",
    };
  };
  let externalHolder: boolean | undefined;
  runtime.releaseSessionWorktree = async (request, hasExternalHolders) => {
    externalHolder = hasExternalHolders?.();
    calls.push(request);
    return {
      ...request,
      state: "preserved",
      reason: "A saved Session still references this checkout.",
    };
  };
  const { host, launched, headers } = await startTestHost(runtime);
  const route = `${launched.origin}/api/workspaces/worktrees?path=${encodeURIComponent(cwd)}`;
  const release = { ...target, commandId: "explicit-release" };
  const post = (body: unknown, authenticated = true) =>
    fetch(`${launched.origin}/api/sessions/worktree-release`, {
      method: "POST",
      headers: {
        ...(authenticated ? headers : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(route)).status, 401);
    const listing = await fetch(`${route}&cursor=opaque`, { headers });
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), {
      worktrees: [target],
      truncated: true,
      unavailable: 1,
      nextCursor: "opaque-next",
    });
    assert.deepEqual(calls.shift(), { path: cwd, cursor: "opaque" });
    assert.notEqual(
      (
        await fetch(
          `${launched.origin}/api/workspaces/worktrees?path=${encodeURIComponent(join(cwd, "unknown"))}`,
          { headers },
        )
      ).status,
      200,
    );
    assert.equal(calls.length, 0);
    assert.equal((await post(release, false)).status, 401);
    for (const body of [
      { ...release, token: "browser-authority" },
      { ...release, worktreePath: "relative" },
      { ...release, sessionId: "bad\nidentity" },
    ])
      assert.equal((await post(body)).status, 400);
    assert.equal(calls.length, 0);
    const response = await post(release);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...release,
      state: "preserved",
      reason: "A saved Session still references this checkout.",
    });
    assert.deepEqual(calls, [release]);
    assert.equal(externalHolder, false);
    delete runtime.releaseSessionWorktree;
    assert.equal((await post(release)).status, 501);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("release treats an injected terminal service without holder evidence as unknown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-holder-host-"));
  const runtime = testRuntime(cwd);
  const terminals: InteractiveTerminalService =
    new InteractiveTerminalManager();
  terminals.hasWorktreeReferences = undefined;
  runtime.releaseSessionWorktree = async (request, holders) => ({
    ...request,
    state: holders?.() ? "preserved" : "removed",
  });
  const { host, launched, headers } = await startTestHost(runtime, {
    interactiveTerminals: terminals,
  });
  try {
    for (const evidence of [undefined, () => true, () => false]) {
      terminals.hasWorktreeReferences = evidence;
      const response = await fetch(
        `${launched.origin}/api/sessions/worktree-release`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            commandId: "release",
            sessionId: "deleted",
            sessionPath: join(runtime.sessionDirectory, "deleted.jsonl"),
            worktreePath: cwd,
          }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).state,
        evidence?.() === false ? "removed" : "preserved",
      );
    }
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
