import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_ID,
  PROVIDER_ID,
  deferProviderWorkspaceCleanup,
  startFakeProvider,
} from "./provider-e2e-support.ts";

const plan =
  '# 导出会话记录\n\n## 目标\n\n首版提供 **Markdown** 导出，方便阅读与分享，沿用 Pi 的会话记录。\n\n## 实现步骤\n\n1. 从当前分支读取用户消息、助手回复及工具结果。\n2. 保留消息顺序，使用明确标题区分内容类型。\n3. 导出前选择目标位置，避免覆盖已有文件。\n\n## 验证\n\n- [ ] 中文、代码块和长消息可读。\n- [ ] 空会话、取消与写入失败有明确反馈。\n\n```ts\nconst format = "markdown";\n```\n\n本次仅提交开发计划。';
const headers = { Authorization: `Bearer ${process.env.OPENPI_WEB_E2E_TOKEN}` };

test("Plan switch changes only owner state; first message gets planning context and a persistent placeholder", async ({
  page,
}) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-plan-switch-"));
  const forbidden = join(workspace, "should-not-exist.txt");
  const provider = await startFakeProvider((_body, index) => {
    const delta =
      index === 0
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "blocked-write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    path: forbidden,
                    content: "must be blocked",
                  }),
                },
              },
            ],
          }
        : index === 2
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "setup-theme",
                  type: "function",
                  function: {
                    name: "configure_my_pi_setup",
                    arguments: JSON.stringify({ ui_web_theme: "dark" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "继续讨论方案，不实施。" };
    return (
      [
        { index: 0, delta, finish_reason: null },
        {
          index: 0,
          delta: {},
          finish_reason: index === 0 || index === 2 ? "tool_calls" : "stop",
        },
      ]
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "plan-switch", object: "chat.completion.chunk", created: 1700000000, model: MODEL_ID, choices: [choice] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n"
    );
  });
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    const created = await page.request.post("/api/sessions", {
      headers,
      data: {
        workspacePath: (await imported.json()).path,
        commandId: "plan-switch",
      },
    });
    const { sessionId, sessionPath } = await created.json();
    const model = await page.request.post("/api/model", {
      headers,
      data: {
        sessionId,
        sessionPath,
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
    expect(model.status()).toBe(200);
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    const placeholder = "本次对话使用 Plan 模式 · 继续讨论计划，暂不实施";
    await input.fill("规划导出功能，先调查，不实施。");
    const before = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    await page.getByRole("button", { name: "进入规划", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "退出规划", exact: true }),
    ).toBeEnabled();
    await expect(input).toHaveValue("规划导出功能，先调查，不实施。");
    await expect(input).not.toHaveAttribute("placeholder", placeholder);
    expect(provider.requests).toHaveLength(0);
    await expect(page.locator(".message-row.user")).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await expect(
      settings.getByRole("radio", { name: "深色", exact: true }),
    ).toBeDisabled();
    await expect(
      settings.getByText(
        "请先退出 Plan 模式，再修改 OpenPI 设置。退出不会开始实施计划。",
      ),
    ).toBeVisible();
    const blocked = await page.request.post("/api/prompt", {
      headers,
      data: {
        sessionId,
        sessionPath,
        commandId: "plan-setup-blocked",
        content: "/openpi-setup use dark theme",
      },
    });
    expect(blocked.status()).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await blocked.json())).toContain("Exit Plan mode");
    expect(provider.requests).toHaveLength(0);
    await settings.getByRole("button", { name: "关闭", exact: true }).click();
    const stale = await page.request.post("/api/plan", {
      headers,
      data: {
        sessionId,
        enabled: false,
        expectedRevision: before.runtime.planRevision,
      },
    });
    expect(stale.status()).toBe(409);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "退出规划", exact: true }),
    ).toBeEnabled();
    expect(provider.requests).toHaveLength(0);
    await input.fill("规划导出功能，先调查，不实施。");
    await input.press("Enter");
    await expect(input).toHaveAttribute("placeholder", placeholder);
    await expect(
      page.getByText("继续讨论方案，不实施。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "退出规划", exact: true }),
    ).toBeEnabled();
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[0]?.body)).toContain(
      "Plan mode is active",
    );
    expect(JSON.stringify(provider.requests[1]?.body)).toContain(
      "no changes yet",
    );
    await expect(access(forbidden)).rejects.toThrow();
    await page.reload();
    await expect(input).toHaveAttribute("placeholder", placeholder);
    await input.fill("下一条草稿");
    await page.getByRole("button", { name: "退出规划", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "进入规划", exact: true }),
    ).toBeEnabled();
    await expect(input).not.toHaveAttribute("placeholder", placeholder);
    await expect(input).toHaveValue("下一条草稿");
    expect(provider.requests).toHaveLength(2);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      settings.getByRole("radio", { name: "深色", exact: true }),
    ).toBeEnabled();
    await settings
      .locator(".settings-theme-option")
      .filter({ hasText: "深色" })
      .click();
    await expect(
      settings.getByText(
        /OpenPI 配置已保存并应用。|配置已保存，实际设置没有变化。/,
      ),
    ).toBeVisible();
    await expect(
      settings.getByRole("radio", { name: "深色", exact: true }),
    ).toBeChecked();
    expect(provider.requests).toHaveLength(4);
    expect(JSON.stringify(provider.requests[2]?.body)).toContain(
      "Plan mode is inactive",
    );
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "设置" })
        .getByText(/OpenPI 配置已保存并应用。|配置已保存，实际设置没有变化。/),
    ).toBeVisible();
  } finally {
    await provider.close();
    deferProviderWorkspaceCleanup(workspace);
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`native Plan questions settle into one readable plan card in ${theme}`, async ({
    page,
  }, info) => {
    // Exercise a scrolled transcript with earlier long plans, as in a resumed
    // acceptance Session. Keep the fixture synthetic and local to the browser.
    const history = Array.from({ length: 24 }, (_, index) => ({
      type: "message",
      id: `history-${index}`,
      timestamp: "2026-09-18T00:00:00Z",
      message: {
        role: "assistant",
        timestamp: index + 1,
        content: `${plan}\n\n${plan}`,
      },
    }));
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      if (snapshot.selectedSession)
        snapshot.selectedSession.entries.unshift(...history);
      await route.fulfill({ response, json: snapshot });
    });
    let releaseArguments = () => {};
    let releaseFinish = () => {};
    let releaseBurst = () => {};
    const burstGate = new Promise<void>((resolve) => {
      releaseBurst = resolve;
    });
    const argumentsGate = new Promise<void>((resolve) => {
      releaseArguments = resolve;
    });
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const streamSteps = Array.from(
      { length: theme === "light" ? 48 : 6 },
      () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { gate, release };
      },
    );
    const provider = await startFakeProvider(async function* (_body, index) {
      const name = index === 0 ? "ask_user" : "plan_ready";
      const args =
        index === 0
          ? {
              questions: [
                {
                  id: "format",
                  header: "导出格式",
                  question: "首版希望导出哪种格式？",
                  options: [
                    { label: "Markdown", description: "方便阅读和分享。" },
                    { label: "JSON", description: "方便程序处理。" },
                  ],
                },
              ],
            }
          : {
              plan:
                theme === "light"
                  ? `${plan}\n\n${"验证取消、恢复和消息顺序。\n\n".repeat(160)}`
                  : `${plan}\n\n${"验证消息顺序与取消。\n\n".repeat(100)}`,
            };
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "plan-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason }],
      });
      if (index > 0) {
        const event = (delta: unknown, finish: string | null = null) =>
          `data: ${JSON.stringify(chunk(delta, finish))}\n\n`;
        yield event({
          role: "assistant",
          reasoning_content: "The user selected Markdown. Preparing the plan.",
        });
        yield event({
          role: "assistant",
          content: "已收到选择，正在整理计划。",
        });
        await argumentsGate;
        const encoded = JSON.stringify(args);
        yield event({
          tool_calls: [
            {
              index: 0,
              id: `call-${index}`,
              type: "function",
              function: { name, arguments: encoded.slice(0, 80) },
            },
          ],
        });
        let offset = 80;
        for (const step of streamSteps) {
          await step.gate;
          // Model tokens arrive over time, crossing paint frames and timers.
          if (theme === "light")
            await new Promise((resolve) => setTimeout(resolve, 120));
          const next = Math.min(encoded.length, offset + 35);
          yield event({
            tool_calls: [
              {
                index: 0,
                function: { arguments: encoded.slice(offset, next) },
              },
            ],
          });
          offset = next;
        }
        if (theme === "dark") {
          await burstGate;
          // A provider may deliver many token deltas in one network read.
          // Keep the turn unfinished so snapshot recovery cannot hide lost UI.
          let burst = "";
          for (let index = 0; index < 90; index++) {
            const next = Math.min(encoded.length, offset + 10);
            burst += event({
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: encoded.slice(offset, next) },
                },
              ],
            });
            offset = next;
          }
          yield burst;
        }
        await finishGate;
        yield event({
          tool_calls: [
            { index: 0, function: { arguments: encoded.slice(offset) } },
          ],
        });
        yield event({}, "tool_calls") + "data: [DONE]\n\n";
        return;
      }
      yield [
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          null,
        ),
        chunk({}, "tool_calls"),
      ]
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    });
    const workspace = await mkdtemp(join(tmpdir(), "openpi-plan-card-"));
    try {
      await page.emulateMedia({ colorScheme: theme });
      if (theme === "dark")
        await page.setViewportSize({ width: 390, height: 844 });
      else await page.setViewportSize({ width: 1280, height: 960 });
      const imported = await page.request.post("/api/workspaces", {
        headers,
        data: { path: workspace },
      });
      expect(imported.status()).toBe(201);
      const { path } = await imported.json();
      const created = await page.request.post("/api/sessions", {
        headers,
        data: { workspacePath: path, commandId: `plan-${theme}` },
      });
      expect(created.status()).toBe(201);
      const session = await created.json();
      const model = await page.request.post("/api/model", {
        headers,
        data: {
          sessionId: session.sessionId,
          sessionPath: session.sessionPath,
          provider: PROVIDER_ID,
          modelId: MODEL_ID,
        },
      });
      expect(model.status()).toBe(200);
      await page.goto("/");
      const input = page.getByRole("textbox", { name: "描述任务" });
      if (theme === "light")
        await page
          .getByRole("button", { name: "进入规划", exact: true })
          .click();
      const prompt = `${theme === "dark" ? "/plan " : ""}规划会话导出，先询问 Markdown 或 JSON，不修改代码。`;
      await input.fill(prompt);
      await input.press("Enter");
      await expect(page.locator(".question-card")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "停止当前轮次" }),
      ).toBeVisible();
      await page.getByRole("radio", { name: /Markdown/ }).check();
      await page.getByRole("button", { name: "复核答案" }).click();
      await page.getByRole("button", { name: "提交答案", exact: true }).click();
      const answer = page
        .locator("article")
        .filter({ hasText: "已收到选择，正在整理计划。" });
      await expect(answer).toHaveCount(1);
      await answer.evaluate((element) => {
        element.setAttribute("data-stream-check", "stable");
      });
      releaseArguments();
      await expect(
        page.locator(".tool-name").filter({ hasText: "plan_ready" }),
      ).toBeVisible();
      await expect(answer).toHaveAttribute("data-stream-check", "stable");
      const evidence = page.locator(".message-details").filter({
        has: page.locator(".tool-summary", { hasText: "User answered:" }),
      });
      await expect(evidence).toHaveCount(1);
      await evidence.evaluate((element) => {
        element.setAttribute("data-stream-check", "answer-evidence");
      });
      const beforeStream = await evidence.boundingBox();
      const frames = await evidence.evaluateHandle((element) => {
        const samples: number[] = [];
        let frame = 0;
        const sample = () => {
          samples.push(element.getBoundingClientRect().y);
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        return { samples, stop: () => cancelAnimationFrame(frame) };
      });
      const planEvidence = page.locator(".message-details").filter({
        has: page.locator(".tool-name", { hasText: "plan_ready" }),
      });
      for (const step of streamSteps) {
        const previous = await planEvidence.locator("pre").textContent();
        step.release();
        await expect(planEvidence.locator("pre")).not.toHaveText(previous!);
        await expect(answer).toHaveAttribute("data-stream-check", "stable");
        await expect(evidence).toHaveAttribute(
          "data-stream-check",
          "answer-evidence",
        );
        expect((await evidence.boundingBox())?.y).toBeCloseTo(
          beforeStream!.y,
          0,
        );
      }
      const positions = await frames.evaluate((monitor) => {
        monitor.stop();
        return monitor.samples;
      });
      await frames.dispose();
      expect(positions.length).toBeGreaterThan(0);
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
      if (theme === "dark") {
        const previous = await planEvidence.locator("pre").textContent();
        releaseBurst();
        await expect(planEvidence.locator("pre")).not.toHaveText(previous!);
        // Observe the stalled remainder, including any reconnect/snapshot cycle.
        await page.waitForTimeout(1_000);
        await expect(answer).toHaveAttribute("data-stream-check", "stable");
        await expect(planEvidence).toBeVisible();
      }
      expect(
        await answer.evaluate((element) => {
          const tool = [...document.querySelectorAll(".tool-name")].find(
            (node) => node.textContent === "plan_ready",
          );
          return Boolean(
            tool &&
              element.compareDocumentPosition(tool) &
                Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      ).toBe(true);
      releaseFinish();
      const card = page.getByRole("region", { name: "开发计划" });
      await expect(card).toHaveCount(1);
      await expect(page.locator(".question-panel")).toHaveCount(0);
      await expect(card.locator("ol")).toHaveCSS("list-style-type", "decimal");
      await expect(
        card.getByRole("heading", { name: "导出会话记录" }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (
              await (
                await page.request.get("/api/snapshot", { headers })
              ).json()
            ).runtime.status,
        )
        .toBe("idle");
      expect(provider.requests).toHaveLength(2);
      expect(JSON.stringify(provider.requests[1]?.body)).toContain(
        "User answered:",
      );
      await page.reload();
      await expect(page.locator(".message-row.user").first()).toContainText(
        prompt,
      );
      await expect(
        page.getByText("计划就绪 · 等待审阅", { exact: true }),
      ).toBeVisible();
      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole("heading", { name: "导出会话记录" }),
      ).toBeVisible();
      await expect(
        card.getByText("此步骤仅生成计划，不代表已批准或开始实施。"),
      ).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).include(".plan-card").analyze())
          .violations,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.body.scrollWidth <= document.body.clientWidth,
        ),
      ).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: info.outputPath(`plan-${theme}.png`) });
      await card.getByRole("button", { name: /计划已就绪/ }).click();
      await expect(
        card.getByRole("heading", { name: "导出会话记录" }),
      ).not.toBeVisible();
      await card.getByRole("button", { name: /计划已就绪/ }).click();
      await expect(
        card.getByRole("heading", { name: "导出会话记录" }),
      ).toBeVisible();
      expect(provider.requests).toHaveLength(2);
    } finally {
      releaseArguments();
      releaseBurst();
      for (const step of streamSteps) step.release();
      releaseFinish();
      await provider.close();
      deferProviderWorkspaceCleanup(workspace);
    }
  });
}

