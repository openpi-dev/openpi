import { expect, test } from "@playwright/test";
import { createAttachmentHost } from "./file-formats-e2e-support.ts";

test("a file preview closes when an accepted in-flight upload consumes its draft attachment", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let uploadHeld = false;
  try {
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("验收发送期间打开的文件预览");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "preview-lifecycle.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("原文件保留，预览跟随当前草稿。"),
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
      .getByRole("button", {
        name: "预览文件 preview-lifecycle.txt",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "预览文件 preview-lifecycle.txt",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("原文件保留，预览跟随当前草稿。");
    await expect(
      page.locator('.composer button[type="submit"]'),
    ).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath("file-preview-pending-upload.png"),
    });
    release?.();
    await expect.poll(() => fixture.prompts.length).toBe(1);
    await expect(dialog).toBeHidden();
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await expect(input).toHaveValue("");
    // The modal has closed before ordinary sidebar navigation is possible.
    await page
      .locator(".session-row")
      .filter({ has: page.locator(".session-title", { hasText: "Formats B" }) })
      .locator("button")
      .first()
      .click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    await page
      .locator(".session-row")
      .filter({ has: page.locator(".session-title", { hasText: "Formats A" }) })
      .locator("button")
      .first()
      .click();
    await expect(input).toBeEnabled();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".composer-file-attachment")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("file-preview-consumed-and-returned.png"),
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    release?.();
    await fixture.close();
  }
});
