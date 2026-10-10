import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
  MOCK_SESSION_PATH,
} from "./thinking-e2e-support.ts";

async function connectionsFixture(page: Page) {
  const models = ["openai", "anthropic"].map((provider) => ({
    provider,
    id: "shared-model",
    name: "Shared model",
    label: "Shared model",
    current: provider === "openai",
  }));
  await installThinkingFixture(page, { models });
  let defaultModel: { provider: string; id: string } | null = null;
  const writes: string[] = [];
  await page.route("**/api/providers/auth-status**", (route) =>
    route.fulfill({
      json: {
        providers: models.map((model) => ({
          id: model.provider,
          name: model.provider === "openai" ? "OpenAI" : "Anthropic",
          authMethods: ["oauth", "api_key"],
          configured: true,
          subscription: true,
          nameTruncated: false,
        })),
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
    route.fulfill({ json: { revision: "fixture", providers: [], models: [] } }),
  );
  await page.route("**/api/models?**", (route) => {
    const url = new URL(route.request().url());
    const provider = url.searchParams.get("provider");
    return route.fulfill({
      json: projectWebModelSearch(
        models.filter((model) => !provider || provider === model.provider),
        url.searchParams.get("query") ?? "",
      ),
    });
  });
  await page.route("**/api/models/default**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.sessionId).toBe(MOCK_SESSION_ID);
      expect(body.sessionPath).toBe(MOCK_SESSION_PATH);
      defaultModel = { provider: body.provider, id: body.modelId };
      writes.push(`default:${body.provider}`);
    }
    return route.fulfill({ json: { model: defaultModel } });
  });
  await page.route("**/api/model", (route) => {
    const body = route.request().postDataJSON();
    expect(body.sessionId).toBe(MOCK_SESSION_ID);
    expect(body.sessionPath).toBe(MOCK_SESSION_PATH);
    for (const model of models)
      model.current =
        model.provider === body.provider && model.id === body.modelId;
    writes.push(`current:${body.provider}`);
    return route.fulfill({ json: models.find((model) => model.current) });
  });
  await page.goto(`/#token=${process.env.OPENPI_WEB_E2E_TOKEN}`);
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
    page.getByText("未设置 · 新会话启动时由 Pi 选择", { exact: true }),
  ).toBeVisible();
  return { writes, models };
}

test("multiple connections keep current selection separate from the native future default", async ({
  page,
}) => {
  const { writes, models } = await connectionsFixture(page);
  await page
    .locator(".models-default-card")
    .getByRole("button", { name: "选择模型", exact: true })
    .click();
  await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect(page.locator(".models-default-value")).toContainText("OpenAI");
  expect(writes).toEqual(["default:openai"]);
  expect(models.find((model) => model.current)?.provider).toBe("openai");
  await page
    .getByRole("button", { name: "选择 Anthropic 的模型", exact: true })
    .click();
  await page.getByRole("button", { name: "用于当前会话", exact: true }).click();
  await expect(page.locator(".models-connection-choice")).toHaveCount(0);
  await expect(page.locator(".models-default-value")).toContainText("OpenAI");
  expect(writes).toEqual(["default:openai", "current:anthropic"]);
  expect(models.find((model) => model.current)?.provider).toBe("anthropic");
  await page
    .getByRole("button", { name: "选择 Anthropic 的模型", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "同时设为新会话默认模型", exact: true })
    .check();
  await page.getByRole("button", { name: "用于当前会话", exact: true }).click();
  await expect(page.locator(".models-default-value")).toContainText(
    "Anthropic",
  );
  expect(writes).toEqual([
    "default:openai",
    "current:anthropic",
    "current:anthropic",
    "default:anthropic",
  ]);
});

test("model connections and colored marks remain readable at 320px in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await connectionsFixture(page);
  await page
    .getByRole("button", { name: "选择 Anthropic 的模型", exact: true })
    .click();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(
      page.getByRole("combobox", { name: "选择模型", exact: true }),
    ).toBeVisible();
    const bounds = await page.locator(".models-section").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(
      await page
        .locator(".models-section")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .include(".models-page")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  }
});
