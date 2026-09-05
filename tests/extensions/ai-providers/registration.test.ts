import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  ModelsStoreEntry,
  OAuthCredentials,
  Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeApiKey } from "../../../extensions/ai-providers/antigravity/credentials.ts";
import authProviders from "../../../extensions/ai-providers/index.ts";
import { createOAuthAuth } from "../../../extensions/ai-providers/oauth-adapter.ts";

function loadProviders(): {
  providers: Provider[];
  inputHandlerRegistered: boolean;
} {
  const providers: Provider[] = [];
  let inputHandlerRegistered = false;
  const pi = {
    on(event: string) {
      if (event === "input") inputHandlerRegistered = true;
    },
    registerProvider(...args: unknown[]) {
      assert.equal(args.length, 1);
      assert.equal(typeof args[0], "object");
      providers.push(args[0] as Provider);
    },
  } as unknown as ExtensionAPI;

  authProviders(pi);
  return { providers, inputHandlerRegistered };
}

async function collectEvents(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("ai-providers registers complete native providers", () => {
  const { providers, inputHandlerRegistered } = loadProviders();
  assert.equal(inputHandlerRegistered, true);
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["google-antigravity", "cursor"],
  );

  for (const provider of providers) {
    assert.ok(provider.auth.oauth);
    assert.ok(provider.refreshModels);
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    const models = provider.getModels();
    assert.ok(models.length > 0);
    for (const model of models) {
      assert.equal(model.provider, provider.id);
      assert.ok(model.api.length > 0);
      assert.ok(model.baseUrl.length > 0);
    }
  }
});

test("Antigravity OAuth cancellation during version discovery stays bounded", async () => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.OPENPI_ANTIGRAVITY_VERSION;
  delete process.env.OPENPI_ANTIGRAVITY_VERSION;
  const manifestStarted = Promise.withResolvers<void>();
  const notifications: unknown[] = [];
  let prompts = 0;
  try {
    globalThis.fetch = ((_input, init) => {
      manifestStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;
    const { providers } = loadProviders();
    const provider = providers.find(
      (entry) => entry.id === "google-antigravity",
    );
    const oauth = provider?.auth.oauth;
    assert.ok(oauth);
    const controller = new AbortController();
    const login = oauth.login({
      signal: controller.signal,
      notify: (event) => notifications.push(event),
      prompt: async () => {
        prompts++;
        return "";
      },
    });
    await manifestStarted.promise;
    controller.abort("test cancellation");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([
      login,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("login cancellation remained pending")),
          250,
        );
      }),
    ]);
    try {
      await assert.rejects(bounded, /cancelled/);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.deepEqual(notifications, []);
    assert.equal(prompts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.OPENPI_ANTIGRAVITY_VERSION;
    } else {
      process.env.OPENPI_ANTIGRAVITY_VERSION = originalVersion;
    }
  }
});

test("native providers restore stored dynamic models without replacing baselines", async () => {
  const { providers } = loadProviders();
  for (const provider of providers) {
    const baseline = provider.getModels()[0];
    assert.ok(baseline);
    const overridden: Model<Api> = {
      ...baseline,
      name: `${baseline.name} (cached)`,
    };
    const accountModel: Model<Api> = {
      ...baseline,
      id: "account-only-model",
      name: "Account Only Model",
    };
    let publications = 0;

    await provider.refreshModels?.({
      stored: { models: [overridden, accountModel], checkedAt: 123 },
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: async (publication) => {
        publications += 1;
        assert.equal(publication.persist, undefined);
        publication.update?.();
        return true;
      },
    });

    const restored = provider.getModels();
    assert.equal(publications, 1);
    assert.equal(
      restored.filter((model) => model.id === baseline.id).length,
      1,
    );
    assert.equal(
      restored.find((model) => model.id === baseline.id)?.name,
      overridden.name,
    );
    assert.ok(restored.some((model) => model.id === accountModel.id));
  }
});

