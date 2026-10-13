import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  DEFAULT_SETUP_CONFIG,
  type ReasoningLevel,
} from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
  MOCK_SESSION_PATH,
} from "./thinking-e2e-support.ts";

async function configurationFixture(page: Page) {
  const preferences = { hiddenThinkingLevels: [] as ReasoningLevel[] };
  const thinking = await installThinkingFixture(page, {
    level: "high",
    preferences,
  });
  const setup = projectWebSetupConfig(DEFAULT_SETUP_CONFIG);
  const state = {
    setup,
    fail: false,
    writes: [] as unknown[],
    catalogReads: 0,
    responses: true,
  };
  await page.route("**/api/settings/catalog?**", (route) => {
    state.catalogReads++;
    return route.fulfill({
      json: {
        sessionId: MOCK_SESSION_ID,
        sessionPath: MOCK_SESSION_PATH,
        setup: {
          ...state.setup,
          ui: {
            ...state.setup.ui,
            webHiddenThinkingLevels: preferences.hiddenThinkingLevels,
          },
        },
        responseSupport: {
          verbosity: state.responses,
          reasoningSummary: state.responses,
        },
        thinking: {
          level: thinking.state.level,
          available: thinking.state.available,
          supported: true,
        },
        webSearch: { available: true, provider: "mock", model: "reasoner" },
        resources: {
          skills: [],
          plugins: [],
          totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
          diagnostics: { extensionErrors: 0, skillErrors: 0 },
          truncation: {
            truncated: false,
            skillsOmitted: 0,
            pluginsOmitted: 0,
            resourcesOmitted: 0,
          },
        },
      },
    });
  });
  await page.route("**/api/settings/preferences", async (route) => {
    const patch = route.request().postDataJSON();
    state.writes.push(patch);
    if (state.fail) {
      await route.fulfill({
        status: 500,
        json: { error: "Fixture persistence failure" },
      });
      return;
    }
    const { level, visible } = patch.thinkingLevelVisibility;
    preferences.hiddenThinkingLevels = visible
      ? preferences.hiddenThinkingLevels.filter((item) => item !== level)
      : [...preferences.hiddenThinkingLevels, level];
    state.setup = {
      ...state.setup,
      ui: {
        ...state.setup.ui,
        webHiddenThinkingLevels: preferences.hiddenThinkingLevels,
      },
    };
    await route.fulfill({ json: { saved: true, setup: state.setup } });
  });
  return { state, preferences, thinking };
}

async function openConfiguration(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  if (
    await dialog
      .getByRole("combobox", { name: "设置导航", exact: true })
      .isVisible()
  ) {
    await dialog
      .getByRole("combobox", { name: "设置导航", exact: true })
      .selectOption("configuration");
  } else {
    await dialog.getByRole("tab", { name: "配置", exact: true }).click();
  }
  await expect(dialog.getByText("用户配置", { exact: true })).toBeVisible();
  return dialog;
}

test("C12 editing the same model's API refreshes capabilities before returning to Configuration", async ({
  page,
}) => {
  const { state } = await configurationFixture(page);
  let api = "openai-responses";
  await page.route("**/api/models/configuration?**", (route) =>
    route.fulfill({
      json: {
        revision: `model-${api}`,
        models: [
          {
            provider: "mock",
            id: "reasoner",
            name: "Mock Reasoner",
            baseUrl: "http://localhost:12345/v1",
            api,
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    }),
  );
  await page.route("**/api/providers/auth-status?**", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "mock",
            name: "Mock",
            configured: true,
            authMethods: ["api_key"],
            subscription: false,
            nameTruncated: false,
            custom: true,
          },
        ],
        truncation: {
          truncated: false,
          providersOmitted: 0,
          namesTruncated: 0,
          maxProviders: 250,
        },
      },
    }),
  );
  let written: unknown;
  await page.route("**/api/providers/configuration", async (route) => {
    written = route.request().postDataJSON();
    api = "openai-completions";
    state.responses = false;
    await route.fulfill({ json: { saved: true } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openConfiguration(page);
  await expect(
    dialog.getByRole("button", { name: "输出详细程度", exact: true }),
  ).toBeEnabled();
  const initialReads = state.catalogReads;
  await dialog.getByRole("tab", { name: "模型", exact: true }).click();
  await dialog.getByRole("button", { name: "编辑 Mock", exact: true }).click();
  await dialog.getByText("自定义设置", { exact: true }).click();
  await dialog
    .getByRole("combobox", { name: "API 格式", exact: true })
    .selectOption("openai-completions");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.catalogReads).toBeGreaterThan(initialReads);
  expect(written).toMatchObject({
    change: {
      action: "save",
      configuration: {
        provider: "mock",
        models: [{ id: "reasoner", api: "openai-completions" }],
      },
    },
  });
  await dialog.getByRole("tab", { name: "配置", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "输出详细程度", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "推理摘要", exact: true }),
  ).toBeDisabled();
});

