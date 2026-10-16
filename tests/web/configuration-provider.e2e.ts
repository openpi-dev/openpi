import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebModelConfigurations } from "../../web/runtime/types.ts";
import { MODEL_ID, PROVIDER_ID } from "./provider-e2e-support.ts";
import { DEFAULT_WEB_APPEARANCE } from "../../extensions/shared/setup-config.ts";

const headers = { Authorization: `Bearer ${process.env.OPENPI_WEB_E2E_TOKEN}` };

test("Configuration controls reach the owned Pi writer, persist, affect native Responses and recover failure/cancellation", async ({
  page,
}, testInfo) => {
  const agentDirectory = process.env.OPENPI_WEB_PROVIDER_AGENT_DIR;
  if (!agentDirectory)
    throw new Error("An isolated provider agent directory is required");
  const workspace = await mkdtemp(
    join(tmpdir(), "openpi-configuration-provider-"),
  );
  const requests: {
    tools: { name: string }[];
    reasoning?: { effort: string; summary?: string };
    text?: { verbosity?: string };
  }[] = [];
  let nextApply: Record<string, string> | undefined;
  let hold = false;
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    if (hold) return;
    const id = String(requests.length);
    // The fixture supplies the model's choice; admission, tool ownership,
    // validation, persistence, events and request shaping use the real runtime.
    const apply =
      nextApply &&
      body.tools.some(
        (tool: { name: string }) => tool.name === "configure_my_pi_setup",
      )
        ? nextApply
        : undefined;
    nextApply = undefined;
    const item = apply
      ? {
          type: "function_call",
          id: `fc_${id}`,
          call_id: `call_${id}`,
          name: "configure_my_pi_setup",
          arguments: JSON.stringify(apply),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${id}`,
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Configuration fixture finished.",
              annotations: [],
            },
          ],
        };
    const events = [
      { type: "response.created", response: { id: `resp_${id}` } },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_${id}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ];
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  let original: WebModelConfigurations["models"][number] | undefined;
  const snapshot = async () =>
    (await page.request.get("/api/snapshot", { headers })).json();
  const configuration = async (sessionId: string) => {
    const response = await page.request.get(
      `/api/models/configuration?sessionId=${sessionId}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    return (await response.json()) as WebModelConfigurations;
  };
  const disk = async () =>
    JSON.parse(
      await readFile(join(agentDirectory, "my-pi-setup.json"), "utf8"),
    );
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const created = await page.request.post("/api/sessions", {
      headers,
      data: {
        workspacePath: (await imported.json()).path,
        commandId: "configuration-provider",
      },
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    const current = await configuration(session.sessionId);
    original = current.models.find(
      (model) => model.provider === PROVIDER_ID && model.id === MODEL_ID,
    );
    expect(original).toBeDefined();
    const changed = await page.request.post("/api/models/configuration", {
      headers,
      data: {
        sessionId: session.sessionId,
        revision: current.revision,
        model: {
          ...original,
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    });
    expect(changed.status()).toBe(200);
    expect(
      (
        await page.request.post("/api/model", {
          headers,
          data: {
            provider: PROVIDER_ID,
            modelId: MODEL_ID,
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
          },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.post("/api/thinking", {
          headers,
          data: {
            sessionId: session.sessionId,
            sessionPath: session.sessionPath,
            level: "high",
          },
        })
      ).status(),
    ).toBe(200);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/?settings=configuration");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const verbosity = dialog.getByRole("button", {
      name: "输出详细程度",
      exact: true,
    });
    const summary = dialog.getByRole("button", {
      name: "推理摘要",
      exact: true,
    });
    await expect(verbosity).toBeEnabled();
    const choose = async (
      control: typeof verbosity,
      label: string,
      apply: Record<string, string>,
    ) => {
      nextApply = apply;
      await control.click();
      await page.getByRole("menuitem", { name: label, exact: false }).click();
    };
    await choose(verbosity, "详细", { response_verbosity: "high" });
    await expect(
      dialog.getByText("OpenPI 配置已保存并应用。", { exact: true }),
    ).toBeVisible();
    await expect(verbosity).toContainText("详细");
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    await choose(summary, "关闭", { response_reasoning_summary: "none" });
    await expect(summary).toContainText("关闭");
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    expect((await disk()).response).toEqual({
      verbosity: "high",
      reasoningSummary: "none",
    });
    const canonical = await (
      await page.request.get(
        `/api/settings/catalog?sessionId=${session.sessionId}`,
        { headers },
      )
    ).json();
    expect(canonical.setup.response).toEqual((await disk()).response);
    expect(
      requests.some((request) =>
        request.tools.some((tool) => tool.name === "configure_my_pi_setup"),
      ),
    ).toBe(true);
    await page.reload();
    await expect(verbosity).toContainText("详细");
    await expect(summary).toContainText("关闭");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const input = page.getByRole("textbox", { name: "描述任务" });
    const before = requests.length;
    await input.fill("Verify the saved response preferences.");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => requests.length).toBe(before + 1);
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    const ordinary = requests.at(-1)!;
    expect(ordinary.text?.verbosity).toBe("high");
    expect(ordinary.reasoning).toEqual({ effort: "high" });
    expect(ordinary.tools.some((tool) => tool.name === "read")).toBe(true);
    expect(
      ordinary.tools.some((tool) => tool.name === "configure_my_pi_setup"),
    ).toBe(false);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await dialog.getByRole("tab", { name: "配置", exact: true }).click();
    await choose(verbosity, "简短", {
      response_verbosity: "invalid-fixture-value",
    });
    await expect(dialog.getByRole("alert")).toContainText(
      "配置请求失败，请查看错误和当前设置后再重试。",
    );
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    expect((await disk()).response.verbosity).toBe("high");
    await expect(verbosity).toContainText("详细");
    await page.reload();
    await expect(dialog.getByRole("alert")).toContainText(
      "配置请求失败，请查看错误和当前设置后再重试。",
    );
    hold = true;
    const beforeCancel = requests.length;
    await choose(verbosity, "简短", { response_verbosity: "low" });
    await expect.poll(() => requests.length).toBe(beforeCancel + 1);
    await expect(verbosity).toBeDisabled();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("button", { name: "停止当前轮次", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    hold = false;
    nextApply = undefined;
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await dialog.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(
      dialog.getByText("配置过程已取消，未确认成功保存。", { exact: true }),
    ).toBeVisible();
    expect((await disk()).response.verbosity).toBe("high");
    await expect(verbosity).toContainText("详细");
    await choose(verbosity, "模型默认", { response_verbosity: "default" });
    await expect(verbosity).toContainText("模型默认");
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    await choose(summary, "模型默认", {
      response_reasoning_summary: "default",
    });
    await expect(summary).toContainText("模型默认");
    await expect
      .poll(async () => (await snapshot()).runtime.status)
      .toBe("idle");
    expect((await disk()).response).toEqual({
      verbosity: "default",
      reasoningSummary: "default",
    });
    expect((await snapshot()).thinking.level).toBe("high");
    expect((await snapshot()).currentSessionId).toBe(session.sessionId);
    await testInfo.attach("native-configuration-receipt", {
      body: JSON.stringify(
        {
          response: (await disk()).response,
          requestCount: requests.length,
          ordinary: {
            reasoning: ordinary.reasoning,
            text: ordinary.text,
            tools: ordinary.tools.map((tool) => tool.name),
          },
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (original) {
      const active = await snapshot();
      const current = await configuration(active.currentSessionId);
      expect(
        (
          await page.request.post("/api/models/configuration", {
            headers,
            data: {
              sessionId: active.currentSessionId,
              revision: current.revision,
              model: original,
            },
          })
        ).status(),
      ).toBe(200);
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Appearance and reasoning visibility synchronize across browsers, share themes and reset without a model turn", async ({
  page,
}, testInfo) => {
  const second = await page.context().newPage();
  const snapshot = async () =>
    (await page.request.get("/api/snapshot", { headers })).json();
  const workspace = await mkdtemp(
    join(tmpdir(), "openpi-settings-cross-browser-"),
  );
  const imported = await page.request.post("/api/workspaces", {
    headers,
    data: { path: workspace },
  });
  expect(imported.status()).toBe(201);
  const created = await page.request.post("/api/sessions", {
    headers,
    data: {
      workspacePath: (await imported.json()).path,
      commandId: "settings-cross-browser",
    },
  });
  expect(created.status()).toBe(201);
  const session = await created.json();
  expect(
    (
      await page.request.post("/api/model", {
        headers,
        data: {
          provider: PROVIDER_ID,
          modelId: MODEL_ID,
          sessionId: session.sessionId,
          sessionPath: session.sessionPath,
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post("/api/thinking", {
        headers,
        data: {
          sessionId: session.sessionId,
          sessionPath: session.sessionPath,
          level: "high",
        },
      })
    ).status(),
  ).toBe(200);
  const before = await snapshot();
  const reset = await page.request.post("/api/settings/preferences", {
    headers,
    data: {
      theme: "system",
      appearance: DEFAULT_WEB_APPEARANCE,
      hiddenThinkingLevels: [],
      chatWidth: 820,
      chatFontSize: 14,
      expandThinking: false,
    },
  });
  expect(reset.status()).toBe(200);
  try {
    await Promise.all([
      page.goto("/?settings=appearance"),
      second.goto("/?settings=appearance"),
    ]);
    const firstDialog = page.getByRole("dialog", { name: "设置", exact: true });
    const secondDialog = second.getByRole("dialog", {
      name: "设置",
      exact: true,
    });
    await firstDialog.getByRole("radio", { name: "深色", exact: true }).click();
    await expect(
      secondDialog.getByRole("radio", { name: "深色", exact: true }),
    ).toBeChecked();
    await secondDialog
      .getByRole("button", { name: "字体", exact: true })
      .click();
    await second.getByRole("menuitem", { name: "衬线", exact: true }).click();
    await expect(
      firstDialog.getByRole("button", { name: "字体", exact: true }),
    ).toContainText("衬线");
    await firstDialog
      .getByRole("button", { name: "强调色", exact: true })
      .click();
    await Promise.all([
      page.getByRole("menuitem", { name: "蓝色", exact: true }).click(),
      secondDialog
        .getByRole("textbox", { name: "前景", exact: true })
        .fill("#ABCDEF"),
    ]);
    await expect
      .poll(async () => (await snapshot()).preferences.appearance)
      .toEqual({
        ...DEFAULT_WEB_APPEARANCE,
        accent: "#2563EB",
        foreground: "#ABCDEF",
        font: "serif",
      });
    await expect(
      firstDialog.getByRole("textbox", { name: "前景", exact: true }),
    ).toHaveValue("#ABCDEF");
    await expect(
      secondDialog.getByRole("button", { name: "强调色", exact: true }),
    ).toContainText("蓝色");
    await secondDialog
      .getByRole("button", { name: "字体", exact: true })
      .click();
    await expect(
      second.getByRole("menuitem", { name: "衬线", exact: true }),
    ).toHaveCSS("color", "rgb(171, 205, 239)");
    await expect(second.getByRole("menu").locator("..")).toHaveCSS(
      "background-color",
      "rgb(23, 25, 28)",
    );
    await second.keyboard.press("Escape");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await firstDialog
      .getByRole("button", { name: "复制主题", exact: true })
      .click();
    await expect(
      firstDialog.getByText("主题已复制", { exact: true }),
    ).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(copied)).toEqual({
      version: 1,
      theme: "dark",
      appearance: {
        ...DEFAULT_WEB_APPEARANCE,
        accent: "#2563EB",
        foreground: "#ABCDEF",
        font: "serif",
      },
    });
    await firstDialog
      .getByRole("button", { name: "导入主题", exact: true })
      .click();
    const importer = page.getByRole("dialog", {
      name: "导入主题",
      exact: true,
    });
    await importer
      .getByRole("textbox", { name: "主题数据", exact: true })
      .fill("{invalid}");
    await expect(
      importer.getByRole("button", { name: "导入", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    expect((await snapshot()).preferences.theme).toBe("dark");
    await firstDialog
      .getByRole("button", { name: "高级", exact: true })
      .click();
    const width = firstDialog.getByRole("slider", {
      name: "聊天内容宽度",
      exact: true,
    });
    await width.focus();
    await width.press("End");
    await expect
      .poll(async () => (await snapshot()).preferences.chatWidth)
      .toBe(2000);
    await firstDialog
      .getByRole("button", { name: "恢复默认聊天宽度", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).preferences.chatWidth)
      .toBe(820);
    const fontSize = firstDialog.getByRole("slider", {
      name: "聊天字体大小",
      exact: true,
    });
    await fontSize.focus();
    await fontSize.press("End");
    await expect
      .poll(async () => (await snapshot()).preferences.chatFontSize)
      .toBe(24);
    await firstDialog
      .getByRole("button", { name: "恢复默认字体大小", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).preferences.chatFontSize)
      .toBe(14);
    await firstDialog
      .getByRole("switch", { name: "默认展开思考块", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).preferences.expandThinking)
      .toBe(true);
    await firstDialog
      .getByRole("button", { name: "重置外观", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).preferences.appearance)
      .toEqual(DEFAULT_WEB_APPEARANCE);
    expect((await snapshot()).preferences.expandThinking).toBe(false);
    await expect(
      secondDialog.getByRole("radio", { name: "跟随系统", exact: true }),
    ).toBeChecked();
    await firstDialog
      .getByRole("button", { name: "导入主题", exact: true })
      .click();
    await importer
      .getByRole("textbox", { name: "主题数据", exact: true })
      .fill(copied);
    await importer.getByRole("button", { name: "导入", exact: true }).click();
    await expect(importer).not.toBeVisible();
    await expect(
      secondDialog.getByRole("radio", { name: "深色", exact: true }),
    ).toBeChecked();
    await expect(
      secondDialog.getByRole("button", { name: "字体", exact: true }),
    ).toContainText("衬线");
    await Promise.all([
      firstDialog.getByRole("tab", { name: "配置", exact: true }).click(),
      secondDialog.getByRole("tab", { name: "配置", exact: true }).click(),
    ]);
    await firstDialog
      .getByRole("button", { name: "可用推理强度", exact: true })
      .click();
    await secondDialog
      .getByRole("button", { name: "可用推理强度", exact: true })
      .click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: "off", exact: true }),
    ).toHaveCSS("color", "rgb(171, 205, 239)");
    await Promise.all([
      page.getByRole("menuitemcheckbox", { name: "off", exact: true }).click(),
      second
        .getByRole("menuitemcheckbox", { name: "high", exact: true })
        .click(),
    ]);
    await expect
      .poll(
        async () =>
          new Set((await snapshot()).preferences.hiddenThinkingLevels),
      )
      .toEqual(new Set(["off", "high"]));
    await expect(
      page.getByRole("menuitemcheckbox", { name: "high", exact: true }),
    ).not.toBeChecked();
    await expect(
      second.getByRole("menuitemcheckbox", { name: "off", exact: true }),
    ).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(
      firstDialog.getByRole("heading", { name: "配置", exact: true }),
    ).toBeVisible();
    const after = await snapshot();
    expect(after.currentSessionId).toBe(before.currentSessionId);
    expect(after.thinking.level).toBe(before.thinking.level);
    expect(after.thinking.available).toEqual(before.thinking.available);
    expect(after.selectedSession.entries).toEqual(
      before.selectedSession.entries,
    );
    await page.screenshot({
      path: testInfo.outputPath("configuration-cross-browser-persisted.png"),
    });
  } finally {
    await second.close();
    expect(
      (
        await page.request.post("/api/settings/preferences", {
          headers,
          data: {
            theme: "system",
            appearance: DEFAULT_WEB_APPEARANCE,
            hiddenThinkingLevels: [],
            chatWidth: 820,
            chatFontSize: 14,
            expandThinking: false,
          },
        })
      ).status(),
    ).toBe(200);
    await rm(workspace, { recursive: true, force: true });
  }
});
