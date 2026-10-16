import { expect, test } from "@playwright/test";
import { createAttachmentHost } from "./file-formats-e2e-support.ts";

test("search keeps a compact anchored surface, dismisses outside, and fits a narrow viewport", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const trigger = page.getByRole("button", { name: "搜索会话", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "搜索消息内容" });
    const input = dialog.getByRole("searchbox");
    await expect(input).toBeFocused();
    await expect
      .poll(async () => Math.round((await dialog.boundingBox())!.width))
      .toBe(520);
    const initial = (await dialog.boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.y - initial.y).toBeLessThan(10);
    await expect(input).toHaveCSS("border-top-width", "0px");
    await expect(input).toHaveCSS("outline-style", "none");
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    const project = dialog.locator(".transcript-search-project").first();
    expect(Math.round((await project.boundingBox())!.width)).toBe(96);
    const options = dialog.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(input).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      (await options.nth(1).getAttribute("id"))!,
    );
    await page.keyboard.type("Formats A");
    await expect(input).toHaveValue("Formats A");
    await expect(input).toBeFocused();
    await expect(
      dialog.getByRole("option", { name: "打开会话 Formats A", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await input.clear();
    await page.screenshot({
      path: testInfo.outputPath("search-palette-desktop.png"),
    });
    await input.fill("NO_MATCH_FOR_SEARCH_PALETTE_LAYOUT");
    await expect(dialog.locator(".transcript-search-feedback")).toContainText(
      "没有匹配的消息。",
    );
    expect(Math.round((await dialog.boundingBox())!.y)).toBe(
      Math.round(initial.y),
    );
    await page.mouse.click(20, 20);
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.setViewportSize({ width: 390, height: 760 });
    await expect
      .poll(async () => Math.round((await dialog.boundingBox())!.width))
      .toBe(359);
    const narrow = (await dialog.boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(390);
    expect(narrow.y + narrow.height).toBeLessThanOrEqual(760);
    await page.screenshot({
      path: testInfo.outputPath("search-palette-narrow.png"),
    });
    await input.press("Escape");
    await expect(dialog).toBeHidden();
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("changing the transcript query cancels a pending native reveal and keeps the new results usable", async ({
  browser,
}, testInfo) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const firstId = fixture.first.appendMessage({
      role: "user",
      content: "SEARCH_A_NATIVE_QUERY: first exact message",
      timestamp: 1,
    });
    const secondId = fixture.first.appendMessage({
      role: "user",
      content: "SEARCH_B_NATIVE_QUERY: second exact message",
      timestamp: 2,
    });
    let responseReady = false;
    const cancelled: string[] = [];
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/session/message-window")
        cancelled.push(url.searchParams.get("entryId") ?? "");
    });
    await page.route("**/api/session/message-window?**", async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("entryId") !== firstId
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      responseReady = true;
      await delayed;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    await page.getByRole("button", { name: "搜索会话", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索消息内容" });
    const query = dialog.getByRole("searchbox", { name: "搜索消息内容" });
    await query.fill("SEARCH_A_NATIVE_QUERY");
    const first = dialog.getByRole("option", {
      name: "打开 Formats A 中来自你的消息",
      exact: true,
    });
    await expect(first).toContainText("SEARCH_A_NATIVE_QUERY");
    await page.screenshot({
      path: testInfo.outputPath("search-palette-message-result.png"),
    });
    await first.click();
    await expect
      .poll(() => responseReady, {
        message: "The exact native A window was requested and held",
      })
      .toBe(true);
    await expect(first).toBeDisabled();
    await expect(query).toBeFocused();
    await query.fill("SEARCH_B_NATIVE_QUERY");
    const second = dialog.getByRole("option", {
      name: "打开 Formats A 中来自你的消息",
      exact: true,
    });
    await expect(second).toContainText("SEARCH_B_NATIVE_QUERY");
    await expect(second).toBeEnabled();
    release();
    await expect.poll(() => cancelled).toContain(firstId);
    await expect(dialog).toBeVisible();
    await expect(query).toHaveValue("SEARCH_B_NATIVE_QUERY");
    await expect(second).toBeEnabled();
    const conversation = page.locator(".conversation");
    await expect(
      conversation.locator(`[data-history-entry="${secondId}"]`),
    ).toHaveCount(1);
    await second.click();
    await expect(dialog).toBeHidden();
    const target = conversation.locator(`[data-history-entry="${secondId}"]`);
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.errors).toEqual([]);
    await testInfo.attach("native-query-cancellation.json", {
      body: JSON.stringify({ firstId, secondId, cancelled, modelCalls: 0 }),
      contentType: "application/json",
    });
    await page.screenshot({
      path: testInfo.outputPath("native-search-current-result.png"),
    });
  } finally {
    release();
    await fixture.close();
  }
});
