import { expect, test } from "@playwright/test";
import { DEFAULT_SETUP_CONFIG } from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
} from "./thinking-e2e-support.ts";

test("settings keep labeled mobile navigation and edit the selected model without losing drafts", async ({
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
  const name = dialog.getByRole("textbox", { name: "显示名称", exact: true });
  await expect(name).toHaveValue("Mock Reasoner");
  await name.fill("Unfinished reasoner");
  const add = dialog.locator(".settings-model-provider-link");
  await add.click();
  await expect(name).toHaveValue("");
  await name.fill("Unfinished new model");
  await dialog.getByRole("button", { name: /Mock Reasoner/ }).click();
  await expect(name).toHaveValue("Unfinished reasoner");
  await add.click();
  await expect(name).toHaveValue("Unfinished new model");
  expect(configurationReads).toBe(1);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("settings-model-mobile.png"),
  });
});
