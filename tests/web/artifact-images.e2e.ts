import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

test("previews a real screenshot through its authorized handle, fits it, and reports corrupt images", async ({
  browser,
}, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-image-preview-"));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 600;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#234678";
    drawing.fillRect(0, 0, 1200, 600);
    drawing.fillStyle = "#fff";
    drawing.font = "48px sans-serif";
    drawing.fillText("Authorized screenshot preview", 40, 90);
    drawing.fillStyle = "#4ada78";
    drawing.fillRect(0, 560, 1200, 40);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await writeFile(
    join(cwd, "screenshot.png"),
    Buffer.from(imageData, "base64"),
  );
  await writeFile(
    join(cwd, "broken.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  );
  await writeFile(
    join(cwd, "vector.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.previewScriptExecuted = true</script></svg>',
  );
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "[Screenshot](./screenshot.png) [Broken](./broken.png) [Vector](./vector.svg)",
      },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    searchModels: (query, limit) =>
      projectWebModelSearch(runtime.listModels(), query, limit),
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: () => () => {},
    dispose: async () => {},
    sendPrompt: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({ runtime });
  const downloads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/artifacts/content" &&
      url.searchParams.get("download") === "1"
    )
      downloads.push(url.searchParams.get("handle")!);
  });
  try {
    await host.start();
    await page.goto(host.origin);
    await page.getByRole("button", { name: "Screenshot", exact: true }).click();
    const image = page.getByRole("img", {
      name: "screenshot.png",
      exact: true,
    });
    await expect(image).toBeVisible();
    const sizing = await image.evaluate((element) => {
      const img = element as HTMLImageElement;
      return {
        width: img.width,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        panel: img.closest(".artifact-panel-body")!.clientWidth,
      };
    });
    expect(sizing.naturalWidth).toBe(1200);
    expect(sizing.naturalHeight).toBe(600);
    expect(sizing.width).toBeLessThan(sizing.panel);
    const details = page.locator(".artifact-file-details");
    await expect(details).not.toHaveAttribute("open");
    await details.locator("summary").click();
    await expect(details).toContainText(manager.getSessionId());
    expect(downloads).toHaveLength(1);
    const blobUrl = await image.getAttribute("src");
    await page.screenshot({
      path: testInfo.outputPath("artifact-image-preview.png"),
    });
    await page.getByRole("button", { name: /Close preview|关闭预览/u }).click();
    expect(
      await page.evaluate(async (url) => {
        try {
          await fetch(url!);
          return true;
        } catch {
          return false;
        }
      }, blobUrl),
    ).toBe(false);
    await page.getByRole("button", { name: "Vector", exact: true }).click();
    await expect(page.locator(".artifact-revision")).toHaveCount(1);
    await expect(page.locator(".artifact-image-preview")).toHaveCount(0);
    expect(downloads).toHaveLength(1);
    expect(
      await page.evaluate(() => Reflect.get(window, "previewScriptExecuted")),
    ).toBeUndefined();
    await page.getByRole("button", { name: /Close preview|关闭预览/u }).click();
    await page.getByRole("button", { name: "Broken", exact: true }).click();
    await expect(
      page.locator(".artifact-panel").getByRole("alert"),
    ).toContainText(/preview this image|图片预览失败/u);
    await expect(page.locator(".artifact-image-preview img")).toHaveCount(0);
    expect(downloads).toHaveLength(2);
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
