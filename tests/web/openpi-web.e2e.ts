import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authenticatedPath = `/#token=${token}`;

async function openWorkbench(page: Page) {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      url.origin !== "http://127.0.0.1:57109"
    ) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(authenticatedPath, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "描述任务" })).toBeVisible();
  return externalRequests;
}

test("production workbench is local, keyboard-operable, and accessible", async ({
  page,
}) => {
  const externalRequests = await openWorkbench(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "OpenPI" }),
  ).toBeAttached();
  await expect(page.locator('script[src*="@vite/client"]')).toHaveCount(0);
  await expect.poll(() => externalRequests).toEqual([]);

  const logo = page.getByRole("button", {
    name: "Replay OpenPI logo animation",
  });
  await logo.click();
  await expect
    .poll(
      () =>
        logo
          .locator(".pixel-mark i")
          .first()
          .evaluate((node) => getComputedStyle(node).opacity),
      { timeout: 1_500 },
    )
    .not.toBe("0");

  const workspaceMenu = page.getByRole("button", {
    name: "Workspace options",
  });
  await workspaceMenu.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Workspace options" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const width = await page.evaluate(() => ({
    client: document.body.clientWidth,
    scroll: document.body.scrollWidth,
  }));
  expect(width.scroll).toBe(width.client);

  const turnRailLayout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".conversation-shell");
    const conversation = document.querySelector<HTMLElement>(".conversation");
    if (!shell || !conversation)
      throw new Error("conversation shell is missing");
    const message = document.createElement("article");
    message.className = "message-row assistant";
    message.textContent = "Layout probe";
    const rail = document.createElement("nav");
    rail.className = "turn-rail";
    conversation.append(message);
    shell.append(rail);
    const messageRect = message.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    message.remove();
    rail.remove();
    return {
      gutter: shellRect.right - railRect.right,
      messageRight: messageRect.right,
      railLeft: railRect.left,
    };
  });
  expect(turnRailLayout.gutter).toBeCloseTo(24, 0);
  expect(turnRailLayout.railLeft).toBeGreaterThanOrEqual(
    turnRailLayout.messageRight,
  );
});

test.describe("touch viewport", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("keeps navigation and dialogs inside the mobile viewport", async ({
    page,
  }) => {
    await openWorkbench(page);
    await page.getByRole("button", { name: "打开侧边栏" }).click();

    const sidebar = page.locator(".session-sidebar");
    await expect(sidebar).toHaveCSS("backdrop-filter", "none");
    await expect
      .poll(async () => (await sidebar.boundingBox())?.x, { timeout: 1_500 })
      .toBe(0);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox?.width).toBeLessThanOrEqual(300);

    const sessionMenu = sidebar
      .getByRole("button", { name: "会话选项" })
      .first();
    await expect(sessionMenu).toBeVisible();
    await sessionMenu.click();
    await expect(page.getByRole("menu", { name: "会话选项" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("menuitem", { name: "重命名工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "取消" }).click();

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    const width = await page.evaluate(() => ({
      client: document.body.clientWidth,
      scroll: document.body.scrollWidth,
    }));
    expect(width.scroll).toBe(width.client);
  });
});

test.describe("reduced motion", () => {
  test.use({
    contextOptions: { locale: "zh-CN", reducedMotion: "reduce" },
  });

  test("renders the logo in its final static state", async ({ page }) => {
    await openWorkbench(page);
    const logo = page.getByRole("button", {
      name: "Replay OpenPI logo animation",
    });
    const state = await logo.evaluate((element) => {
      const word = element.querySelector<HTMLElement>(".brand-word");
      const pixel = element.querySelector<HTMLElement>(".pixel-mark i");
      return {
        pixelAnimation: pixel ? getComputedStyle(pixel).animationName : "",
        wordAnimation: word ? getComputedStyle(word).animationName : "",
        wordOpacity: word ? getComputedStyle(word).opacity : "",
      };
    });
    expect(state).toEqual({
      pixelAnimation: "none",
      wordAnimation: "none",
      wordOpacity: "1",
    });
  });
});
