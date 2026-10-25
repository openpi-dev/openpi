import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { DEFAULT_SETUP_CONFIG } from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
  MOCK_SESSION_PATH,
} from "./thinking-e2e-support.ts";

test("settings pages align with the Browser layout across desktop, window and mobile sizes", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await installThinkingFixture(page);
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({
      json: {
        sessionId: MOCK_SESSION_ID,
        sessionPath: MOCK_SESSION_PATH,
        setup: projectWebSetupConfig(DEFAULT_SETUP_CONFIG),
        webSearch: { available: true, provider: "fixture", model: "current" },
        resources: {
          skills: [
            {
              id: "fixture-review",
              name: "review",
              description: "Review native resources.",
              filePath: "/fixture/skills/review/SKILL.md",
              source: "auto",
              scope: "user",
              origin: "top-level",
              disableModelInvocation: false,
            },
          ],
          plugins: [
            {
              id: "fixture-plugin",
              name: "Review tools",
              source: "/fixture/review-tools",
              scope: "user",
              origin: "package",
              configured: true,
              enabled: true,
              installed: true,
              installedVersion: "1.2.3",
              baseDir: "/fixture/review-tools",
              extensions: [],
              skills: [],
              prompts: [],
              themes: [],
            },
          ],
          totals: { extensions: 0, skills: 1, prompts: 0, themes: 0 },
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
  await page.route("**/api/settings/browser", (route) =>
    route.fulfill({
      json: {
        config: {
          control: false,
          embedded: true,
          defaultBrowser: "embedded",
          externalBrowsers: [],
        },
        profiles: [],
        browsers: [{ id: "chrome", installed: true }],
        extensionPath: "/fixture/browser-extension",
        extensionVersion: "0.4.0",
      },
    }),
  );
  await page.route("**/api/models/configuration?**", (route) =>
    route.fulfill({ json: { revision: "layout-fixture", models: [] } }),
  );
  await page.route("**/api/providers/auth-status?**", (route) =>
    route.fulfill({
      json: {
        providers: [],
        truncation: {
          truncated: false,
          providersOmitted: 0,
          namesTruncated: 0,
          maxProviders: 250,
        },
      },
    }),
  );
  await page.goto("/?settings=browser");
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const sections = [
    ["browser", "浏览器"],
    ["general", "常规"],
    ["appearance", "外观"],
    ["archived-chats", "已归档聊天"],
    ["configuration", "配置"],
    ["models", "模型"],
    ["subagents", "子代理"],
    ["web-search", "联网搜索"],
    ["skills", "技能"],
    ["plugins", "插件"],
  ] as const;
  for (const [width, height] of [
    [1440, 1000],
    [890, 792],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    let reference: { x: number; y: number; font: string } | undefined;
    for (const [section, label] of sections) {
      if (width <= 700)
        await dialog
          .getByRole("combobox", { name: "设置导航", exact: true })
          .selectOption(section);
      else await dialog.getByRole("tab", { name: label, exact: true }).click();
      const panel = dialog.getByRole("tabpanel", { name: label, exact: true });
      await panel.evaluate((element) => {
        element.scrollTop = 0;
        const content = element.querySelector(".settings-content-page");
        if (content) content.scrollTop = 0;
      });
      if (section === "general") {
        const inset = await panel
          .getByRole("switch", { name: "下一步建议", exact: true })
          .evaluate((element) => {
            const group = element.closest(".settings-chat-controls")!;
            const row = Array.from(group.children).find((child) =>
              child.contains(element),
            )!;
            const rowStyle = getComputedStyle(row);
            return Math.min(
              parseFloat(rowStyle.paddingLeft),
              parseFloat(rowStyle.paddingRight),
            );
          });
        expect(
          inset,
          `suggestion control inset at ${width}`,
        ).toBeGreaterThanOrEqual(16);
      }
      const heading = panel.getByRole("heading", {
        name: label,
        exact: true,
        level: 1,
      });
      await expect(heading).toBeVisible();
      const box = await heading.boundingBox();
      expect(box).not.toBeNull();
      const font = await heading.evaluate(
        (element) => getComputedStyle(element).fontSize,
      );
      if (!reference) reference = { x: box!.x, y: box!.y, font };
      expect
        .soft(Math.abs(box!.x - reference.x), `${label} left at ${width}`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(Math.abs(box!.y - reference.y), `${label} top at ${width}`)
        .toBeLessThanOrEqual(1);
      expect.soft(font, `${label} heading at ${width}`).toBe(reference.font);
      expect
        .soft(
          await panel.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
          `${label} overflow at ${width}`,
        )
        .toBe(true);
      if (width === 1440)
        expect
          .soft(
            (await new AxeBuilder({ page }).analyze()).violations,
            `${label} accessibility`,
          )
          .toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${section}-${width}.png`),
        fullPage: true,
      });
    }
  }
});

test("native web search follows the current Session model with an on/off preference on desktop and mobile", async ({
  page,
}, testInfo) => {
  await installThinkingFixture(page);
  let enabled = false;
  let available = true;
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({
      json: {
        sessionId: MOCK_SESSION_ID,
        sessionPath: MOCK_SESSION_PATH,
        setup: projectWebSetupConfig({
          ...DEFAULT_SETUP_CONFIG,
          webSearch: { enabled, modelSupport: [] },
        }),
        webSearch: { available, provider: "fixture", model: "current" },
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("tab", { name: "联网搜索", exact: true }).click();
  await expect(
    dialog.getByText("fixture / current", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "启用联网搜索…", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByText("当前连接支持原生搜索。开启后，由模型决定何时联网。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByText("Exa", { exact: true })).toHaveCount(0);
  await dialog.screenshot({
    path: testInfo.outputPath("native-search-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("combobox", { name: "设置导航", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "启用联网搜索…", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("native-search-mobile.png"),
  });
  enabled = true;
  available = false;
  await dialog.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "关闭联网搜索…", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "当前连接不支持或尚未确认支持原生搜索，不提供搜索工具，也不会切换到其他供应商。",
      { exact: true },
    ),
  ).toBeVisible();
});

test("resource settings preserve drafts, distinguish disabled and loaded state, and review reload on desktop and mobile", async ({
  page,
}, testInfo) => {
  await installThinkingFixture(page);
  const source = "/fixture/pi-plugin";
  const resources = {
    skills: [
      {
        id: "fixture-review",
        name: "review",
        description: "Review native resources.",
        filePath: "/fixture/skills/review/SKILL.md",
        source: "auto",
        scope: "user",
        origin: "top-level",
        disableModelInvocation: false,
      },
    ],
    plugins: [
      {
        id: "user:package:fixture",
        source,
        scope: "user",
        origin: "package",
        configured: true,
        enabled: false,
        installed: true,
        installedVersion: "1.2.3",
        baseDir: source,
        extensions: [
          {
            name: "inspect",
            path: `${source}/index.ts`,
            toolCount: 1,
            commandCount: 0,
          },
        ],
        skills: [],
        prompts: [],
        themes: [],
      },
    ],
    totals: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
    diagnostics: { extensionErrors: 0, skillErrors: 0 },
    truncation: {
      truncated: false,
      skillsOmitted: 0,
      pluginsOmitted: 0,
      resourcesOmitted: 0,
    },
  };
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({
      json: {
        sessionId: MOCK_SESSION_ID,
        sessionPath: MOCK_SESSION_PATH,
        setup: projectWebSetupConfig(DEFAULT_SETUP_CONFIG),
        resources,
      },
    }),
  );
  const reloads: unknown[] = [];
  await page.route("**/api/settings/reload", async (route) => {
    reloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: "Fixture Session is busy" },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("tab", { name: "插件", exact: true }).click();
  await expect(dialog.getByText("配置已禁用", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1.2.3", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(
      "当前会话目录包含 1 项资源。配置变更需要明确重新加载后才会应用。",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath("resource-plugins-desktop.png"),
  });
  await dialog
    .getByRole("button", { name: "重新加载资源", exact: true })
    .click();
  const review = page.getByRole("alertdialog");
  await expect(review).toBeVisible();
  expect(reloads).toEqual([]);
  await review
    .getByRole("button", { name: "重新加载资源", exact: true })
    .click();
  await expect(
    dialog.getByText("Fixture Session is busy", { exact: true }),
  ).toBeVisible();
  expect(reloads).toEqual([
    { sessionId: MOCK_SESSION_ID, sessionPath: MOCK_SESSION_PATH },
  ]);
  await dialog.getByRole("tab", { name: "技能", exact: true }).click();
  await dialog.getByRole("button", { name: "添加技能", exact: true }).click();
  await dialog
    .getByLabel("软件包、仓库或本地路径", { exact: true })
    .fill("git:fixture/review");
  const scopeMenu = await dialog
    .getByRole("button", { name: "范围", exact: true })
    .getAttribute("aria-controls");
  await dialog.getByRole("button", { name: "范围", exact: true }).click();
  await page
    .locator(`#${scopeMenu}`)
    .getByRole("menuitemradio", { name: "项目", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "插件", exact: true }).click();
  await dialog.getByRole("tab", { name: "技能", exact: true }).click();
  await expect(
    dialog.getByLabel("软件包、仓库或本地路径", { exact: true }),
  ).toHaveValue("git:fixture/review");
  await expect(
    dialog.getByRole("button", { name: "范围", exact: true }),
  ).toHaveText("项目");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("combobox", { name: "设置导航", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("软件包、仓库或本地路径", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("resource-skills-mobile.png"),
  });
});

test("General result and footer controls save, restore after reload, and preserve values on rejection", async ({
  page,
}, testInfo) => {
  await installThinkingFixture(page);
  const setup = projectWebSetupConfig(DEFAULT_SETUP_CONFIG);
  const resources = {
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
  };
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({ json: { sessionId: MOCK_SESSION_ID, setup, resources } }),
  );
  let reject = false;
  const patches: unknown[] = [];
  await page.route("**/api/settings/preferences", async (route) => {
    const patch = route.request().postDataJSON();
    patches.push(patch);
    if (reject)
      return route.fulfill({
        status: 422,
        json: { error: "configuration is read-only" },
      });
    Object.assign(setup.ui, patch);
    return route.fulfill({ json: { saved: true, setup } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  for (const label of ["子代理结果", "Bash 操作", "Write / Edit 操作"]) {
    const control = dialog.getByRole("button", { name: label, exact: true });
    const menuId = await control.getAttribute("aria-controls");
    await control.click();
    await page
      .locator(`#${menuId}`)
      .getByRole("menuitemradio", { name: "完整", exact: true })
      .click();
    await expect(control).toBeEnabled();
    await expect(control).toHaveText("完整");
  }
  const footerStyle = dialog.getByRole("button", {
    name: "终端页脚样式",
    exact: true,
  });
  const footerMenu = await footerStyle.getAttribute("aria-controls");
  await footerStyle.click();
  await page
    .locator(`#${footerMenu}`)
    .getByRole("menuitemradio", { name: "Powerline Mono", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "终端页脚样式", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("switch", { name: "Pi 终端页脚", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "终端页脚样式", exact: true }),
  ).toBeDisabled();
  await dialog
    .locator(".settings-general-panel")
    .screenshot({ path: testInfo.outputPath("settings-editable-desktop.png") });
  await page.reload();
  await expect(
    dialog.getByRole("button", { name: "Bash 操作", exact: true }),
  ).toHaveText("完整");
  reject = true;
  const bash = dialog.getByRole("button", {
    name: "Bash 操作",
    exact: true,
  });
  const bashMenu = await bash.getAttribute("aria-controls");
  await bash.click();
  await page
    .locator(`#${bashMenu}`)
    .getByRole("menuitemradio", { name: "紧凑", exact: true })
    .click();
  await expect(
    dialog.getByText("无法保存显示设置，请检查配置诊断后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Bash 操作", exact: true }),
  ).toHaveText("完整");
  expect(patches).toEqual([
    { subagentResultDisplay: "full" },
    { bashToolDisplay: "full" },
    { fileMutationDisplay: "full" },
    { footerStyle: "powerline-mono" },
    { customFooter: false },
    { bashToolDisplay: "compact" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .locator(".settings-general-panel")
    .screenshot({ path: testInfo.outputPath("settings-editable-mobile.png") });
});

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
  await dialog.getByRole("tab", { name: "外观", exact: true }).click();
  await dialog.getByRole("button", { name: "高级", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "恢复默认聊天宽度" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "恢复默认字体大小" }),
  ).toBeDisabled();
  expect(
    await dialog
      .locator(".appearance-advanced-content")
      .evaluate((element) => element.clientWidth),
  ).toBeLessThanOrEqual(768);
  const dark = dialog.getByRole("radio", { name: "深色", exact: true });
  await page.keyboard.press("Shift");
  await dark.focus();
  await expect(dark.locator("+ .appearance-mode-preview")).toHaveCSS(
    "outline-style",
    "solid",
  );
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
