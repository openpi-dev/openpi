import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AuthResult,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { UsageCache } from "../../../extensions/usage/cache.ts";
import usage, {
  collectUsageReports,
  parseUsageArgs,
} from "../../../extensions/usage/index.ts";

function jwt(account: string) {
  return `e30.${Buffer.from(JSON.stringify({ sub: `auth0|${account}`, "https://api.openai.com/profile": { email: `${account}@example.test` } })).toString("base64url")}.sig`;
}
const quota = { rate_limit: { primary_window: { used_percent: 20 } } };
const codexRegistry = (account: string) => ({
  getProviderAuth: async (id: string): Promise<AuthResult | undefined> =>
    id === "openai-codex" ? { auth: { apiKey: jwt(account) } } : undefined,
});

function command() {
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  usage({
    registerCommand(name, options) {
      assert.equal(name, "usage");
      handler = options.handler;
    },
  } as ExtensionAPI);
  assert.ok(handler);
  return handler;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    modelRegistry: codexRegistry("a"),
    ui: { notify() {} },
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

test("usage flags accept documented options and reject unknown input", () => {
  assert.deepEqual(parseUsageArgs("--refresh -r -j"), {
    refresh: true,
    redact: true,
    json: true,
  });
  assert.deepEqual(parseUsageArgs(""), {
    refresh: false,
    redact: false,
    json: false,
  });
  assert.throws(() => parseUsageArgs("--redcat"), /Usage:/);
});

test("quota cache respects the currently resolved identity, refresh and logout", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return Response.json(quota);
  });
  const cache = new UsageCache();
  const a = codexRegistry("a");
  await collectUsageReports({ modelRegistry: a, cache });
  await collectUsageReports({ modelRegistry: a, cache });
  assert.equal(fetches, 1);
  const b = await collectUsageReports({
    modelRegistry: codexRegistry("b"),
    cache,
  });
  assert.equal(fetches, 2);
  assert.equal(b[0].accountIdentifier, "b@example.test");
  await collectUsageReports({
    modelRegistry: codexRegistry("b"),
    cache,
    refresh: true,
  });
  assert.equal(fetches, 3);
  await collectUsageReports({
    modelRegistry: { getProviderAuth: async () => undefined },
    cache,
  });
  await collectUsageReports({ modelRegistry: codexRegistry("b"), cache });
  assert.equal(fetches, 4);
});

