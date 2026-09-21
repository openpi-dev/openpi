import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_ID,
  PROVIDER_ID,
  startFakeProvider,
} from "./provider-e2e-support.ts";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authHeaders = { Authorization: `Bearer ${token}` };

test("thinking level reaches the provider request end to end", async ({
  page,
}) => {
  const provider = await startFakeProvider();
  const workspace = await mkdtemp(join(tmpdir(), "openpi-thinking-provider-"));
  try {
    // Import a throwaway workspace and create+activate a real Web Session.
    const imported = await page.request.post("/api/workspaces", {
      headers: authHeaders,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path: canonicalWorkspace } = await imported.json();

    const created = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: canonicalWorkspace,
        commandId: "thinking-provider-e2e-session",
      },
    });
    expect(created.status()).toBe(201);

    const initialSnapshot = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const sessionId = (await initialSnapshot.json()).currentSessionId as string;
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // Select the fake reasoning model through the real Web runtime.
    const selected = await page.request.post("/api/model", {
      headers: authHeaders,
      data: { provider: PROVIDER_ID, modelId: MODEL_ID, sessionId },
    });
    expect(selected.status()).toBe(200);

    // Load the real UI on the active Session. The thinking picker only exists
    // once a workspace and model are active.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("textbox", { name: "描述任务" })).toBeVisible();
    const thinkingPicker = page.locator(".thinking-picker");
    await expect(thinkingPicker).toBeVisible();
    await expect(thinkingPicker).toBeEnabled();

    // Choose `high` in the real picker and wait for the confirmed state.
    const thinkingWrite = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/thinking" &&
        response.request().method() === "POST",
    );
    await thinkingPicker.click();
    await page.getByRole("menuitem", { name: "high", exact: true }).click();
    expect((await thinkingWrite).status()).toBe(200);
    const thinkingWrap = page.locator(".thinking-picker-wrap");
    await expect(thinkingWrap).toHaveAttribute("data-level", "high");
    await expect(thinkingWrap).toHaveAttribute("data-pending", "false");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Hold the provider response so the running-state picker lock is
    // observable deterministically. The request is recorded before the hold.
    provider.holdNextResponse();
    await page
      .getByRole("textbox", { name: "描述任务" })
      .fill("Confirm the thinking level");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(1);
    const [request] = provider.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/chat/completions");
    const requestBody = request.body as {
      model?: unknown;
      reasoning_effort?: unknown;
    };
    expect(requestBody.model).toBe(MODEL_ID);
    expect(requestBody.reasoning_effort).toBe("high");
    await expect(page.locator(".thinking-picker")).toBeDisabled();

    provider.release();
    await expect(page.locator(".message-row.assistant")).toContainText(
      "Thinking level acknowledged.",
    );

    // Reload: the persisted level is reflected through both read paths.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "high",
    );
    const thinkingRead = await page.request.get(
      `/api/thinking?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: authHeaders },
    );
    expect(thinkingRead.status()).toBe(200);
    expect((await thinkingRead.json()).level).toBe("high");
    const reloadedSnapshot = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    expect((await reloadedSnapshot.json()).thinking.level).toBe("high");

    // `off` must omit reasoning_effort rather than send "off".
    await page.locator(".thinking-picker").click();
    await page.getByRole("menuitem", { name: "off", exact: true }).click();
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "off",
    );
    await page
      .getByRole("textbox", { name: "描述任务" })
      .fill("Without reasoning effort");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(2);
    const offBody = provider.requests[1].body as Record<string, unknown>;
    expect("reasoning_effort" in offBody).toBe(false);
    await expect(page.locator(".thinking-picker")).toBeEnabled();
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preserves a held turn identity across A/B/A replacement and reload", async ({
  page,
}, testInfo) => {
  const provider = await startFakeProvider();
  const workspace = await mkdtemp(join(tmpdir(), "openpi-stop-provider-"));
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers: authHeaders,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path: canonicalWorkspace } = await imported.json();

    const createdA = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: canonicalWorkspace,
        commandId: "stop-provider-session-a",
      },
    });
    expect(createdA.status()).toBe(201);
    const createdABody = (await createdA.json()) as {
      sessionId?: unknown;
      sessionPath?: unknown;
    };
    expect(typeof createdABody.sessionId).toBe("string");
    expect(typeof createdABody.sessionPath).toBe("string");
    const sessionAPath = createdABody.sessionPath as string;

    const initialSnapshot = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const sessionAId = (
      (await initialSnapshot.json()) as {
        currentSessionId?: unknown;
      }
    ).currentSessionId;
    expect(typeof sessionAId).toBe("string");

    const selected = await page.request.post("/api/model", {
      headers: authHeaders,
      data: {
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
        sessionId: sessionAId,
      },
    });
    expect(selected.status()).toBe(200);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const prompt = page.getByRole("textbox", { name: "描述任务" });
    await expect(prompt).toBeVisible();

    // Persist A before replacing the active runtime; Pi writes a newly created
    // session file once its first assistant message reaches a terminal event.
    await prompt.fill("Persist Session A before switching");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(1);
    await expect(page.locator(".message-row.assistant").last()).toContainText(
      "Thinking level acknowledged.",
    );

    provider.holdNextResponse();
    const firstPromptRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/prompt" &&
        request.method() === "POST",
    );
    await prompt.fill("Keep the first Session running");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const firstPromptBody = (await firstPromptRequest).postDataJSON() as {
      commandId?: unknown;
      sessionId?: unknown;
    };
    expect(typeof firstPromptBody.commandId).toBe("string");
    expect(firstPromptBody.sessionId).toBe(sessionAId);

    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(2);
    const runningAResponse = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const runningA = (await runningAResponse.json()) as {
      currentSessionId?: unknown;
      runtime: {
        status: string;
        activeTurn?: {
          sessionId: string;
          commandId: string;
          epoch: number;
        };
      };
    };
    expect(runningA.currentSessionId).toBe(sessionAId);
    expect(runningA.runtime.status).toBe("running");
    const firstTurn = runningA.runtime.activeTurn;
    expect(firstTurn).toEqual({
      sessionId: sessionAId,
      commandId: firstPromptBody.commandId,
      epoch: expect.any(Number),
    });

    const createdB = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: canonicalWorkspace,
        commandId: "stop-provider-session-b",
      },
    });
    expect(createdB.status()).toBe(201);
    const createdBBody = (await createdB.json()) as {
      sessionId?: unknown;
    };
    expect(typeof createdBBody.sessionId).toBe("string");
    expect(createdBBody.sessionId).not.toBe(sessionAId);

    const runningBResponse = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const runningB = (await runningBResponse.json()) as {
      currentSessionId?: unknown;
      runtime: { status: string; activeTurn?: unknown };
    };
    expect(runningB.currentSessionId).toBe(createdBBody.sessionId);
    expect(runningB.runtime.status).toBe("idle");
    expect(runningB.runtime.activeTurn).toBeUndefined();

    // The original A handle is scoped to A and cannot stop the selected B.
    const staleOnB = await page.request.post("/api/turns/cancel", {
      headers: authHeaders,
      data: firstTurn,
    });
    expect(staleOnB.status()).toBe(409);
    expect(await staleOnB.json()).toMatchObject({
      state: "stale-session",
      accepted: false,
    });
    expect(provider.requests).toHaveLength(2);

    const selectedA = await page.request.post("/api/sessions/select", {
      headers: authHeaders,
      data: { path: sessionAPath },
    });
    const selectedABody = await selectedA.json();
    expect(selectedA.status(), JSON.stringify(selectedABody)).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await page.request.get("/api/snapshot", {
              headers: authHeaders,
            })
          ).json() as Promise<{
            currentSessionId?: unknown;
            runtime: { status: string; activeTurn?: unknown };
          }>,
        { timeout: 15_000 },
      )
      .toMatchObject({
        currentSessionId: sessionAId,
        runtime: { status: "running", activeTurn: firstTurn },
      });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(prompt).toBeVisible();
    const stop = page.getByRole("button", {
      name: "停止当前轮次",
      exact: true,
    });
    await expect(stop).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await page.request.get("/api/snapshot", {
              headers: authHeaders,
            })
          ).json() as Promise<{
            runtime: { status: string; activeTurn?: unknown };
          }>,
        { timeout: 15_000 },
      )
      .toMatchObject({
        runtime: { status: "running", activeTurn: firstTurn },
      });
    await page.screenshot({
      path: testInfo.outputPath("stop-session-switch-running.png"),
      fullPage: true,
    });

    const firstCancelResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/turns/cancel" &&
        response.request().method() === "POST",
    );
    await stop.click();
    const firstCancel = await firstCancelResponse;
    expect(firstCancel.status()).toBe(202);
    expect(await firstCancel.json()).toMatchObject({
      state: "accepted",
      accepted: true,
    });
    await expect
      .poll(
        async () =>
          (
            await page.request.get("/api/snapshot", {
              headers: authHeaders,
            })
          ).json() as Promise<{
            runtime: { status: string; activeTurn?: unknown };
          }>,
        { timeout: 15_000 },
      )
      .toMatchObject({ runtime: { status: "idle" } });
    await expect(stop).toHaveCount(0);
    await expect(page.locator(".composer-hint")).toContainText(
      "当前轮次已停止。",
    );
    provider.release();

    // A new turn gets a new identity. Reusing the old handle is idempotent and
    // must not cancel the new one.
    provider.holdNextResponse();
    const secondPromptRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/prompt" &&
        request.method() === "POST",
    );
    await prompt.fill("Start a fresh turn in Session A");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const secondPromptBody = (await secondPromptRequest).postDataJSON() as {
      commandId?: unknown;
    };
    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(3);
    const runningNewAResponse = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const runningNewA = (await runningNewAResponse.json()) as {
      runtime: {
        status: string;
        activeTurn?: {
          sessionId: string;
          commandId: string;
          epoch: number;
        };
      };
    };
    expect(runningNewA.runtime.status).toBe("running");
    const secondTurn = runningNewA.runtime.activeTurn;
    expect(secondTurn).toEqual({
      sessionId: sessionAId,
      commandId: secondPromptBody.commandId,
      epoch: expect.any(Number),
    });
    expect(secondTurn).not.toEqual(firstTurn);

    const staleOnNewA = await page.request.post("/api/turns/cancel", {
      headers: authHeaders,
      data: firstTurn,
    });
    expect(staleOnNewA.status()).toBe(200);
    expect(await staleOnNewA.json()).toMatchObject({
      state: "already-settled",
      accepted: false,
    });
    expect(provider.requests).toHaveLength(3);
    await expect(stop).toBeVisible();

    const secondCancelResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/turns/cancel" &&
        response.request().method() === "POST",
    );
    await stop.click();
    const secondCancel = await secondCancelResponse;
    expect(secondCancel.status()).toBe(202);
    expect(await secondCancel.json()).toMatchObject({
      state: "accepted",
      accepted: true,
    });
    await expect
      .poll(
        async () =>
          (
            await page.request.get("/api/snapshot", {
              headers: authHeaders,
            })
          ).json() as Promise<{
            runtime: { status: string; activeTurn?: unknown };
          }>,
        { timeout: 15_000 },
      )
      .toMatchObject({ runtime: { status: "idle" } });
    provider.release();
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("keeps native cron wake cancellation tied to its runtime identity", async ({
  page,
}, testInfo) => {
  test.setTimeout(100_000);
  const provider = await startFakeProvider();
  const workspace = await mkdtemp(join(tmpdir(), "openpi-cron-provider-"));
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers: authHeaders,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path: canonicalWorkspace } = await imported.json();

    const created = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: canonicalWorkspace,
        commandId: "cron-provider-session",
      },
    });
    expect(created.status()).toBe(201);
    const snapshot = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const sessionId = (
      (await snapshot.json()) as {
        currentSessionId?: unknown;
      }
    ).currentSessionId;
    expect(typeof sessionId).toBe("string");

    const selected = await page.request.post("/api/model", {
      headers: authHeaders,
      data: { provider: PROVIDER_ID, modelId: MODEL_ID, sessionId },
    });
    expect(selected.status()).toBe(200);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const prompt = page.getByRole("textbox", { name: "描述任务" });
    await expect(prompt).toBeVisible();

    // The isolated package source registers /cron. Hold its eventual provider
    // response so the native agent_start identity is visible to the UI.
    provider.holdNextResponse();
    const cronPromptResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/prompt" &&
        response.request().method() === "POST",
    );
    await prompt.fill("/cron in 30s Verify native wake cancellation");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const cronResponse = await cronPromptResponse;
    expect(cronResponse.status()).toBe(202);
    expect(await cronResponse.json()).toMatchObject({
      accepted: true,
      state: "accepted",
    });

    await expect
      .poll(() => provider.requests.length, { timeout: 85_000 })
      .toBe(1);
    const nativeSnapshotResponse = await page.request.get("/api/snapshot", {
      headers: authHeaders,
    });
    const nativeSnapshot = (await nativeSnapshotResponse.json()) as {
      currentSessionId?: unknown;
      runtime: {
        status: string;
        activeTurn?: {
          sessionId: string;
          commandId: string;
          epoch: number;
        };
      };
    };
    expect(nativeSnapshot.currentSessionId).toBe(sessionId);
    expect(nativeSnapshot.runtime.status).toBe("running");
    const nativeTurn = nativeSnapshot.runtime.activeTurn;
    expect(nativeTurn).toEqual({
      sessionId,
      commandId: expect.stringMatching(/^native-/u),
      epoch: expect.any(Number),
    });

    const stop = page.getByRole("button", {
      name: "停止当前轮次",
      exact: true,
    });
    await expect(stop).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("native-cron-wake-running.png"),
      fullPage: true,
    });

    const cancelResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/turns/cancel" &&
        response.request().method() === "POST",
    );
    await stop.click();
    const cancel = await cancelResponse;
    expect(cancel.status()).toBe(202);
    expect(await cancel.json()).toMatchObject({
      state: "accepted",
      accepted: true,
    });
    await expect
      .poll(
        async () =>
          (
            await page.request.get("/api/snapshot", {
              headers: authHeaders,
            })
          ).json() as Promise<{
            runtime: { status: string; activeTurn?: unknown };
          }>,
        { timeout: 15_000 },
      )
      .toMatchObject({ runtime: { status: "idle" } });
    await expect(stop).toHaveCount(0);
    await expect(page.locator(".composer-hint")).toContainText(
      "当前轮次已停止。",
    );
    provider.release();
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