test("C02-C05 configuration menus keep hover, keyboard focus, escape and outside dismissal on desktop", async ({
  page,
}, testInfo) => {
  const { state } = await configurationFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openConfiguration(page);
  const verbosity = dialog.getByRole("button", {
    name: "输出详细程度",
    exact: true,
  });
  await verbosity.hover();
  await expect(verbosity).toBeEnabled();
  await verbosity.focus();
  await expect(verbosity).toBeFocused();
  await verbosity.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText([
    /^模型默认$/,
    /^简短/,
    /^适中/,
    /^详细/,
  ]);
  await page.screenshot({
    path: testInfo.outputPath("configuration-menu-light.png"),
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(verbosity).toBeFocused();
  const levels = dialog.getByRole("button", {
    name: "可用推理强度",
    exact: true,
  });
  await levels.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveText([
    "off",
    "low",
    "high",
    "max",
  ]);
  await expect(
    page.getByRole("menuitemcheckbox", { name: "max", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(0);
  await expect(levels).toBeFocused();
  await levels.click();
  await dialog.getByRole("heading", { name: "配置", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await dialog.screenshot({
    path: testInfo.outputPath("configuration-desktop-light.png"),
  });
  const accessibility = await new AxeBuilder({ page })
    .include(".provider-settings-dialog")
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("C03 configuration stays readable and keyboard reachable in dark and narrow layouts", async ({
  page,
}, testInfo) => {
  await configurationFixture(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openConfiguration(page);
  await dialog.screenshot({
    path: testInfo.outputPath("configuration-desktop-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("combobox", { name: "设置导航", exact: true }),
  ).toHaveValue("configuration");
  await dialog
    .getByRole("button", { name: "输出详细程度", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("configuration-mobile-dark.png"),
  });
  await dialog
    .getByRole("button", { name: "运行状态", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    dialog.getByRole("button", { name: "运行状态", exact: true }),
  ).toBeInViewport();
  await dialog.screenshot({
    path: testInfo.outputPath("configuration-mobile-dependencies.png"),
  });
  const summary = dialog.getByRole("button", {
    name: "推理摘要",
    exact: true,
  });
  await summary.focus();
  await summary.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "关闭", exact: false }),
  ).toBeVisible();
  const menu = await page.getByRole("menu").boundingBox();
  expect(menu).not.toBeNull();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
});

test("C06 admission and a delayed catalog refresh never imply response settings were saved", async ({
  page,
}) => {
  const { state } = await configurationFixture(page);
  const prompts: unknown[] = [];
  await page.route("**/api/prompt", async (route) => {
    prompts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { id: "configuration-admitted", accepted: true },
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await openConfiguration(page);
  const verbosity = dialog.getByRole("button", {
    name: "输出详细程度",
    exact: true,
  });
  await verbosity.click();
  await page.getByRole("menuitem", { name: "详细", exact: false }).click();
  await expect(
    dialog.getByText("配置请求已接收。", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => state.catalogReads).toBeGreaterThan(1);
  await expect(verbosity).toBeDisabled();
  await expect(verbosity).toContainText("模型默认");
  await expect(
    dialog.getByText("OpenPI 配置已保存并应用。", { exact: true }),
  ).toHaveCount(0);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    content:
      "/openpi-setup 只把 response_verbosity 设为 high，保留其他 OpenPI 配置。",
  });
});

test("C08-C09 failed display saves retain canonical checks; retry and refresh preserve native order and current effort", async ({
  page,
}, testInfo) => {
  const { state, thinking } = await configurationFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  let dialog = await openConfiguration(page);
  await dialog
    .getByRole("button", { name: "可用推理强度", exact: true })
    .click();
  state.fail = true;
  const max = page.getByRole("menuitemcheckbox", { name: "max", exact: true });
  await max.click();
  await expect(
    dialog.getByText("无法保存显示设置，请检查配置诊断后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(max).toBeChecked();
  state.fail = false;
  await max.click();
  await expect(max).not.toBeChecked();
  // Hiding the actual level is a presentation preference; its native value remains visible.
  await page
    .getByRole("menuitemcheckbox", { name: "high", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "high", exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("button", { name: "可用推理强度", exact: true }),
  ).toContainText("已选择 2 个");
  expect(thinking.posts).toEqual([]);
  await page.reload();
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("tab", { name: "配置", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\?settings=configuration$/);
  await dialog
    .getByRole("button", { name: "可用推理强度", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "max", exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".model-picker button[aria-haspopup]").click();
  await expect(page.getByRole("slider", { name: "思考等级" })).toHaveAttribute(
    "max",
    "2",
  );
  await expect(page.getByRole("slider", { name: "思考等级" })).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  await page.screenshot({
    path: testInfo.outputPath("configuration-filter-restored.png"),
  });
  expect(thinking.posts).toEqual([]);
  expect(thinking.state.available).toEqual(["off", "low", "high", "max"]);
});
