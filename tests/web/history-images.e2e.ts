import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { formatSourceReference } from "../../web/protocol/session-sources.ts";
import { WEB_PROMPT_IMAGE_MAX_BYTES } from "../../web/protocol/types.ts";
import { createAttachmentHost } from "./file-formats-e2e-support.ts";

declare global {
  interface Window {
    __openpiAttachmentTestBlobs?: Map<string, Blob>;
  }
}

// Deterministic valid RGB PNGs keep this verifier independent of external fixture files.
function png(width: number, height: number) {
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  let random = 0x12345678;
  for (let row = 0; row < height; row++) {
    for (let col = 1; col < stride; col++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      pixels[row * stride + col] = random & 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function nativeImage(name: string, bytes: Buffer) {
  return {
    type: "image" as const,
    mimeType: "image/png",
    name,
    data: bytes.toString("base64"),
  };
}

test("saved native images preview after reload at exact part indices, with readable file sources", async ({
  browser,
}, info) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    // Observe the exact rendered Blob while preserving production CSP and URL cleanup.
    await page.addInitScript(() => {
      const blobs = new Map<string, Blob>();
      window.__openpiAttachmentTestBlobs = blobs;
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        if (blob instanceof Blob) blobs.set(url, blob);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        blobs.delete(url);
        revoke(url);
      };
    });
    const small = png(2, 2);
    const large = png(1800, 1800);
    expect(large.length).toBeLessThanOrEqual(WEB_PROMPT_IMAGE_MAX_BYTES);
    expect(large.toString("base64").length).toBeGreaterThan(12 * 1024 * 1024);
    await info.attach("saved-small-original.png", {
      body: small,
      contentType: "image/png",
    });
    await info.attach("saved-large-original.png", {
      body: large,
      contentType: "image/png",
    });
    const directory = join(
      fixture.first.getCwd(),
      ...Array.from({ length: 5 }, (_, i) => `${i}-` + "directory".repeat(7)),
    );
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, "中文 100% [1].txt");
    await writeFile(filePath, "可读来源正文\n第二行\n");
    expect(filePath.length).toBeGreaterThan(255);
    const nativeEntryId = fixture.first.appendMessage({
      role: "user",
      timestamp: Date.now(),
      content: [
        { type: "text", text: "保存的图片与文件，刷新后仍可打开。" },
        nativeImage("小图片.png", small),
        { type: "text", text: formatSourceReference(filePath, filePath) },
        nativeImage("大图片.png", large),
      ],
    });
    const reads: {
      part: string | null;
      status: number;
      entryId: string | null;
      sessionId: string | null;
      path: string | null;
    }[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname !== "/api/session-sources/image") return;
      reads.push({
        part: url.searchParams.get("part"),
        status: response.status(),
        entryId: url.searchParams.get("entryId"),
        sessionId: url.searchParams.get("sessionId"),
        path: url.searchParams.get("path"),
      });
    });
    await page.reload();
    const smallCard = page.getByRole("button", {
      name: "小图片.png",
      exact: true,
    });
    const largeCard = page.getByRole("button", {
      name: "大图片.png",
      exact: true,
    });
    const previews: { name: string; width: number; sha256: string }[] = [];
    for (const [card, width, original] of [
      [smallCard, 2, small],
      [largeCard, 1800, large],
    ] as const) {
      await expect(card.locator("img")).toBeVisible();
      await expect
        .poll(() =>
          card
            .locator("img")
            .evaluate((element: HTMLImageElement) => element.naturalWidth),
        )
        .toBe(width);
      const sha256 = await card
        .locator("img")
        .evaluate(async (element: HTMLImageElement) => {
          const blob = window.__openpiAttachmentTestBlobs?.get(element.src);
          if (!blob) throw new Error("Rendered image Blob is unavailable.");
          const bytes = await blob.arrayBuffer();
          return [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
        });
      expect(sha256).toBe(createHash("sha256").update(original).digest("hex"));
      previews.push({
        name: (await card.getAttribute("aria-label")) ?? "",
        width,
        sha256,
      });
    }
    await page.screenshot({
      path: info.outputPath("persisted-images-inline-after.png"),
    });
    await largeCard.click();
    const dialog = page.getByRole("dialog");
    const preview = dialog.getByRole("img", { name: "大图片.png" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(1800);
    const dialogSha256 = await preview.evaluate(
      async (element: HTMLImageElement) => {
        const blob = window.__openpiAttachmentTestBlobs?.get(element.src);
        if (!blob) throw new Error("Rendered image Blob is unavailable.");
        const bytes = await blob.arrayBuffer();
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      },
    );
    expect(dialogSha256).toBe(createHash("sha256").update(large).digest("hex"));
    await expect(
      dialog.getByRole("button", { name: "返回来源列表" }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "原始尺寸", exact: true }).click();
    await expect(dialog.locator('[data-mode="original"]')).toBeVisible();
    await page.screenshot({
      path: info.outputPath("persisted-large-image-original-after.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(largeCard).toBeFocused();
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    const overview = page.locator(".session-overview");
    const sourceFile = overview.getByRole("button", {
      name: "中文 100% [1].txt",
      exact: true,
    });
    await expect(sourceFile).toBeVisible();
    await expect(sourceFile).toHaveAttribute("title", encodeURI(filePath));
    await expect(overview.locator(".session-source-icon img")).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath("source-short-file-name-after.png"),
    });
    await sourceFile.click();
    await expect(page.locator(".artifact-panel")).toContainText("可读来源正文");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const result of reads) {
      expect(result.status).toBe(200);
      expect(result.sessionId).toBe(fixture.first.getSessionId());
      expect(result.path).toBe(fixture.first.getSessionFile());
      expect(result.entryId).toBe(nativeEntryId);
      expect(result.part === "1" || result.part === "3").toBe(true);
    }
    await info.attach("saved-images-receipt", {
      body: JSON.stringify(
        {
          boundary:
            "Production bundled UI, deterministic valid RGB PNGs saved into native Pi Session. Rendered inline/dialog Blob bytes match original SHA256; source HTTP exact Session/path/entryId/part/status and artifact reads verified. No model calls. CDP Response.body is deliberately not used to hash overlapping same-URL image responses.",
          nativeEntryId,
          largeBytes: large.length,
          largeBase64Chars: large.toString("base64").length,
          reads,
          previews,
          dialogSha256,
          errors: fixture.errors,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("offscreen saved images wait for actual visibility before reading bytes", async ({
  browser,
}, info) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const entryId = fixture.first.appendMessage({
      role: "user",
      timestamp: Date.now(),
      content: [nativeImage("旧图片.png", png(2, 2))],
    });
    for (let index = 0; index < 12; index++)
      fixture.first.appendMessage({
        role: "user",
        timestamp: Date.now(),
        content:
          `Later fixture caption ${index}\n` + "保留滚动位置。".repeat(50),
      });
    const reads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/session-sources/image")
        reads.push(url.searchParams.get("entryId")!);
    });
    await page.reload();
    const card = page.getByRole("button", { name: "旧图片.png", exact: true });
    await expect(card).toHaveCount(1);
    await expect(page.locator(".message-row.user")).toHaveCount(14);
    await expect
      .poll(() =>
        card.evaluate((element) => element.getBoundingClientRect().bottom < 0),
      )
      .toBe(true);
    await page.waitForTimeout(150);
    expect(reads).not.toContain(entryId);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("img")).toBeVisible();
    await expect.poll(() => reads.includes(entryId)).toBe(true);
    await page.screenshot({
      path: info.outputPath("saved-image-visible-after.png"),
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a delayed explicit image preview is cancelled when the selected Session changes", async ({
  browser,
}, info) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    fixture.first.appendMessage({
      role: "user",
      timestamp: Date.now(),
      content: [nativeImage("延迟图片.png", png(2, 2))],
    });
    await page.reload();
    const card = page.getByRole("button", {
      name: "延迟图片.png",
      exact: true,
    });
    await expect(card.locator("img")).toBeVisible();
    let held = false;
    await page.route("**/api/session-sources/image?*", async (route) => {
      const response = await route.fetch();
      held = true;
      await wait;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await card.click();
    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole("dialog")).toContainText("正在读取");
    await page.keyboard.press("Escape");
    await page
      .locator(".session-row")
      .filter({ has: page.locator(".session-title", { hasText: "Formats B" }) })
      .locator("button")
      .first()
      .click();
    await expect(page.locator(".message-row.user")).toContainText(
      "Formats B seed",
    );
    release!();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".message-attachment")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("source-image-session-switch-after.png"),
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    release?.();
    await fixture.close();
  }
});
