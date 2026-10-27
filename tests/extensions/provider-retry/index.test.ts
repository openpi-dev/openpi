import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import providerRetry, {
  normalizeGatewayConcurrencyError,
} from "../../../extensions/provider-retry/index.ts";
import { isGatewayConcurrencyLimit } from "../../../extensions/shared/provider-errors.ts";

const original =
  "gateway_concurrency_limit: Concurrency limit exceeded for user, please retry later";
const failure = (errorMessage = original) =>
  fauxAssistantMessage([], { stopReason: "error", errorMessage });

test("the browser-safe matcher recognizes only the exact gateway code", () => {
  for (const error of [
    original,
    `Rate limit: ${original}`,
    "gateway_concurrency_limit",
    "gateway_concurrency_limit (429)",
  ])
    assert.equal(isGatewayConcurrencyLimit(error), true);
  for (const error of [
    undefined,
    "",
    "Concurrency limit exceeded",
    "gateway_concurrency_limit_other: failure",
    "gateway_concurrency_limit_permanent: failure",
    "other_gateway_concurrency_limit: failure",
    "gateway_concurrency_limit-other: failure",
  ])
    assert.equal(isGatewayConcurrencyLimit(error), false);
});

test("normalization preserves the gateway evidence and is idempotent", () => {
  const message = {
    ...failure(),
    diagnostics: [
      {
        type: "provider_error",
        timestamp: 1,
        error: { code: "gateway_concurrency_limit", message: original },
        details: { retryable: true },
      },
    ],
  };
  assert.equal(isRetryableAssistantError(message), false);
  const normalized = normalizeGatewayConcurrencyError(message);
  assert.equal(normalized.errorMessage, `Rate limit: ${original}`);
  assert.ok(isRetryableAssistantError(normalized));
  assert.deepEqual(normalized, {
    ...message,
    errorMessage: `Rate limit: ${original}`,
  });
  assert.strictEqual(normalizeGatewayConcurrencyError(normalized), normalized);
  assert.equal(message.errorMessage, original);
});

test("unrelated, quota, already retryable, successful and aborted messages stay unchanged", () => {
  for (const message of [
    failure("unrelated provider failure"),
    failure("insufficient_quota"),
    failure(`${original}; billing quota exceeded`),
    failure(`429 ${original}`),
    failure(`gateway_concurrency_limit: 503 ${original}`),
    failure("gateway_concurrency_limit_other: please retry later"),
    fauxAssistantMessage("Completed", { errorMessage: original }),
    fauxAssistantMessage([], { stopReason: "aborted", errorMessage: original }),
  ])
    assert.strictEqual(normalizeGatewayConcurrencyError(message), message);
});

async function nativeSession(t: TestContext, enabled = true, baseDelayMs = 1) {
  const root = await mkdtemp(join(tmpdir(), "openpi-provider-retry-"));
  const provider = fauxProvider({
    provider: `provider-retry-${root.split(/[/\\]/u).at(-1)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled, maxRetries: 1, baseDelayMs },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    extensionFactories: [providerRetry],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model: provider.getModel(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  });
  t.after(async () => {
    await session.abort();
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "print" });
  return { session, provider };
}

test("message_end replacement lets native Pi retry and settle one successful run", async (t) => {
  const { session, provider } = await nativeSession(t);
  let calls = 0;
  provider.setResponses([
    () => {
      calls++;
      return failure();
    },
    (context) => {
      calls++;
      assert.equal(
        context.messages.filter((message) => message.role === "user").length,
        1,
      );
      assert.ok(
        !context.messages.some(
          (message) =>
            message.role === "assistant" && message.stopReason === "error",
        ),
      );
      return fauxAssistantMessage("Recovered");
    },
  ]);
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      events.push(`message_end:${event.message.stopReason}`);
      if (event.message.stopReason === "error")
        assert.equal(event.message.errorMessage, `Rate limit: ${original}`);
    } else if (event.type === "auto_retry_end") {
      assert.equal(event.success, true);
      events.push(event.type);
    } else if (["auto_retry_start", "agent_settled"].includes(event.type))
      events.push(event.type);
  });
  await session.prompt("Complete this request");
  assert.equal(calls, 2);
  assert.deepEqual(events, [
    "message_end:error",
    "auto_retry_start",
    "message_end:stop",
    "auto_retry_end",
    "agent_settled",
  ]);
  assert.equal(session.getLastAssistantText(), "Recovered");
  assert.ok(
    session.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.errorMessage === `Rate limit: ${original}`,
      ),
  );
});

for (const enabled of [false, true])
  test(`native retry ${enabled ? "budget is bounded" : "disabled setting is respected"}`, async (t) => {
    const { session, provider } = await nativeSession(t, enabled);
    let calls = 0;
    provider.setResponses(
      Array.from({ length: 3 }, () => () => {
        calls++;
        return failure();
      }),
    );
    await session.prompt("Fail with concurrency limit");
    assert.equal(calls, enabled ? 2 : 1);
    assert.equal(session.messages.at(-1)?.role, "assistant");
    const last = session.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "error");
  });

test("native cancellation interrupts retry backoff without another request", async (t) => {
  const { session, provider } = await nativeSession(t, true, 60_000);
  let calls = 0;
  provider.setResponses([
    () => {
      calls++;
      return failure();
    },
  ]);
  let retryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  const retryEnds: boolean[] = [];
  session.subscribe((event) => {
    if (event.type === "auto_retry_start") retryStarted();
    if (event.type === "auto_retry_end") retryEnds.push(event.success);
  });
  const prompt = session.prompt("Cancel during backoff");
  await started;
  await session.abort();
  await prompt;
  assert.equal(calls, 1);
  assert.deepEqual(retryEnds, [false]);
  assert.equal(session.isIdle, true);
});