test("Plan Ready stays gated through browser preview and unsupported fresh handoff, then releases on submit", async ({
  page,
}) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-plan-handoff-"));
  const implementationFile = join(workspace, "implementation.txt");
  const provider = await startFakeProvider((_body, index) => {
    const tool = [
      {
        name: "plan_ready",
        arguments: JSON.stringify({
          plan: "Create implementation.txt with the approved content.",
        }),
      },
      {
        name: "write",
        arguments: JSON.stringify({
          path: implementationFile,
          content: "must remain blocked until approval",
        }),
      },
      undefined,
      {
        name: "write",
        arguments: JSON.stringify({
          path: implementationFile,
          content: "written after explicit submission",
        }),
      },
      undefined,
    ][index];
    const chunk = (delta: unknown, finishReason: string | null) =>
      "data: " +
      JSON.stringify({
        id: "plan-handoff",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) +
      "\n\n";
    if (!tool)
      return (
        chunk(
          {
            role: "assistant",
            content:
              index === 2
                ? "The ready plan remains gated."
                : "Implementation finished.",
          },
          "stop",
        ) + "data: [DONE]\n\n"
      );
    return (
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "plan-handoff-call-" + index,
              type: "function",
              function: { name: tool.name, arguments: tool.arguments },
            },
          ],
        },
        null,
      ) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n"
    );
  });
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path } = await imported.json();
    const created = await page.request.post("/api/sessions", {
      headers,
      data: { workspacePath: path, commandId: "plan-handoff-session" },
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    const model = await page.request.post("/api/model", {
      headers,
      data: {
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
    expect(model.status()).toBe(200);

    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("/plan Create a file after approval.");
    await input.press("Enter");
    const planCard = page.getByRole("region", { name: "开发计划" });
    await expect(planCard).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .runtime.plan,
      )
      .toBe("ready");
    expect(provider.requests).toHaveLength(1);

    const readySnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    const readyRevision = readySnapshot.runtime.planRevision;
    await input.fill("请现在就尝试写文件，验证待审阅计划仍有写入门禁。");
    await input.press("Enter");
    await expect(
      page.getByText("The ready plan remains gated.", { exact: true }),
    ).toBeVisible();
    const gatedSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(gatedSnapshot.runtime.plan).toBe("ready");
    expect(gatedSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);
    await expect(access(implementationFile)).rejects.toThrow();

    await input.fill("/plan ");
    await input.press("Enter");
    await expect(
      page.getByText(
        "Use `/plan implement`, `/plan fresh`, or `/plan off` in a UI session.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(provider.requests).toHaveLength(3);

    await input.fill("/plan implement");
    await input.press("Enter");
    await expect(
      page.getByText(
        "Implementing a ready plan requires an interactive editor.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(provider.requests).toHaveLength(3);

    await input.fill("/plan fresh");
    await input.press("Enter");
    await expect(
      page.getByText(
        "Starting a fresh implementation requires an interactive editor.",
        { exact: true },
      ),
    ).toBeVisible();
    const unsupportedSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(unsupportedSnapshot.runtime.plan).toBe("ready");
    expect(unsupportedSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);
    await expect(access(implementationFile)).rejects.toThrow();

    await page.reload();
    await expect(page.getByRole("region", { name: "开发计划" })).toBeVisible();
    const refreshedSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(refreshedSnapshot.runtime.plan).toBe("ready");
    expect(refreshedSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);

    await page
      .getByRole("button", { name: "准备实施提示", exact: true })
      .click();
    await expect(input).toHaveValue(/approved plan/);

    const secondSessionResponse = await page.request.post("/api/sessions", {
      headers,
      data: { workspacePath: path, commandId: "plan-handoff-switch" },
    });
    expect(secondSessionResponse.status()).toBe(201);
    const secondSession = await secondSessionResponse.json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .currentSessionId,
      )
      .toBe(secondSession.sessionId);
    await expect(input).toHaveValue("");
    const otherSessionSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(otherSessionSnapshot.runtime.plan).toBe("inactive");
    expect(provider.requests).toHaveLength(3);

    const selectedOriginal = await page.request.post("/api/sessions/select", {
      headers,
      data: { path: session.sessionPath },
    });
    expect(selectedOriginal.status()).toBe(200);
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .selectedSession?.path,
      )
      .toBe(session.sessionPath);
    const returnedSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(returnedSnapshot.runtime.plan).toBe("ready");
    expect(returnedSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);
    await expect(input).toHaveValue("");
    await input.press("Enter");
    expect(provider.requests).toHaveLength(3);

    await page
      .getByRole("button", { name: "准备实施提示", exact: true })
      .click();
    await expect(input).toHaveValue(/approved plan/);
    await input.fill("");
    const cancelledSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(cancelledSnapshot.runtime.plan).toBe("ready");
    expect(cancelledSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);
    await expect(access(implementationFile)).rejects.toThrow();

    await page
      .getByRole("button", { name: "准备实施提示", exact: true })
      .click();
    await expect(input).toHaveValue(/approved plan/);
    const preparedSnapshot = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(preparedSnapshot.runtime.plan).toBe("ready");
    expect(preparedSnapshot.runtime.planRevision).toBe(readyRevision);
    expect(provider.requests).toHaveLength(3);
    await expect(access(implementationFile)).rejects.toThrow();

    const editedInstruction =
      "Additional approved instruction: preserve the existing file.";
    await input.fill(`${await input.inputValue()}\n\n${editedInstruction}`);
    await input.press("Enter");
    await expect
      .poll(async () => {
        try {
          await access(implementationFile);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .runtime.plan,
      )
      .toBe("inactive");
    expect(await readFile(implementationFile, "utf8")).toBe(
      "written after explicit submission",
    );
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests[3]).toBeDefined();
    expect(JSON.stringify(provider.requests[3]!.body)).toContain(
      editedInstruction,
    );
    await expect(
      page.getByText("Implementation finished.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .runtime.status,
      )
      .toBe("idle");
  } finally {
    await provider.close();
    deferProviderWorkspaceCleanup(workspace);
  }
});

test("Plan off gives a visible receipt and clears a ready Plan without another model turn", async ({
  page,
}) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-plan-off-"));
  const provider = await startFakeProvider(() => {
    const delta = {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "plan-off-ready",
          type: "function",
          function: {
            name: "plan_ready",
            arguments: JSON.stringify({
              plan: "Prepare a file, but wait for an explicit implementation choice.",
            }),
          },
        },
      ],
    };
    const choices = [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "tool_calls" },
    ];
    return (
      choices
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "plan-off", object: "chat.completion.chunk", created: 1700000000, model: MODEL_ID, choices: [choice] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n"
    );
  });
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    const { path } = await imported.json();
    const created = await page.request.post("/api/sessions", {
      headers,
      data: { workspacePath: path, commandId: "plan-off-session" },
    });
    const session = await created.json();
    const model = await page.request.post("/api/model", {
      headers,
      data: {
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
    expect(model.status()).toBe(200);

    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("/plan Prepare a file, then wait for my choice.");
    await input.press("Enter");
    await expect(page.getByRole("region", { name: "开发计划" })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/snapshot", { headers })).json())
            .runtime.plan,
      )
      .toBe("ready");
    expect(provider.requests).toHaveLength(1);

    await input.fill("/plan off");
    await input.press("Enter");
    await expect(
      page.getByText("Plan mode off. No implementation was started.", {
        exact: true,
      }),
    ).toBeVisible();
    const cancelled = await (
      await page.request.get("/api/snapshot", { headers })
    ).json();
    expect(cancelled.runtime.plan).toBe("inactive");
    expect(provider.requests).toHaveLength(1);
  } finally {
    await provider.close();
    deferProviderWorkspaceCleanup(workspace);
  }
});
