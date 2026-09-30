import { expect, test } from "@playwright/test";
import { DEFAULT_SETUP_CONFIG } from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
} from "./thinking-e2e-support.ts";

test("model provider cards preserve drafts, stage discovery and keep the existing settings shell", async ({
  page,
}, testInfo) => {
  await installThinkingFixture(page);
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({
      json: {
        sessionId: MOCK_SESSION_ID,
        setup: projectWebSetupConfig(DEFAULT_SETUP_CONFIG),
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
    }),
  );
  let configurationReads = 0;
  await page.route("**/api/models/configuration?**", (route) => {
    configurationReads++;
    return route.fulfill({
      json: {
        revision: "settings-parity",
        models: [
          {
            provider: "mock",
            id: "reasoner",
            name: "Mock Reasoner",
            baseUrl: "http://localhost:12345/v1",
            api: "openai-responses",
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    });
  });
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
          {
            id: "extra",
            name: "Extra provider",
            configured: false,
            authMethods: ["api_key"],
            subscription: false,
            nameTruncated: false,
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "常规", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "恢复默认聊天宽度" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "恢复默认字体大小" }),
  ).toBeDisabled();
  expect(
    await dialog
      .locator(".settings-chat-controls")
      .evaluate((element) => element.clientWidth),
  ).toBeLessThanOrEqual(420);
  const dark = dialog.getByRole("radio", { name: "深色", exact: true });
  await page.keyboard.press("Shift");
  await dark.focus();
  await expect(dark.locator("..")).toHaveCSS("outline-style", "solid");
  await page.screenshot({
    path: testInfo.outputPath("settings-general-desktop.png"),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const picker = dialog.getByRole("combobox", { name: "设置导航" });
  await expect(picker).toBeVisible();
  await expect(dialog.getByRole("tablist")).toBeHidden();
  await picker.selectOption("models");
  await expect(
    dialog.getByRole("button", { name: "编辑 Mock", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("models-list-mobile.png"),
  });
  await dialog.getByRole("button", { name: "编辑 Mock", exact: true }).click();
  await dialog.getByText("自定义设置", { exact: true }).click();
  const name = dialog.getByRole("textbox", {
    name: "模型 1 名称",
    exact: true,
  });
  await expect(name).toHaveValue("Mock Reasoner");
  await name.fill("Unfinished reasoner");
  await picker.selectOption("general");
  await picker.selectOption("models");
  await expect(name).toHaveValue("Unfinished reasoner");
  expect(configurationReads).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("models-edit-mobile.png"),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("models-edit-desktop.png"),
  });
  await dialog
    .getByRole("button", { name: "添加模型提供商", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "第三方模型提供商" }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByLabel("API 密钥", { exact: true })
    .filter({ visible: true })
    .fill("fixture-unsaved-key");
  await page.screenshot({
    path: testInfo.outputPath("models-add-catalog-desktop.png"),
  });
  await dialog.getByRole("button", { name: "自定义模型 API" }).click();
  await dialog.getByLabel("服务商 ID", { exact: true }).fill("gateway");
  await dialog
    .getByLabel("提供商名称", { exact: true })
    .filter({ visible: true })
    .fill("Local gateway");
  await dialog
    .getByLabel("API 地址", { exact: true })
    .filter({ visible: true })
    .fill("http://127.0.0.1:12345/v1");
  await dialog.getByRole("button", { name: "第三方模型提供商" }).click();
  await expect(
    dialog.getByLabel("API 密钥", { exact: true }).filter({ visible: true }),
  ).toHaveValue("fixture-unsaved-key");
  await dialog.getByRole("button", { name: "自定义模型 API" }).click();
  await expect(
    dialog.getByLabel("提供商名称", { exact: true }).filter({ visible: true }),
  ).toHaveValue("Local gateway");
  let writes = 0;
  await page.route("**/api/providers/configuration", (route) => {
    writes++;
    return route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/models/discover", (route) =>
    route.fulfill({
      json: {
        models: [
          { id: "design-model", name: "Design model" },
          { id: "fast-model", name: "Fast model" },
          { id: "long-context", name: "Long context" },
        ],
        truncated: false,
      },
    }),
  );
  await dialog.getByRole("button", { name: "获取可用模型" }).click();
  const modelPicker = page.getByRole("dialog", { name: "选择要添加的模型" });
  await expect(modelPicker.getByRole("searchbox")).toBeFocused();
  await expect(
    modelPicker.getByRole("checkbox", { name: "design-model" }),
  ).toBeChecked();
  await expect(modelPicker.getByText("已选 3 个")).toBeVisible();
  await modelPicker.getByRole("checkbox", { name: "long-context" }).uncheck();
  await modelPicker.getByRole("searchbox").fill("fast");
  await modelPicker.getByRole("searchbox").press("Enter");
  expect(writes).toBe(0);
  await expect(modelPicker).toBeVisible();
  await expect(
    modelPicker.getByRole("checkbox", { name: "fast-model" }),
  ).toBeChecked();
  await expect(modelPicker.getByText("已选 2 个")).toBeVisible();
  await modelPicker.getByRole("searchbox").fill("");
  await page.screenshot({
    path: testInfo.outputPath("models-picker-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("models-picker-mobile.png"),
  });
  await modelPicker.getByRole("button", { name: "添加所选" }).click();
  await expect(modelPicker).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "获取可用模型" }),
  ).toBeFocused();
  await expect(
    dialog
      .getByRole("textbox", { name: "模型 2 名称", exact: true })
      .filter({ visible: true }),
  ).toHaveValue("Fast model");
  expect(writes).toBe(0);
  await dialog.getByRole("button", { name: "模型参数：Design model" }).click();
  const context = dialog.getByRole("textbox", {
    name: "上下文窗口 1",
    exact: true,
  });
  await expect(context).toHaveValue("");
  await expect(context).toHaveAttribute("placeholder", "256K");
  const output = dialog.getByRole("textbox", {
    name: "最大输出 token 数 1",
    exact: true,
  });
  await expect(output).toHaveValue("");
  await expect(output).toHaveAttribute("placeholder", "32K");
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog
    .locator(".models-entry")
    .filter({
      has: page.getByRole("textbox", { name: "上下文窗口 1", exact: true }),
    })
    .screenshot({
      path: testInfo.outputPath("models-capacity-placeholders.png"),
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await context.fill("128K");
  await dialog
    .getByRole("textbox", { name: "最大输出 token 数 1", exact: true })
    .fill("32K");
  await dialog.getByRole("checkbox", { name: "支持推理" }).check();
  await expect(
    dialog.getByRole("checkbox", { name: "文本", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "图片", exact: true }).check();
  await expect(
    dialog.getByRole("checkbox", { name: "文本", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "保存", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("models-add-custom-mobile.png"),
  });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath("models-add-custom-desktop.png"),
  });
  await dialog
    .locator(".models-entry")
    .filter({
      has: page.getByRole("textbox", { name: "上下文窗口 1", exact: true }),
    })
    .screenshot({
      path: testInfo.outputPath("models-capacity-details-desktop.png"),
    });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: testInfo.outputPath("models-add-custom-dark.png"),
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(writes).toBe(0);
  await dialog.getByRole("button", { name: "编辑 Mock", exact: true }).click();
  await expect(name).toHaveValue("Unfinished reasoner");
});