test("Pi refreshes injected expired OAuth credentials before usage sends a request", async (t) => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("cursor", async () => ({
    type: "oauth",
    access: "expired",
    refresh: "refresh-fixture",
    expires: 0,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  let refreshes = 0;
  const freshToken = jwt("fresh-user");
  const faux = fauxProvider({ provider: "cursor" });
  runtime.registerNativeProvider({
    ...faux.provider,
    auth: {
      oauth: {
        name: "Cursor",
        isSubscription: true,
        login: async () => {
          throw new Error("Login must not be triggered");
        },
        refresh: async (credential) => {
          refreshes++;
          return {
            ...credential,
            access: freshToken,
            expires: Date.now() + 3600_000,
          };
        },
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
  const registry = new ModelRegistry(runtime);
  const cookies: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      cookies.push(new Headers(init?.headers).get("Cookie") ?? "");
      return Response.json({
        individualUsage: { plan: { autoPercentUsed: 10 } },
      });
    },
  );
  const reports = await collectUsageReports({
    modelRegistry: {
      getProviderAuth: (id) =>
        id === "cursor"
          ? registry.getProviderAuth(id)
          : Promise.resolve(undefined),
    },
    cache: new UsageCache(),
  });
  assert.equal(refreshes, 1);
  assert.equal((await credentials.read("cursor"))?.type, "oauth");
  assert.equal(reports[0].error, undefined);
  assert.equal(cookies.length, 2);
  assert.ok(
    cookies.every(
      (cookie) =>
        cookie.includes(encodeURIComponent(freshToken)) &&
        !cookie.includes("expired"),
    ),
  );
  assert.equal(faux.state.callCount, 0);
});

test("auth/provider failures are isolated, safe and retried; incomplete responses are not cached", async (t) => {
  let phase = "failure";
  let codexCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    codexCalls++;
    return Response.json(phase === "partial" ? {} : quota);
  });
  const registry = {
    getProviderAuth: async (id: string) => {
      if (id === "cursor") throw new Error("Bearer PRIVATE_CREDENTIAL");
      if (id === "openai-codex") return { auth: { apiKey: jwt("a") } };
      return undefined;
    },
  };
  const cache = new UsageCache();
  const reports = await collectUsageReports({ modelRegistry: registry, cache });
  assert.equal(reports.length, 2);
  assert.ok(reports[0].error);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_CREDENTIAL/);
  assert.equal(reports[1].error, undefined);
  cache.invalidate();
  phase = "partial";
  await collectUsageReports({ modelRegistry: registry, cache });
  await collectUsageReports({ modelRegistry: registry, cache });
  assert.equal(codexCalls, 3);
});

test("cancellation while resolving auth returns promptly and never starts late quota requests", async (t) => {
  const controller = new AbortController();
  let resolveAuth: (result: AuthResult) => void = () => {};
  const pending = new Promise<AuthResult>((resolve) => {
    resolveAuth = resolve;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(quota);
  });
  const reports = collectUsageReports({
    modelRegistry: {
      getProviderAuth: (id) =>
        id === "openai-codex" ? pending : Promise.resolve(undefined),
    },
    cache: new UsageCache(),
    signal: controller.signal,
  });
  controller.abort();
  assert.match((await reports)[0].error ?? "", /cancelled/);
  resolveAuth({ auth: { apiKey: jwt("late") } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("RPC success and redacted JSON use the UI channel, including an empty JSON array", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(quota));
  const log = t.mock.method(console, "log", () => {});
  const output: string[] = [];
  const handler = command();
  const ctx = context({
    ui: { notify: (message: string) => output.push(message) },
  });
  await handler("", ctx);
  assert.match(output.pop() ?? "", /Codex/);
  await handler("--json --redact", ctx);
  const report = JSON.parse(output.pop() ?? "")[0];
  assert.match(report.accountIdentifier, /\*\*\*/);
  await handler(
    "--json",
    context({
      modelRegistry: { getProviderAuth: async () => undefined },
      ui: ctx.ui,
    }),
  );
  assert.deepEqual(JSON.parse(output.pop() ?? ""), []);
  assert.equal(log.mock.callCount(), 0);
});

test("headless JSON is parseable and separate extension instances never reuse cached reports", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(quota);
  });
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => {
    output.push(value);
  });
  const ctx = context({ mode: "print", hasUI: false });
  await command()("--json", ctx);
  await command()("--json", ctx);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(output[0])[0].providerId, "openai-codex");
});

test("TUI overlay scrolls wrapped rows, preserves unrelated keys and closes on Enter/Esc", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(quota));
  let closed = 0;
  let rerenders = 0;
  type Component = {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  };
  const handler = command();
  const ctx = context({
    mode: "tui",
    ui: {
      onTerminalInput: () => () => {},
      setStatus: () => {},
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: () => void,
        ) => Component,
        options: { overlay: boolean },
      ) => {
        assert.equal(options.overlay, true);
        const component = factory(
          {
            terminal: { rows: 8 },
            requestRender() {
              rerenders++;
            },
          },
          { fg: (_color: unknown, text: string) => text },
          {},
          () => {
            closed++;
          },
        );
        const first = component.render(22);
        assert.ok(first.length <= 6);
        assert.ok(first.every((row) => visibleWidth(row) <= 22));
        component.handleInput("x");
        assert.equal(closed, 0);
        component.handleInput("\x1b[6~");
        assert.equal(rerenders, 1);
        assert.notDeepEqual(component.render(22), first);
        component.invalidate();
        component.handleInput("\r");
        assert.equal(closed, 1);
      },
    },
  });
  await handler("", ctx);
});

test("TUI cancels an idle quota query and cleans up its input listener and status", async () => {
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let cleaned = false;
  const statuses: Array<string | undefined> = [];
  let overlays = 0;
  const handler = command();
  const ctx = context({
    mode: "tui",
    modelRegistry: { getProviderAuth: () => new Promise(() => {}) },
    ui: {
      onTerminalInput: (listener: typeof input) => {
        input = listener;
        return () => {
          cleaned = true;
        };
      },
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      custom: async () => {
        overlays++;
      },
    },
  });
  const pending = handler("", ctx);
  assert.ok(input);
  assert.equal(input("x"), undefined);
  assert.deepEqual(input("\x1b"), { consume: true });
  await pending;
  assert.equal(cleaned, true);
  assert.equal(overlays, 0);
  assert.match(statuses[0] ?? "", /Fetching quota/);
  assert.equal(statuses.at(-1), undefined);
});
