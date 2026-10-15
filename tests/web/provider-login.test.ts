import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebProviderLoginService } from "../../web/runtime/provider-login.ts";

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(2);
  }
  assert.fail(
    "The native auth interaction did not reach the expected boundary",
  );
}

test("provider login binds each prompt to the exact flow, Session and native choice", async (t) => {
  const service = new WebProviderLoginService();
  t.after(() => service.dispose());
  const answers: string[] = [];
  const flow = service.start("session-a", "fixture", async (interaction) => {
    answers.push(
      await interaction.prompt({
        type: "select",
        message: "Choose",
        options: [{ id: "browser", label: "Browser" }],
      }),
    );
    answers.push(await interaction.prompt({ type: "secret", message: "Code" }));
    return {};
  });
  await until(() => Boolean(service.read("session-a", flow.id)?.prompt));
  const first = service.read("session-a", flow.id)!.prompt!;
  assert.throws(
    () => service.start("session-a", "other", async () => ({})),
    /changed/u,
  );
  assert.throws(() => service.read("session-b", flow.id), /changed/u);
  assert.throws(
    () => service.respond("session-a", "stale", first.id, "browser"),
    /changed/u,
  );
  assert.throws(
    () => service.respond("session-a", flow.id, first.id, "injected-choice"),
    /Invalid/u,
  );
  service.respond("session-a", flow.id, first.id, "browser");
  assert.throws(
    () => service.respond("session-a", flow.id, first.id, "browser"),
    /changed/u,
  );
  await until(
    () => service.read("session-a", flow.id)?.prompt?.type === "secret",
  );
  const second = service.read("session-a", flow.id)!.prompt!;
  assert.throws(
    () => service.respond("session-a", flow.id, second.id, "code\ninjection"),
    /Invalid/u,
  );
  service.respond("session-a", flow.id, second.id, "private-code");
  await until(() => service.read("session-a", flow.id)?.status === "succeeded");
  assert.deepEqual(answers, ["browser", "private-code"]);
  const projection = JSON.stringify(service.read("session-a", flow.id));
  assert.equal(projection.includes("private-code"), false);
  assert.equal(service.read("session-a", flow.id)?.prompt, undefined);
});

test("automatic callback removes only its obsolete manual prompt and rejects late input", async (t) => {
  const service = new WebProviderLoginService();
  t.after(() => service.dispose());
  const callback = new AbortController();
  const completed = Promise.withResolvers<void>();
  const flow = service.start("session-a", "fixture", async (interaction) => {
    interaction.notify({
      type: "auth_url",
      url: "https://accounts.example/authorize?state=fixture",
    });
    const manual = interaction.prompt({
      type: "manual_code",
      message: "Paste callback",
      signal: callback.signal,
    });
    await manual.catch(() => completed.promise);
    return {};
  });
  await until(() => Boolean(service.read("session-a", flow.id)?.prompt));
  const prompt = service.read("session-a", flow.id)!.prompt!;
  callback.abort();
  assert.equal(service.read("session-a", flow.id)?.prompt, undefined);
  assert.throws(
    () => service.respond("session-a", flow.id, prompt.id, "late-code"),
    /changed/u,
  );
  completed.resolve();
  await until(() => service.read("session-a", flow.id)?.status === "succeeded");
  assert.equal(service.read("session-a", flow.id)?.auth, undefined);
});

test("cancellation and expiry await native settlement; a committed credential remains success", async (t) => {
  const service = new WebProviderLoginService();
  t.after(() => service.dispose());
  let writes = 0;
  const first = service.start("session-a", "fixture", async (interaction) => {
    await interaction.prompt({ type: "secret", message: "Code" });
    writes++;
    return {};
  });
  await until(() => Boolean(service.read("session-a", first.id)?.prompt));
  assert.equal(service.cancel("session-a", first.id).status, "cancelling");
  await until(
    () => service.read("session-a", first.id)?.status === "cancelled",
  );
  assert.equal(writes, 0);
  const second = service.start(
    "session-a",
    "fixture",
    async (interaction) => {
      await interaction.prompt({ type: "text", message: "Code" });
      return {};
    },
    15,
  );
  await until(() => service.read("session-a", second.id)?.status === "expired");
  const committed = Promise.withResolvers<{ refreshRequired?: boolean }>();
  const third = service.start("session-a", "fixture", () => committed.promise);
  service.cancel("session-a", third.id);
  committed.resolve({ refreshRequired: true });
  await until(
    () => service.read("session-a", third.id)?.status === "succeeded",
  );
  assert.equal(service.read("session-a", third.id)?.refreshRequired, true);
});

test("provider projections bound messages, preserve native device codes and redact failures", async (t) => {
  const service = new WebProviderLoginService();
  t.after(() => service.dispose());
  const flow = service.start("session-a", "fixture", async (interaction) => {
    interaction.notify({
      type: "device_code",
      userCode: "CODE-1234",
      verificationUri: "https://accounts.example/device",
    });
    for (let i = 0; i < 30; i++)
      interaction.notify({ type: "progress", message: "m".repeat(2000) });
    await interaction.prompt({ type: "text", message: "Finish" });
    throw new Error("private-token-provider-error");
  });
  await until(() => Boolean(service.read("session-a", flow.id)?.prompt));
  const state = service.read("session-a", flow.id)!;
  assert.deepEqual(state.device, {
    code: "CODE-1234",
    url: "https://accounts.example/device",
  });
  assert.equal(state.messages.length, 8);
  assert.ok(state.messages.every((item) => item.message.length === 1000));
  state.messages[0]!.message = "do not mutate canonical state";
  assert.notEqual(
    service.read("session-a", flow.id)!.messages[0]!.message,
    state.messages[0]!.message,
  );
  service.respond("session-a", flow.id, state.prompt!.id, "");
  await until(() => service.read("session-a", flow.id)?.status === "failed");
  assert.equal(
    JSON.stringify(service.read("session-a", flow.id)).includes(
      "private-token",
    ),
    false,
  );
  assert.equal(service.read("session-a", flow.id)?.device, undefined);
  const unsafe = service.start("session-a", "fixture", async (interaction) => {
    interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
    return {};
  });
  await until(() => service.read("session-a", unsafe.id)?.status === "failed");
});
