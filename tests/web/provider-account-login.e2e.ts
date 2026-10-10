import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { WebProviderLogin } from "../../web/protocol/provider-login.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
} from "./thinking-e2e-support.ts";

// Only browser projections are mocked. Native persistence, cancellation and
// exact-owner checks have separate Host and real Pi ModelRuntime tests.
async function accountFixture(page: Page) {
  await installThinkingFixture(page);
  let flow: WebProviderLogin | null = null;
  let configured = false;
  let offline = false;
  let starts = 0;
  let logouts = 0;
  let writes = 0;
  const responses: { promptId: string; value: string }[] = [];
  const base = () => ({
    id: `flow-${starts}`,
    sessionId: MOCK_SESSION_ID,
    provider: "openai",
    status: "running" as const,
    expiresAt: Date.now() + 60_000,
    messages: [],
  });
  await page.route("**/api/providers/auth-status**", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            authMethods: ["api_key", "oauth"],
            configured,
            subscription: configured,
            nameTruncated: false,
          },
          {
            id: "anthropic",
            name: "Anthropic",
            authMethods: ["api_key", "oauth"],
            configured: false,
            subscription: false,
            nameTruncated: false,
          },
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            authMethods: ["oauth"],
            configured: false,
            subscription: false,
            nameTruncated: false,
          },
          {
            id: "mock",
            name: "Mock",
            authMethods: ["api_key"],
            configured: true,
            subscription: false,
            nameTruncated: false,
          },
        ],
        truncation: {
          truncated: false,
          providersOmitted: 0,
          namesTruncated: 0,
          maxProviders: 256,
        },
      },
    }),
  );
  await page.route("**/api/models/configuration**", (route) =>
    route.fulfill({
      json: { revision: "account-fixture", providers: [], models: [] },
    }),
  );
  for (const path of ["api-key", "configuration"])
    await page.route(`**/api/providers/${path}`, (route) => {
      writes++;
      return route.fulfill({ json: { saved: true } });
    });
  await page.route("**/api/providers/login**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      expect(url.searchParams.get("sessionId")).toBe(MOCK_SESSION_ID);
      if (url.searchParams.has("id"))
        expect(url.searchParams.get("id")).toBe(flow?.id);
      if (offline)
        return route.fulfill({ status: 503, json: { error: "offline" } });
    } else {
      const body = request.postDataJSON();
      expect(body.sessionId).toBe(MOCK_SESSION_ID);
      if (url.pathname.endsWith("/respond")) {
        expect(body.id).toBe(flow?.id);
        expect(body.promptId).toBe(flow?.prompt?.id);
        responses.push({ promptId: body.promptId, value: body.value });
        if (body.value === "browser")
          flow = {
            ...base(),
            auth: {
              url: "https://accounts.example/authorize?state=fixture-state",
            },
            prompt: { id: "manual", type: "manual_code", message: "Callback" },
          };
        else if (body.value === "device_code")
          flow = {
            ...base(),
            device: {
              code: "ABCD-1234",
              url: "https://accounts.example/device",
            },
          };
        else {
          configured = true;
          flow = { ...base(), status: "succeeded" };
        }
      } else if (url.pathname.endsWith("/cancel")) {
        expect(body.id).toBe(flow?.id);
        flow = { ...base(), status: "cancelled" };
      } else {
        expect(body.provider).toBe("openai");
        starts++;
        flow = {
          ...base(),
          prompt: {
            id: "choose",
            type: "select",
            message: "Choose how to sign in",
            options: [
              { id: "browser", label: "Browser login (default)" },
              { id: "device_code", label: "Device code login (headless)" },
            ],
          },
        };
      }
    }
    await route.fulfill({ json: flow });
  });
  await page.route("**/api/providers/logout", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      sessionId: MOCK_SESSION_ID,
      provider: "openai",
    });
    logouts++;
    configured = false;
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mock session", exact: true }),
  ).toBeVisible();
  if (
    !(await page.getByRole("button", { name: "设置", exact: true }).isVisible())
  )
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const navigation = page.getByRole("combobox", {
    name: "设置导航",
    exact: true,
  });
  if (await navigation.isVisible()) await navigation.selectOption("models");
  else await page.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑 OpenAI", exact: true }),
  ).toBeVisible();
  return {
    responses,
    get starts() {
      return starts;
    },
    get logouts() {
      return logouts;
    },
    get writes() {
      return writes;
    },
    setOffline(value: boolean) {
      offline = value;
    },
  };
}

test("account login stays in the provider card, recovers status and uses confirmed native logout", async ({
  page,
}) => {
  const fixture = await accountFixture(page);
  await expect(
    page.getByRole("button", { name: "编辑 GitHub Copilot", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "编辑 OpenAI", exact: true }).click();
  const card = page.locator(".models-provider-card").filter({
    has: page.getByRole("button", { name: "编辑 OpenAI", exact: true }),
  });
  await expect(card.getByText("ChatGPT 账户", { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "登录", exact: true }).click();
  await card.getByRole("button", { name: /在浏览器中继续/ }).click();
  const link = card.getByRole("link", { name: "打开登录页", exact: true });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(card).not.toContainText("fixture-state");
  await expect(card.getByLabel("授权码或回调地址")).toBeHidden();
  fixture.setOffline(true);
  await expect(card.getByRole("alert")).toContainText("暂时无法查询登录状态");
  fixture.setOffline(false);
  await card.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await card.getByText("已登录，但这里没有更新？", { exact: true }).click();
  const input = card.getByLabel("授权码或回调地址");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("fixture-only-code");
  await card.getByRole("button", { name: "继续", exact: true }).click();
  await expect(card).toContainText("账户已登录");
  expect(fixture.responses).toEqual([
    { promptId: "choose", value: "browser" },
    { promptId: "manual", value: "fixture-only-code" },
  ]);
  expect(fixture.writes).toBe(0);
  await page.getByRole("button", { name: "编辑 OpenAI", exact: true }).click();
  await card.getByRole("button", { name: "退出登录", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  expect(fixture.logouts).toBe(0);
  await confirmation
    .getByRole("button", { name: "退出登录", exact: true })
    .click();
  await expect(card).toContainText("未配置");
  expect(fixture.logouts).toBe(1);
});

test("account login device flow stays readable at 320px in light and dark themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const fixture = await accountFixture(page);
  await page.getByRole("button", { name: "编辑 OpenAI", exact: true }).click();
  const card = page.locator(".models-provider-card").filter({
    has: page.getByRole("button", { name: "编辑 OpenAI", exact: true }),
  });
  await card.getByRole("button", { name: "登录", exact: true }).click();
  await card.getByRole("button", { name: /使用设备码登录/ }).click();
  await expect(card.getByText("ABCD-1234", { exact: true })).toBeVisible();
  await expect(
    card.getByText("已登录，但这里没有更新？", { exact: true }),
  ).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      card: document
        .querySelector(".models-login-flow")!
        .getBoundingClientRect().width,
    }));
    expect(overflow.page).toBe(overflow.viewport);
    expect(overflow.card).toBeLessThan(320);
    await card.getByRole("button", { name: "取消登录", exact: true }).focus();
    await expect(
      card.getByRole("button", { name: "取消登录", exact: true }),
    ).toBeFocused();
    const result = await new AxeBuilder({ page })
      .include(".provider-settings-dialog")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(result.violations).toEqual([]);
  }
  await card.getByRole("button", { name: "取消登录", exact: true }).click();
  await expect(card).toContainText("已取消登录。");
  expect(fixture.starts).toBe(1);
  expect(fixture.writes).toBe(0);
});
