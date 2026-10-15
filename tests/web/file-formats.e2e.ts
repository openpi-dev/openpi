import { readFile } from "node:fs/promises";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import type { WebPromptFilesResponse } from "../../web/protocol/prompt-files.ts";
import { WEB_PROMPT_FILE_MAX_TEXT_BYTES } from "../../web/protocol/prompt-files.ts";
import { sourceReferenceTokens } from "../../web/protocol/session-sources.ts";
import {
  attachmentFormatFixtures,
  createAttachmentHost,
} from "./file-formats-e2e-support.ts";

test("bundled attachment workers extract PDF and Office, retain originals and send real Host receipts", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const files = await attachmentFormatFixtures();
    const input = page.getByRole("textbox", { name: "描述任务" });
    await expect(input).toBeEnabled();
    const caption = "请查看这批基础文件\n  保留这行缩进和换行";
    await input.fill(caption);
    await page.locator('input[type="file"]').first().setInputFiles(files);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(
      files.length,
    );
    for (const file of files) {
      const attachment = page.locator(".composer-file-attachment").filter({
        has: page.getByRole("button", {
          name: `预览文件 ${file.name}`,
          exact: true,
        }),
      });
      await expect(attachment).toContainText(
        file.text === undefined ? "原文件已就绪" : "文本已就绪",
      );
    }
    await page
      .getByRole("button", { name: "预览文件 分页报告.pdf", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "[Page 2]\nOpenPI page two",
    );
    await page.screenshot({
      path: testInfo.outputPath("pdf-extracted-page-preview.png"),
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "预览文件 扫描报告.pdf", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("此文件未提取出文本");
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
    const uploaded = await upload;
    expect(uploaded.status()).toBe(200);
    const receipt: WebPromptFilesResponse = await uploaded.json();
    expect(receipt.sessionId).toBe(fixture.first.getSessionId());
    expect(receipt.sessionPath).toBe(fixture.first.getSessionFile());
    expect(receipt.files).toHaveLength(files.length);
    for (let index = 0; index < files.length; index++) {
      const expected = files[index]!;
      const stored = receipt.files[index]!;
      expect(stored.name).toBe(expected.name);
      expect(await readFile(stored.path)).toEqual(expected.buffer);
      if (expected.text === undefined) expect(stored.textPath).toBeUndefined();
      else {
        expect(stored.textPath).toBeTruthy();
        expect(await readFile(stored.textPath!, "utf8")).toBe(expected.text);
      }
    }
    expect((await admission).status()).toBe(202);
    await expect.poll(() => fixture.prompts.length).toBe(1);
    const canonical = fixture.prompts[0]!.content;
    const references = sourceReferenceTokens(canonical);
    const read = createReadTool(fixture.first.getCwd());
    for (let index = 0; index < receipt.files.length; index++) {
      const file = receipt.files[index]!;
      const original = references.find(
        (reference) => reference.reference === encodeURI(file.path),
      );
      expect(original?.name).toBe(file.path);
      if (file.textPath) {
        const extracted = references.find(
          (reference) => reference.reference === encodeURI(file.textPath!),
        );
        expect(extracted?.name).toBe(file.textPath);
        const result = await read.execute(`native-sidecar-${index}`, {
          path: extracted!.name,
        });
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        expect(text).toBe(files[index]!.text);
      }
    }
    expect(canonical).toContain(caption);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await expect(input).toHaveValue("");
    const userMessage = page.locator(".message-row.user").last();
    await expect(userMessage.locator(".user-file-reference")).toHaveCount(
      references.length,
    );
    await expect(userMessage.locator(".user-file-reference-path")).toHaveCount(
      0,
    );
    await expect(userMessage.locator(".message-body")).toContainText(caption);
    expect(
      await userMessage.locator(".message-body").textContent(),
    ).not.toContain(".prompt-files");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: fixture.host.origin,
      });
    await userMessage
      .getByRole("button", { name: "复制消息", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(canonical);
    const details = userMessage.locator(".user-file-reference-details").first();
    await details.click();
    await expect(userMessage.locator(".user-file-reference-path")).toHaveText(
      receipt.files[0]!.path,
    );
    await page.screenshot({
      path: testInfo.outputPath("sent-file-path-expanded.png"),
    });
    await details.click();
    await expect(userMessage.locator(".user-file-reference-path")).toHaveCount(
      0,
    );
    const saved = fixture.first.getBranch().at(-1);
    expect(
      saved?.type === "message" &&
        saved.message.role === "user" &&
        saved.message.content,
    ).toBe(canonical);
    expect(fixture.errors).toEqual([]);
    await testInfo.attach("upload-receipt", {
      body: JSON.stringify(receipt, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({
      path: testInfo.outputPath("file-formats-admitted.png"),
    });
  } finally {
    await fixture.close();
  }
});

test("a Chrome-generated two-page Chinese PDF preserves body text and emoji through the production worker", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const source = await browser.newPage();
  const fixture = await createAttachmentHost(browser);
  const html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>@page { size: A4; margin: 24mm; } body { font: 18px "Arial Unicode MS"; } .second { break-before: page; }</style><body><section><h1>中文 PDF 验收</h1><p>第一页正文：你好，世界！</p><p>百分号 100% 和符号 [中文]。</p></section><section class="second"><h1>第二页正文</h1><p>文件附件内容保真 🙂</p></section></body></html>';
  try {
    await source.setContent(html);
    await source.evaluate(() => document.fonts.ready);
    const original = await source.pdf({ format: "A4", printBackground: true });
    await testInfo.attach("chrome-generated-chinese-pdf", {
      body: original,
      contentType: "application/pdf",
    });
    await testInfo.attach("source-html", {
      body: html,
      contentType: "text/html",
    });
    await fixture.page.locator('input[type="file"]').first().setInputFiles({
      name: "中文正文验收.pdf",
      mimeType: "application/pdf",
      buffer: original,
    });
    await expect(
      fixture.page.locator(".composer-file-attachment"),
    ).toContainText("文本已就绪");
    await fixture.page
      .getByRole("button", { name: "预览文件 中文正文验收.pdf", exact: true })
      .click();
    const dialog = fixture.page.getByRole("dialog");
    for (const text of [
      "[Page 1]",
      "第一页正文：你好，世界！",
      "百分号 100% 和符号 [中文]。",
      "[Page 2]",
      "第二页正文",
      "文件附件内容保真 🙂",
    ])
      await expect(dialog).toContainText(text);
    await fixture.page.screenshot({
      path: testInfo.outputPath("chinese-pdf-extracted-preview.png"),
    });
    await fixture.page.keyboard.press("Escape");
    const upload = fixture.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await fixture.page
      .getByRole("button", { name: "发送", exact: true })
      .click();
    const uploaded = await upload;
    expect(uploaded.status()).toBe(200);
    const receipt: WebPromptFilesResponse = await uploaded.json();
    const file = receipt.files[0]!;
    expect(await readFile(file.path)).toEqual(original);
    const text = await readFile(file.textPath!, "utf8");
    expect(text.match(/\[Page \d+\]/gu)).toEqual(["[Page 1]", "[Page 2]"]);
    const pages = text.split("\n\n[Page 2]\n");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("第一页正文：你好，世界！");
    expect(pages[0]).not.toContain("第二页正文");
    expect(pages[1]).toContain("第二页正文");
    expect(pages[1]).toContain("文件附件内容保真 🙂");
    await expect.poll(() => fixture.prompts.length).toBe(1);
    const reference = sourceReferenceTokens(fixture.prompts[0]!.content).find(
      (reference) => reference.reference === encodeURI(file.textPath!),
    );
    expect(reference?.name).toBe(file.textPath);
    const native = await createReadTool(fixture.first.getCwd()).execute(
      "native-chinese-pdf",
      { path: reference!.name },
    );
    expect(
      native.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    ).toBe(text);
    expect(fixture.errors).toEqual([]);
    await testInfo.attach("extracted-pdf-pages", {
      body: text,
      contentType: "text/plain",
    });
  } finally {
    await source.close();
    await fixture.close();
  }
});

test("non-native image formats and unreadable text retain original bytes as files", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const bmp = Buffer.alloc(58);
    bmp.write("BM");
    bmp.writeUInt32LE(58, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18);
    bmp.writeInt32LE(1, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp[56] = 255;
    const files = [
      {
        name: "vector.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="red"/></svg>',
        ),
      },
      { name: "pixel.bmp", mimeType: "image/bmp", buffer: bmp },
      {
        name: "legacy-encoding.txt",
        mimeType: "text/plain",
        buffer: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
      },
    ];
    await page.locator('input[type="file"]').first().setInputFiles(files);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(3);
    await expect(page.locator(".composer-image-attachment")).toHaveCount(0);
    await expect(
      page
        .locator(".composer-file-attachment")
        .filter({ hasText: "legacy-encoding.txt" }),
    ).toContainText("未提取文本 · 原文件保留");
    await page
      .getByRole("button", {
        name: "预览文件 legacy-encoding.txt",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toContainText("无法读取文本编码");
    await page.screenshot({
      path: testInfo.outputPath("original-file-extraction-status.png"),
    });
    await page.keyboard.press("Escape");
    const upload = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const receipt: WebPromptFilesResponse = await (await upload).json();
    expect(receipt.files).toHaveLength(3);
    for (let index = 0; index < files.length; index++) {
      const stored = receipt.files[index]!;
      expect(await readFile(stored.path)).toEqual(files[index]!.buffer);
      if (index === 0)
        expect(await readFile(stored.textPath!, "utf8")).toBe(
          files[index]!.buffer.toString("utf8"),
        );
      else expect(stored.textPath).toBeUndefined();
    }
    await expect.poll(() => fixture.prompts.length).toBe(1);
    expect(fixture.prompts[0]!.options?.images ?? []).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("failed optional extraction retains original and valid files with explicit status", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const picker = page.locator('input[type="file"]').first();
    await picker.setInputFiles({
      name: "first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("先保留有效附件"),
    });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    await picker.setInputFiles([
      {
        name: "broken.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("malformed PDF bytes"),
      },
      {
        name: "second.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("随后有效附件"),
      },
    ]);
    await expect(page.locator(".composer-file-attachment")).toHaveCount(3);
    await expect(
      page
        .locator(".composer-file-attachment")
        .filter({ hasText: "broken.pdf" }),
    ).toContainText("未提取文本 · 原文件保留");
    await expect(page.locator(".composer-file-attachment")).toContainText([
      "first.txt",
      "broken.pdf",
      "second.txt",
    ]);
    await page
      .getByRole("button", { name: "预览文件 broken.pdf", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("无法提取文本");
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: testInfo.outputPath("malformed-file-preserves-valid-files.png"),
    });
    const upload = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const receipt: WebPromptFilesResponse = await (await upload).json();
    const original = receipt.files.find((file) => file.name === "broken.pdf")!;
    expect(await readFile(original.path)).toEqual(
      Buffer.from("malformed PDF bytes"),
    );
    expect(original.textPath).toBeUndefined();
    await expect.poll(() => fixture.prompts.length).toBe(1);
    expect(fixture.prompts[0]!.content).toContain("first.txt");
    expect(fixture.prompts[0]!.content).toContain("second.txt");
    expect(fixture.prompts[0]!.content).toContain("broken.pdf");
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("truncated extracted text keeps the complete original and declares the partial sidecar in the prompt", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const original = Buffer.from(
      "a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES - 1) + "你好",
    );
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "long.txt",
      mimeType: "text/plain",
      buffer: original,
    });
    await expect(page.locator(".composer-file-attachment")).toContainText(
      "部分文本 · 保留原文件",
    );
    const upload = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const uploaded = await upload;
    expect(uploaded.status()).toBe(200);
    const receipt: WebPromptFilesResponse = await uploaded.json();
    expect(await readFile(receipt.files[0]!.path)).toEqual(original);
    expect(await readFile(receipt.files[0]!.textPath!, "utf8")).toBe(
      "a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES - 1),
    );
    await expect.poll(() => fixture.prompts.length).toBe(1);
    expect(fixture.prompts[0]!.content).toContain("部分文本 · 保留原文件");
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("synthetic DataTransfer paste and drop stage ordinary files through real bundled workers", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const input = page.getByRole("textbox", { name: "描述任务" });
    await expect(input).toBeEnabled();
    await input.fill("before after");
    const preventsNativeText = await input.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["粘贴文件正文"], "pasted.txt", { type: "text/plain" }),
      );
      transfer.setData("text/plain", "clipboard caption");
      if (element instanceof HTMLTextAreaElement)
        element.setSelectionRange(7, 7);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    expect(preventsNativeText).toBe(false);
    // Synthetic events do not execute Chromium's native insertion/undo action.
    await expect(input).toHaveValue("before after");
    await input.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["拖入文件正文"], "dropped.md", { type: "text/markdown" }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
      );
    });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(2);
    const upload = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const receipt: WebPromptFilesResponse = await (await upload).json();
    expect(await readFile(receipt.files[0]!.path, "utf8")).toBe("粘贴文件正文");
    expect(await readFile(receipt.files[1]!.path, "utf8")).toBe("拖入文件正文");
    await expect.poll(() => fixture.prompts.length).toBe(1);
    expect(fixture.prompts[0]!.content).toContain("before after");
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("upload failure preserves the editable draft and file for a real retry", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("上传失败后仍应保留");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "retry.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("重试原文"),
      });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    let first = true;
    await page.route("**/api/prompt-files", async (route) => {
      if (first) {
        first = false;
        await route.fulfill({
          status: 503,
          json: { error: "格式验收上传暂时不可用" },
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".composer-attachment-error")).toContainText(
      "格式验收上传暂时不可用",
    );
    await expect(input).toHaveValue("上传失败后仍应保留");
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    expect(fixture.prompts).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath("upload-503-preserves-draft.png"),
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => fixture.prompts.length).toBe(1);
    expect(fixture.prompts[0]!.content).toContain("上传失败后仍应保留");
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await expect(input).toHaveValue("");
  } finally {
    await fixture.close();
  }
});

