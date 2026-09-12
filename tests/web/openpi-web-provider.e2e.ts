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
