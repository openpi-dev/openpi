import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const [width, touch] of [
  [1280, false],
  [390, false],
  [390, true],
] as const) {
  test.describe(`${width}px ${touch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch: touch });
    test("opens and follows all subagents without confusing spawn with completion", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      let parentId = "";
      let reads = 0;
      let failDetails = false;
      const tasks = Array.from({ length: 6 }, (_, index) => ({
        id: `child-${index}`,
        title: `Readonly task ${index + 1}`,
        status: index === 0 ? "running" : index === 5 ? "error" : "done",
        outcome: index === 0 ? undefined : index === 5 ? "failed" : "completed",
        createdAt: Date.now() - 10_000,
        ...(index > 0 ? { settledAt: Date.now() } : {}),
      }));
      await page.route("**/api/snapshot**", async (route) => {
        const response = await route.fetch();
        const snapshot = await response.json();
        parentId = snapshot.currentSessionId;
        snapshot.runtime = {
          status: "idle",
          capabilities: {
            subagents: { items: tasks, omitted: 0, truncated: false },
          },
        };
        snapshot.selectedSession.entries = [
          {
            type: "message",
            id: "user",
            timestamp: "2026-09-18T00:00:00Z",
            message: { role: "user", content: "Inspect the child work" },
          },
          {
            type: "message",
            id: "call",
            timestamp: "2026-09-18T00:00:01Z",
            message: {
              role: "assistant",
              content: "",
              parts: [
                {
                  type: "toolCall",
                  id: "spawn-1",
                  name: "subagent_spawn",
                  arguments: JSON.stringify({
                    name: tasks[0]!.title,
                    prompt: "Read the package",
                  }),
                },
              ],
            },
          },
          {
            type: "message",
            id: "receipt",
            timestamp: "2026-09-18T00:00:02Z",
            message: {
              role: "toolResult",
              toolName: "subagent_spawn",
              toolCallId: "spawn-1",
              isError: false,
              content: "Started child-0",
              details: { id: "child-0", title: tasks[0]!.title },
            },
          },
        ];
        await route.fulfill({ response, json: snapshot });
      });
      await page.route("**/api/capabilities/detail?**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("sessionId")).toBe(parentId);
        expect(url.searchParams.get("kind")).toBe("subagents");
        if (failDetails) {
          await route.fulfill({
            status: 503,
            json: { error: "Temporary read failure" },
          });
          return;
        }
        const task = tasks.find(
          (item) => item.id === url.searchParams.get("id"),
        )!;
        expect(task).toBeTruthy();
        if (task.id === "child-0") reads++;
        const running = task.id === "child-0" && reads === 1;
        await route.fulfill({
          json: {
            sessionId: parentId,
            detail: {
              ...task,
              kind: "subagents",
              status: running
                ? "running"
                : task.id === "child-5"
                  ? "error"
                  : "done",
              outcome: running
                ? undefined
                : task.id === "child-5"
                  ? "failed"
                  : "completed",
              cwd: "/example/workspace",
              model: "test/reasoner",
              prompt: "Read package.json without changing files.",
              transcript: [
                { kind: "user", text: "Read package.json" },
                {
                  kind: "assistant",
                  parts: [
                    {
                      type: "toolCall",
                      toolId: "read-1",
                      name: "read",
                      argsPreview: '{"path":"package.json"}',
                    },
                  ],
                },
                {
                  kind: "toolResult",
                  toolId: "read-1",
                  name: "read",
                  isError: false,
                  outputPreview: '{"name":"example-app"}',
                },
              ],
              liveAssistant: running
                ? { text: "Inspecting the package…", thinking: "" }
                : undefined,
              liveTools: [],
              finalText: running ? "" : "Read-only verification complete.",
              errorText:
                task.id === "child-5"
                  ? "The child could not read the requested file."
                  : undefined,
              truncated: false,
              omittedEntries: 0,
            },
          },
        });
      });
      await page.goto("/");
      const taskRow = page.getByRole("button", {
        name: "打开子代理：Readonly task 1",
        exact: true,
      });
      await expect(taskRow).toBeVisible();
      await expect(taskRow).toContainText("运行中");
      await expect(page.locator(".subagent-receipt")).toHaveCount(0);
      expect(
        await taskRow.evaluate(
          (el) => el.closest(".process-sequence") === null,
        ),
      ).toBe(true);
      const normal = await taskRow.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      if (!touch) {
        await taskRow.hover();
        expect(
          await taskRow.evaluate((el) => getComputedStyle(el).backgroundColor),
        ).not.toBe(normal);
        await page.mouse.move(0, 0);
        expect(
          await taskRow.evaluate((el) => getComputedStyle(el).backgroundColor),
        ).toBe(normal);
      }
      const rowBox = (await taskRow.boundingBox())!;
      if (touch) expect(rowBox.height).toBeGreaterThanOrEqual(44);
      else expect(rowBox.height).toBeLessThan(44); // A narrow mouse viewport is still a mouse.
      const rowAvatar = await taskRow.locator(".subagent-avatar").innerHTML();
      await page.screenshot({
        path: testInfo.outputPath(
          `subagent-row-${width}-${touch ? "touch" : "mouse"}.png`,
        ),
      });
      const overviewTrigger = page.getByRole("button", {
        name: "会话概览",
        exact: true,
      });
      await overviewTrigger.click();
      const overview = page.getByRole("dialog", { name: "会话概览" });
      await expect(overview).toBeVisible();
      const overviewBox = await overview.boundingBox();
      expect(overviewBox!.x).toBeGreaterThanOrEqual(0);
      expect(overviewBox!.x + overviewBox!.width).toBeLessThanOrEqual(width);
      await overview
        .getByRole("button", { name: "子代理: 1 运行中 · 4 完成 · 1 其他记录" })
        .click();
      await expect(overview).toBeHidden();
      await page
        .locator(".subagent-panel")
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      await expect(overviewTrigger).toBeFocused();
      await page
        .getByRole("button", {
          name: "子代理：1 运行中 · 4 已完成 · 1 其他记录",
          exact: true,
        })
        .click();
      const dialog = page.getByRole(width > 1100 ? "complementary" : "main", {
        name: "子代理",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      const list = dialog.getByRole("navigation", { name: "子代理任务列表" });
      const card = list.getByRole("button", { name: /Readonly task 1/ });
      await expect(card).toContainText("运行中");
      await expect(card).not.toContainText("已完成");
      await card.click();
      expect(
        await dialog
          .locator(".subagent-breadcrumb .subagent-avatar")
          .innerHTML(),
      ).toBe(rowAvatar);
      await expect(page.locator("dialog:modal")).toHaveCount(0);
      if (width > 1100)
        await expect(page.locator(".conversation-shell")).toBeVisible();
      else await expect(page.locator(".conversation-shell")).toBeHidden();
      await expect(dialog.getByText("Inspecting the package…")).toBeVisible();
      await expect(
        dialog.getByText("Read-only verification complete."),
      ).toBeVisible();
      await dialog.getByText("read", { exact: true }).click();
      await expect(
        dialog.getByText('{"name":"example-app"}', { exact: true }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "返回子代理列表" }).click();
      await expect(list.getByRole("button")).toHaveCount(6);
      if (width > 1100) {
        await card.click();
        await expect(
          dialog.getByRole("button", { name: "返回子代理列表" }),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "返回子代理列表" }).click();
      }
      await page.screenshot({
        path: testInfo.outputPath(`subagent-list-${width}.png`),
      });
      await list.getByRole("button", { name: /Readonly task 6/ }).click();
      await expect(dialog.getByRole("alert")).toContainText(
        "The child could not read the requested file.",
      );
      failDetails = true;
      await dialog.getByRole("button", { name: "刷新状态" }).click();
      await expect(
        dialog.getByText("刷新失败，下方保留的是上次收到的状态。"),
      ).toBeVisible();
      await expect(
        dialog.getByText("Read-only verification complete."),
      ).toBeVisible();
      failDetails = false;
      await dialog.getByRole("button", { name: "刷新状态" }).click();
      await expect(
        dialog.getByText("刷新失败，下方保留的是上次收到的状态。"),
      ).toHaveCount(0);
      const dimensions = await dialog.boundingBox();
      expect(dimensions!.x).toBeGreaterThanOrEqual(0);
      expect(dimensions!.x + dimensions!.width).toBeLessThanOrEqual(width);
      const footer = await dialog.locator(".subagent-footnote").boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(
        dimensions!.y + dimensions!.height,
      );
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`subagents-${width}.png`),
      });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator(".conversation-shell")).toBeVisible();
      await page
        .getByRole("button", {
          name: "子代理：1 运行中 · 4 已完成 · 1 其他记录",
          exact: true,
        })
        .click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("navigation", { name: "子代理任务列表" }),
      ).toBeVisible();
      if (width > 1100) {
        await dialog.getByRole("button", { name: /Readonly task 6/ }).click();
        await page
          .getByRole("button", {
            name: "子代理：1 运行中 · 4 已完成 · 1 其他记录",
            exact: true,
          })
          .click();
        await expect(
          dialog.getByRole("navigation", { name: "子代理任务列表" }),
        ).toBeVisible();
      }
      await dialog.getByRole("button", { name: /Readonly task 1/ }).click();
      await expect(
        dialog.getByRole("button", { name: "返回子代理列表" }),
      ).toBeVisible();
      const readsBeforeReload = reads;
      await page.reload();
      await expect(
        dialog.getByRole("navigation", { name: "子代理任务列表" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "返回子代理列表" }),
      ).toHaveCount(0);
      expect(reads).toBe(readsBeforeReload);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      if (touch) {
        await taskRow.tap();
        await dialog.getByRole("button", { name: "返回子代理列表" }).tap();
        await dialog.getByRole("button", { name: "关闭", exact: true }).tap();
      } else {
        await taskRow.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(taskRow).toBeFocused();
        expect(
          await taskRow.evaluate((el) => getComputedStyle(el).outlineStyle),
        ).toBe("solid");
        await page.keyboard.press("Enter");
        await expect(
          dialog.getByRole("button", { name: "返回子代理列表" }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(
          dialog.getByRole("navigation", { name: "子代理任务列表" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(taskRow).toBeFocused();
        await page.keyboard.press("Space");
        await expect(
          dialog.getByRole("button", { name: "返回子代理列表" }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(taskRow).toBeFocused();
      }
      await page.context().setOffline(true);
      await expect(taskRow).toContainText("未确认");
      await expect(taskRow).not.toContainText("已完成");
      await page.context().setOffline(false);
      await expect(taskRow).toContainText("运行中");
      Object.assign(tasks[0]!, {
        status: "done",
        outcome: "completed",
        settledAt: Date.now(),
      });
      await page.reload();
      await expect(taskRow).toContainText("已完成");
      await expect(taskRow).not.toContainText("运行中");
      expect(await taskRow.locator(".subagent-avatar").innerHTML()).toBe(
        rowAvatar,
      );
      await page.screenshot({
        path: testInfo.outputPath(`subagent-completed-${width}.png`),
      });
      await page.unrouteAll({ behavior: "wait" });
    });
  });
}

test("workflow tasks share child navigation while retaining uncertainty and exact parent scope", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  let parentId = "";
  let changedPath = false;
  let reads = 0;
  const startedAt = Date.now() - 10_000;
  const children = [
    {
      id: "wf_a123:call:1",
      runId: "wf_a123",
      title: "Review persistence and lifecycle boundaries ".repeat(6),
      status: "unknown",
      createdAt: startedAt,
    },
    {
      id: "wf_a123:call:2",
      runId: "wf_a123",
      title: "Interrupted review",
      status: "error",
      outcome: "interrupted",
      createdAt: startedAt + 1,
      settledAt: startedAt + 2,
    },
  ];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    parentId = snapshot.currentSessionId;
    if (changedPath) {
      snapshot.selectedSession.path += ".different.jsonl";
      snapshot.currentSessionPath = snapshot.selectedSession.path;
    }
    snapshot.runtime = {
      status: "idle",
      capabilities: {
        workflows: {
          omitted: 0,
          truncated: false,
          items: [
            {
              runId: "wf_a123",
              name: "Lifecycle review",
              status: "uncertain",
              startedAt: 1,
              agents: { total: 2, running: 0, done: 0, error: 1, uncertain: 1 },
              children: { items: children, omitted: 0, truncated: false },
            },
          ],
        },
      },
    };
    snapshot.selectedSession.entries = [
      {
        type: "message",
        id: "prompt",
        timestamp: "2026-10-13T00:00:00Z",
        message: {
          role: "user",
          content: "Review with keyword-loaded workflow tools",
        },
      },
      {
        type: "message",
        id: "call",
        timestamp: "2026-10-13T00:00:01Z",
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              name: "workflow",
              id: "wf-call",
              arguments: '{"script":"name: \'Lifecycle review\'"}',
            },
          ],
        },
      },
      {
        type: "message",
        id: "receipt",
        timestamp: "2026-10-13T00:00:02Z",
        message: {
          role: "toolResult",
          toolName: "workflow",
          toolCallId: "wf-call",
          content: "Workflow started",
          details: {
            runId: "wf_a123",
            name: "Lifecycle review",
            status: "running",
          },
        },
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/capabilities/detail?**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("sessionId")).toBe(parentId);
    expect(url.searchParams.get("kind")).toBe("workflows");
    const child = children.find(
      (item) => item.id === url.searchParams.get("id"),
    );
    expect(child).toBeTruthy();
    reads++;
    await route.fulfill({
      json: {
        sessionId: parentId,
        detail: {
          ...child,
          kind: "workflows",
          cwd: "/example/workspace",
          prompt: "",
          transcript: [],
          liveTools: [],
          finalText: "",
          transcriptUnavailable: true,
          truncated: false,
          omittedEntries: 0,
        },
      },
    });
  });
  await page.goto("/");
  const row = page.getByRole("button", {
    name: `打开子代理：${children[0]!.title}`,
    exact: true,
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("未确认");
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await row.evaluate((el) => el.closest(".process-sequence") === null),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  const bounds = (await row.boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(row.locator(".subagent-state")).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("workflow-long-name-390.png"),
  });
  await row.click();
  const panel = page.locator(".subagent-panel");
  await expect(
    panel.getByText("此视图仅保留任务摘要，无法显示完整子代理对话。"),
  ).toBeVisible();
  await expect(panel.getByText("暂未收到消息。")).toHaveCount(0);
  await expect(panel.getByText("已完成", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "返回子代理列表" }).click();
  await panel.getByRole("button", { name: /Interrupted review/ }).click();
  await expect(panel.getByText("已中断", { exact: true })).toBeVisible();
  const previousReads = reads;
  await page.reload();
  await expect(
    panel.getByRole("navigation", { name: "子代理任务列表" }),
  ).toBeVisible();
  expect(reads).toBe(previousReads);
  await expect(panel.getByRole("heading", { name: /未确认/ })).toBeVisible();
  const listTitle = panel.getByTitle(children[0]!.title);
  await expect(listTitle).toBeVisible();
  expect(
    await listTitle.evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect((await listTitle.boundingBox())!.height).toBeLessThanOrEqual(24);
  await page.screenshot({
    path: testInfo.outputPath("workflow-overview-390.png"),
  });
  changedPath = true;
  await page.reload();
  await expect(panel).toHaveCount(0);
  expect(reads).toBe(previousReads);
  await page.unrouteAll({ behavior: "wait" });
});