test("a same-id wrong-path receipt never submits files to a different native Session", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("同 ID 也必须核对原生路径");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "owned.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("只属于原会话"),
      });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    await page.route("**/api/prompt-files", async (route) => {
      const response = await route.fetch();
      const receipt: WebPromptFilesResponse = await response.json();
      await route.fulfill({
        response,
        json: { ...receipt, sessionPath: fixture.second.getSessionFile() },
      });
    });
    const uploaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    expect((await uploaded).status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeEnabled();
    expect(fixture.prompts).toHaveLength(0);
    await expect(input).toHaveValue("同 ID 也必须核对原生路径");
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
  } finally {
    await fixture.close();
  }
});

test("an upload returning after a Session switch cannot submit or clear either Session's draft", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploadHeld = false;
  try {
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("原会话草稿");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "original.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("原会话附件"),
      });
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    await page.route("**/api/prompt-files", async (route) => {
      const response = await route.fetch();
      uploadHeld = true;
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => uploadHeld).toBe(true);
    await page
      .locator(".session-row")
      .filter({ has: page.locator(".session-title", { hasText: "Formats B" }) })
      .locator("button")
      .first()
      .click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    await input.fill("另一个会话自己的草稿");
    const uploaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/prompt-files",
    );
    release?.();
    expect((await uploaded).status()).toBe(200);
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeEnabled();
    expect(fixture.prompts).toHaveLength(0);
    await expect(input).toHaveValue("另一个会话自己的草稿");
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await page
      .locator(".session-row")
      .filter({ has: page.locator(".session-title", { hasText: "Formats A" }) })
      .locator("button")
      .first()
      .click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("原会话草稿");
    await expect(page.locator(".composer-file-attachment")).toHaveCount(1);
    expect(fixture.prompts).toHaveLength(0);
  } finally {
    release?.();
    await fixture.close();
  }
});
