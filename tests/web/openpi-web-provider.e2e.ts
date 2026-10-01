import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceReferenceTokens } from "../../web/protocol/session-sources.ts";
import {
  MODEL_ID,
  PROVIDER_ID,
  startFakeProvider,
} from "./provider-e2e-support.ts";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authHeaders = { Authorization: `Bearer ${token}` };

test("ordinary file attachments preserve original bytes and reach native Pi read through the real provider", async ({
  page,
}, testInfo) => {
  const content = "附件验收：中文与 emoji 🧪\nconst value = 598;\n";
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff]);
  const provider = await startFakeProvider((body, index) => {
    const request = body as {
      messages: {
        role: string;
        content: string | { type: string; text?: string }[];
      }[];
    };
    const user = request.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user");
    const text =
      typeof user?.content === "string"
        ? user.content
        : (user?.content.find((part) => part.type === "text")?.text ?? "");
    const path = sourceReferenceTokens(text).find((source) =>
      source.reference.endsWith(".ts"),
    )?.name;
    const delta =
      index === 0 && path
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-attached-text",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: "The native file contents were received.",
          };
    return (
      [
        {
          id: "files-e2e",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: "files-e2e",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: MODEL_ID,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: index === 0 && path ? "tool_calls" : "stop",
            },
          ],
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  });
  const workspace = await mkdtemp(join(tmpdir(), "openpi-files-provider-"));
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers: authHeaders,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const created = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: (await imported.json()).path,
        commandId: "files-provider-e2e-session",
      },
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    expect(
      (
        await page.request.post("/api/model", {
          headers: authHeaders,
          data: {
            provider: PROVIDER_ID,
            modelId: MODEL_ID,
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
          },
        })
      ).status(),
    ).toBe(200);
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    await expect(input).toBeEnabled();
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles([
        {
          name: "100% 中文验收说明.ts",
          mimeType: "text/plain",
          buffer: Buffer.from(content),
        },
        { name: "archive.zip", mimeType: "application/zip", buffer: binary },
      ]);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(2);
    await expect(
      page.locator(".composer-file-attachment").first(),
    ).toContainText("文本已就绪");
    await expect(
      page.locator(".composer-file-attachment").last(),
    ).toContainText("原文件已就绪");
    await page
      .locator(".composer-file-attachment")
      .first()
      .getByRole("button")
      .first()
      .click();
    await expect(page.getByRole("dialog")).toContainText(content.trim());
    await page.keyboard.press("Escape");
    const upload = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    const admission = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/prompt" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const uploadResponse = await upload;
    expect(uploadResponse.status()).toBe(200);
    const receipt = await uploadResponse.json();
    expect(receipt.sessionId).toBe(session.sessionId);
    expect(await readFile(receipt.files[0].path, "utf8")).toBe(content);
    expect(await readFile(receipt.files[0].textPath, "utf8")).toBe(content);
    expect(await readFile(receipt.files[1].path)).toEqual(binary);
    expect(receipt.files[1].textPath).toBeUndefined();
    expect((await admission).status()).toBe(202);
    await expect.poll(() => provider.requests.length).toBe(2);
    const messages = (
      provider.requests[1].body as {
        messages: { role: string; content: unknown }[];
      }
    ).messages;
    expect(
      messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.includes(content.trim()),
      ),
    ).toBe(true);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(
      page.locator(".message-row.assistant.response").last(),
    ).toContainText("The native file contents were received.");
    await expect(page.locator(".notice")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("files-upload-native-read.png"),
      animations: "disabled",
    });
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("uploaded screenshots reach the real Host and provider without preview metadata", async ({
  page,
}, testInfo) => {
  const provider = await startFakeProvider();
  const workspace = await mkdtemp(join(tmpdir(), "openpi-image-provider-"));
  const imageData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2uoAAAAASUVORK5CYII=";
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers: authHeaders,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const created = await page.request.post("/api/sessions", {
      headers: authHeaders,
      data: {
        workspacePath: (await imported.json()).path,
        commandId: "image-provider-e2e-session",
      },
    });
    expect(created.status()).toBe(201);
    const snapshot = await (
      await page.request.get("/api/snapshot", { headers: authHeaders })
    ).json();
    const selected = await page.request.post("/api/model", {
      headers: authHeaders,
      data: {
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
        sessionId: snapshot.currentSessionId,
        sessionPath: snapshot.selectedSession.path,
      },
    });
    expect(selected.status()).toBe(200);
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    await expect(input).toBeEnabled();
    await input.fill("请查看这张截图");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "截屏2026-09-30 23.44.32.png",
        mimeType: "image/png",
        buffer: Buffer.from(imageData, "base64"),
      });
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    const admission = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/prompt" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const response = await admission;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON().images).toEqual([
      {
        data: imageData,
        mimeType: "image/png",
        name: "截屏2026-09-30 23.44.32.png",
      },
    ]);
    await expect.poll(() => provider.requests.length).toBe(1);
    const body = provider.requests[0]!.body as {
      messages: {
        role: string;
        content:
          | string
          | { type: string; text?: string; image_url?: { url: string } }[];
      }[];
    };
    const content = body.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("Missing provider image");
    expect(content).toContainEqual({ type: "text", text: "请查看这张截图" });
    expect(
      content.find((part) => part.type === "image_url")?.image_url?.url,
    ).toBe(`data:image/png;base64,${imageData}`);
    await expect(input).toHaveValue("");
    await expect(page.locator(".composer-attachment")).toHaveCount(0);
    await expect(page.locator(".message-row.assistant")).toContainText(
      "Thinking level acknowledged.",
    );
    await expect
      .poll(async () => {
        const snapshot = await (
          await page.request.get("/api/snapshot", { headers: authHeaders })
        ).json();
        return snapshot.runtime.status;
      })
      .toBe("idle");
    await expect(page.locator(".message-row.user")).toHaveCount(1);
    await expect(page.locator(".turn-state.waiting")).toHaveCount(0);
    await expect(page.locator(".message-row").first()).toHaveClass(/user/u);
    await expect(page.locator(".notice")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("image-upload-delivered.png"),
      animations: "disabled",
    });
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

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
    const snapshot = await initialSnapshot.json();
    const sessionId = snapshot.currentSessionId as string;
    const sessionPath = snapshot.selectedSession.path as string;
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // Select the fake reasoning model through the real Web runtime.
    const selected = await page.request.post("/api/model", {
      headers: authHeaders,
      data: {
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
        sessionId,
        sessionPath,
      },
    });
    expect(selected.status()).toBe(200);

    // Load the real UI on the active Session. The thinking picker only exists
    // once a workspace and model are active.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("textbox", { name: "描述任务" })).toBeVisible();
    const thinkingPicker = page.locator(".model-picker > button");
    await expect(thinkingPicker).toBeVisible();
    await expect(thinkingPicker).toBeEnabled();

    // Choose `high` in the real picker and wait for the confirmed state.
    const thinkingWrite = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/thinking" &&
        response.request().method() === "POST",
    );
    await thinkingPicker.click();
    expect(snapshot.thinking.available.at(-1)).toBe("high");
    await page.getByRole("slider", { name: "思考等级" }).press("End");
    expect((await thinkingWrite).status()).toBe(200);
    const thinkingWrap = page.locator(".model-picker-wrap");
    await expect(thinkingWrap).toHaveAttribute("data-level", "high");
    await expect(thinkingWrap).toHaveAttribute("data-pending", "false");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("textbox", { name: "描述任务" }).click();

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
    await expect(thinkingPicker).toBeDisabled();

    provider.release();
    await expect(page.locator(".message-row.assistant")).toContainText(
      "Thinking level acknowledged.",
    );

    // Reload: the persisted level is reflected through both read paths.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(thinkingWrap).toHaveAttribute("data-level", "high");
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
    await thinkingPicker.click();
    await page.getByRole("slider", { name: "思考等级" }).press("Home");
    await expect(thinkingWrap).toHaveAttribute("data-level", "off");
    await page.getByRole("textbox", { name: "描述任务" }).click();
    await page
      .getByRole("textbox", { name: "描述任务" })
      .fill("Without reasoning effort");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(() => provider.requests.length, { timeout: 15_000 })
      .toBe(2);
    const offBody = provider.requests[1].body as Record<string, unknown>;
    expect("reasoning_effort" in offBody).toBe(false);
    await expect(thinkingPicker).toBeEnabled();
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