test("Antigravity native refresh persists success and retains it on later failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalVersion = process.env.OPENPI_ANTIGRAVITY_VERSION;
  process.env.OPENPI_ANTIGRAVITY_VERSION = "2.8.0";
  const { providers } = loadProviders();
  const provider = providers.find((entry) => entry.id === "google-antigravity");
  assert.ok(provider?.refreshModels);
  let stored: ModelsStoreEntry | undefined;

  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: {
            "account-model": {
              displayName: "Account Model",
              supportsImages: true,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    await provider.refreshModels({
      credential: {
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      },
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (publication) => {
        if (publication.persist) stored = publication.persist;
        publication.update?.();
        return true;
      },
    });
    assert.ok(stored);
    assert.equal(stored.models[0]?.id, "account-model");
    assert.ok(Number.isFinite(stored.checkedAt));
    assert.ok(
      provider.getModels().some((model) => model.id === "account-model"),
    );

    globalThis.fetch = (async () =>
      new Response("unavailable", { status: 503 })) as typeof fetch;
    let unexpectedPersist = false;
    await assert.rejects(
      provider.refreshModels({
        stored,
        credential: {
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        },
        allowNetwork: true,
        signal: new AbortController().signal,
        publish: async (publication) => {
          if (publication.persist !== undefined) unexpectedPersist = true;
          publication.update?.();
          return true;
        },
      }),
      /failed on all endpoints/,
    );
    assert.equal(unexpectedPersist, false);
    assert.ok(
      provider.getModels().some((model) => model.id === "account-model"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) {
      delete process.env.OPENPI_ANTIGRAVITY_VERSION;
    } else {
      process.env.OPENPI_ANTIGRAVITY_VERSION = originalVersion;
    }
  }
});

test("native stream and streamSimple both dispatch to provider implementations", async () => {
  const { providers } = loadProviders();
  for (const provider of providers) {
    const model = provider.getModels()[0];
    assert.ok(model);
    for (const stream of [
      provider.stream(model, { messages: [] }),
      provider.streamSimple(model, { messages: [] }),
    ]) {
      const events = await collectEvents(stream);
      const final = events.at(-1);
      assert.equal(final?.type, "error");
      if (final?.type === "error") {
        assert.match(
          final.error.errorMessage ?? "",
          /OAuth credentials|access token|API key/,
        );
      }
    }
  }
});

test("OAuth adapter preserves events, prompts, credentials, and request auth", async () => {
  const signal = new AbortController().signal;
  const notifications: unknown[] = [];
  const promptTypes: string[] = [];
  let refreshSignal: AbortSignal | undefined;
  let requestedManualSignal: AbortSignal | undefined;
  let receivedManualSignal: AbortSignal | undefined;
  const oauth = createOAuthAuth({
    name: "Test OAuth",
    isSubscription: true,
    async login(callbacks) {
      callbacks.onAuth({
        url: "https://example.test/login",
        instructions: "Sign in",
      });
      callbacks.onProgress?.("Waiting");
      requestedManualSignal = new AbortController().signal;
      const code = await callbacks.onManualCodeInput?.(requestedManualSignal);
      const choice = await callbacks.onSelect({
        message: "Account",
        options: [{ id: "one", label: "One" }],
      });
      return {
        refresh: "refresh-token",
        access: "access-token",
        expires: 123,
        metadata: `${code}:${choice}`,
      };
    },
    async refreshToken(credential, receivedSignal) {
      refreshSignal = receivedSignal;
      return { ...credential, access: "refreshed-access" };
    },
    getApiKey: (credential) => credential.access,
  });

  const credential = await oauth.login({
    signal,
    notify: (event) => notifications.push(event),
    prompt: async (prompt) => {
      promptTypes.push(prompt.type);
      if (prompt.type === "manual_code") {
        receivedManualSignal = prompt.signal;
      }
      return prompt.type === "select" ? "one" : "manual-code";
    },
  });
  assert.equal(credential.type, "oauth");
  assert.equal(credential.metadata, "manual-code:one");
  assert.deepEqual(
    notifications.map((event) => (event as { type: string }).type),
    ["auth_url", "progress"],
  );
  assert.deepEqual(promptTypes, ["manual_code", "select"]);
  assert.equal(receivedManualSignal, requestedManualSignal);

  const refreshed = await oauth.refresh(credential, signal);
  assert.equal(refreshSignal, signal);
  assert.equal(refreshed.type, "oauth");
  assert.equal(refreshed.access, "refreshed-access");
  assert.deepEqual(await oauth.toAuth(refreshed), {
    apiKey: "refreshed-access",
  });
});

test("registered OAuth adapters derive the existing provider credentials", async () => {
  const { providers } = loadProviders();
  const antigravity = providers.find(
    (provider) => provider.id === "google-antigravity",
  );
  const cursor = providers.find((provider) => provider.id === "cursor");
  assert.ok(antigravity?.auth.oauth);
  assert.ok(cursor?.auth.oauth);

  const base: OAuthCredentials = {
    refresh: "refresh",
    access: "access",
    expires: Date.now() + 60_000,
  };
  const antigravityAuth = await antigravity.auth.oauth.toAuth({
    ...base,
    type: "oauth",
    projectId: "project",
  });
  assert.ok(antigravityAuth.apiKey);
  assert.deepEqual(decodeApiKey(antigravityAuth.apiKey), {
    token: "access",
    projectId: "project",
  });
  assert.deepEqual(await cursor.auth.oauth.toAuth({ ...base, type: "oauth" }), {
    apiKey: "access",
  });
});
