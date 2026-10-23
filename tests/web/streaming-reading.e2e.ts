import { expect, test } from "@playwright/test";
import type { WebLiveMessage, WebSnapshot } from "../../web/protocol/types.ts";

for (const width of [1280, 390]) {
  test(`tool execution identities survive bounded snapshots, event replay and refresh at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const call = {
      type: "toolCall" as const,
      id: "build-once",
      name: "bash",
      arguments: '{"command":"pnpm run check"}',
    };
    const assistant: WebLiveMessage = {
      role: "assistant",
      timestamp: 1,
      content: "",
      parts: [{ type: "thinking", text: "核对执行结果。" }, call],
      stopReason: "toolUse",
    };
    const result: WebLiveMessage = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: call.id,
      content: "Check passed.\n".repeat(100),
      isError: false,
    };
    let owner = { id: "", path: "" };
    let delivered = false;
    const finalMessage: WebLiveMessage = {
      role: "assistant",
      content: "实时回执已同步。",
      timestamp: 2,
      stopReason: "stop",
    };
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as WebSnapshot;
      const session = snapshot.selectedSession;
      if (!session) throw new Error("Missing Session fixture");
      owner = session;
      snapshot.cursor = delivered ? 105 : 100;
      snapshot.preferences = { ...snapshot.preferences, theme: "light" };
      snapshot.runtime = {
        ...snapshot.runtime,
        status: "idle",
        activeTurn: undefined,
        liveTools: [],
      };
      snapshot.selectedExecution = {
        sessionId: session.id,
        sessionPath: session.path,
        status: "idle",
        liveTools: [],
        liveToolsOmitted: 0,
      };
      session.history = undefined;
      const entry = (id: string, message: WebLiveMessage) => ({
        id,
        type: "message" as const,
        timestamp: "2026-10-22T00:00:00Z",
        message,
      });
      session.entries = [
        entry("prompt", {
          role: "user",
          content: "核对工具列表，保留真实的第二次执行。",
        }),
        entry("call-1", {
          ...assistant,
          parts: [call],
          truncation: { truncated: true },
        }),
        entry("result-1", {
          ...result,
          content: "Check passed.…",
          truncation: { truncated: true, text: true },
        }),
        entry("call-2", {
          ...assistant,
          parts: [{ ...call, id: "build-again" }],
        }),
        entry("result-2", { ...result, toolCallId: "build-again" }),
      ];
      // A completed event must survive the canonical snapshot used after EOF
      // and reload; an indefinitely stale snapshot makes reconnect timing the
      // subject of this tool-identity test instead of native persistence.
      if (delivered) session.entries.push(entry("final", finalMessage));
      await route.fulfill({ response, json: snapshot });
    });
    await page.route("**/events?**", (route) => {
      delivered = true;
      return route.fulfill({
        contentType: "text/event-stream",
        body: [assistant, result, assistant, result, finalMessage]
          .map((message, index) => {
            const event = {
              protocolVersion: 1,
              sequence: 101 + index,
              timestamp: "2026-10-22T00:00:01Z",
              type: "message_end",
              detail: {
                sessionId: owner.id,
                sessionPath: owner.path,
                messageKey: `replay-${index}`,
                message,
              },
            };
            return `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
          })
          .join(""),
      });
    });
    await page.goto("/");
    const tools = page.locator('.tool-evidence-card[data-tool="bash"]');
    await expect(
      page.getByText("实时回执已同步。", { exact: true }),
    ).toBeVisible();
    await expect(tools).toHaveCount(2);
    await expect(page.locator(".process-sequence.running")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText("实时回执已同步。", { exact: true }),
    ).toBeVisible();
    await expect(tools).toHaveCount(2);
    await page.locator(".process-sequence > summary").click();
    await page.evaluate(() => document.fonts.ready);
    await expect(tools.first()).toBeVisible();
    await expect(tools.last()).toBeInViewport({ ratio: 1 });
    await page
      .locator(".conversation")
      .screenshot({ path: testInfo.outputPath(`tool-replay-${width}.png`) });
  });
}

for (const width of [1280, 390]) {
  test(`streaming updates preserve the history reader at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let expanded = false;
    await page.route("**/events?**", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      }),
    );
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as WebSnapshot;
      if (!snapshot.selectedSession) throw new Error("Missing Session fixture");
      snapshot.preferences = { ...snapshot.preferences, theme: "light" };
      snapshot.runtime = {
        ...snapshot.runtime,
        status: "running",
        activeTurn: undefined,
      };
      snapshot.selectedExecution = {
        sessionId: snapshot.selectedSession.id,
        sessionPath: snapshot.selectedSession.path,
        status: "running",
        liveTools: [],
        liveToolsOmitted: 0,
      };
      snapshot.selectedSession.history = undefined;
      snapshot.selectedSession.entries = Array.from(
        { length: 16 },
        (_, index) => ({
          id: `reading-${index}`,
          type: "message" as const,
          timestamp: `2026-10-22T00:00:${String(index).padStart(2, "0")}Z`,
          message: {
            role: index % 2 ? "assistant" : "user",
            content:
              index % 2
                ? `回答 ${index}\n\n${"历史内容保持稳定，方便继续阅读。\n\n".repeat(12)}${expanded && index === 1 ? "较早的内容更新。\n\n".repeat(20) : ""}${index === 15 && expanded ? "新的流式输出已到达。" : ""}`
                : `问题 ${index}：检查阅读位置。`,
          },
        }),
      );
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto("/");
    const root = page.locator(".conversation");
    const anchor = root.locator('[data-history-message="reading-9"]');
    await expect(anchor).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await root.hover();
    await page.mouse.wheel(0, -400);
    await anchor.evaluate((element) => {
      const root = element.closest<HTMLElement>(".conversation")!;
      root.scrollTop +=
        element.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        24;
      root.dispatchEvent(new Event("scroll"));
    });
    const offset = () =>
      anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest(".conversation")!.getBoundingClientRect().top,
      );
    await expect.poll(offset).toBeCloseTo(24, 0);
    await page.evaluate(() => {
      const state = window as Window & {
        readingOffsets?: number[];
        stopReadingSamples?: boolean;
      };
      state.readingOffsets = [];
      state.stopReadingSamples = false;
      const sample = () => {
        const anchor = document.querySelector(
          '[data-history-message="reading-9"]',
        )!;
        state.readingOffsets!.push(
          anchor.getBoundingClientRect().top -
            anchor.closest(".conversation")!.getBoundingClientRect().top,
        );
        if (!state.stopReadingSamples) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    expanded = true;
    await expect(
      root.getByText("新的流式输出已到达。", { exact: false }),
    ).toHaveCount(1);
    await expect.poll(offset).toBeCloseTo(24, 0);
    const samples = await page.evaluate(() => {
      const state = window as Window & {
        readingOffsets?: number[];
        stopReadingSamples?: boolean;
      };
      state.stopReadingSamples = true;
      return state.readingOffsets!;
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(
      Math.max(...samples.map((value) => Math.abs(value - 24))),
    ).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "跳至最新" })).toBeVisible();
    await root.screenshot({
      path: testInfo.outputPath(`streaming-history-${width}.png`),
    });
    await page.getByRole("button", { name: "跳至最新" }).click();
    await expect
      .poll(() =>
        root.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(2);
  });
}
