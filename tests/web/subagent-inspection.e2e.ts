import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`opens and follows all subagents without confusing spawn with completion at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    let parentId = "";
    let reads = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      id: `child-${index}`,
      title: `Readonly task ${index + 1}`,
      status: index === 0 ? "running" : index === 5 ? "error" : "done",
      outcome: index === 0 ? undefined : index === 5 ? "failed" : "completed",
      createdAt: Date.now() - 10_000,
      ...(index > 0 ? { settledAt: Date.now() } : {}),
    }));
    await page.route("**/events?**", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      }),
    );
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
    const card = page.getByRole("button", {
      name: "打开子代理：Readonly task 1",
      exact: true,
    });
    await expect(card).toContainText("运行中");
    await expect(card).not.toContainText("已完成");
    await card.click();
    const dialog = page.getByRole(width > 1100 ? "complementary" : "main", {
      name: "子代理",
      exact: true,
    });
    await expect(dialog).toBeVisible();
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
    const list = dialog.getByRole("navigation", { name: "子代理任务列表" });
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
      .getByRole("button", { name: "子代理（6）", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("navigation", { name: "子代理任务列表" }),
    ).toBeVisible();
    if (width > 1100) {
      await dialog.getByRole("button", { name: /Readonly task 6/ }).click();
      await page
        .getByRole("button", { name: "子代理（6）", exact: true })
        .click();
      await expect(
        dialog.getByRole("navigation", { name: "子代理任务列表" }),
      ).toBeVisible();
    }
    await page.unrouteAll({ behavior: "wait" });
  });
}
