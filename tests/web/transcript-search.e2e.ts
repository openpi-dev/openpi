import { expect, test } from "@playwright/test";
import { createAttachmentHost } from "./file-formats-e2e-support.ts";

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
    await page
      .getByRole("button", { name: "搜索消息内容", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "搜索消息内容" });
    const query = dialog.getByRole("searchbox", { name: "搜索消息内容" });
    await query.fill("SEARCH_A_NATIVE_QUERY");
    const first = dialog.getByRole("button", {
      name: "打开 Formats A 中来自你的消息",
      exact: true,
    });
    await expect(first).toContainText("SEARCH_A_NATIVE_QUERY");
    await first.click();
    await expect
      .poll(() => responseReady, {
        message: "The exact native A window was requested and held",
      })
      .toBe(true);
    await expect(first).toBeDisabled();
    await query.fill("SEARCH_B_NATIVE_QUERY");
    const second = dialog.getByRole("button", {
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
