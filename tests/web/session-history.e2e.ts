import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import type {
  WebSessionHistoryPage,
  WebSessionProjection,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function historyFixture(turnCount?: number, setupTurn = false) {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-history-browser-"));
  const manager = SessionManager.inMemory(cwd);
  const root = manager.appendMessage({
    role: "user",
    content: "Shared fixture root",
    timestamp: 1,
  });
  if (turnCount === undefined)
    manager.appendMessage({
      role: "user",
      content: "Original question unique to the old branch",
      timestamp: 2,
    });
  const assistant = (text: string, timestamp = Date.now()) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp,
    });
  if (turnCount !== undefined) {
    for (let index = 1; index <= turnCount; index++) {
      manager.appendMessage({
        role: "user",
        content: `History question ${index}`,
        timestamp: 42,
      });
      assistant(`History answer ${index}`, 42);
    }
  } else {
    for (let index = 0; index < 130; index++) {
      manager.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: `History progress ${index}.` },
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "bash",
            arguments: { command: `printf fixture-${index}` },
          },
        ],
        api: "openai-responses",
        provider: "fixture",
        model: "fixture",
        usage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "toolResult",
        toolName: "bash",
        toolCallId: `call-${index}`,
        content: [{ type: "text", text: `Fixture result ${index}` }],
        isError: false,
        timestamp: Date.now(),
      });
    }
    assistant("Latest fixture answer.");
  }
  const setupEntryId = setupTurn
    ? manager.appendCustomMessageEntry(
        "openpi-setup-request",
        "Apply a dark theme",
        true,
        { command: "openpi-setup", request: "Apply a dark theme" },
      )
    : undefined;
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: () => () => {},
    dispose: async () => {},
    sendPrompt: async (content) => {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
      host.publish("message_end", {
        sessionId: manager.getSessionId(),
        messageKey: "new-user",
        message: { role: "user", content },
      });
      return { pendingFollowUps: 0 };
    },
  };
  const host = new WebHost({ runtime });
  await host.start();
  return {
    host,
    manager,
    root,
    setupEntryId,
    assistant,
    async close() {
      await host.stop();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("prefetched native history loads on upward reading without moving the visible anchor", async ({
  browser,
}, testInfo) => {
  const fixture = await historyFixture();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const prefetched = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let historyReads = 0;
  try {
    await page.route("**/api/session/history?**", async (route) => {
      historyReads++;
      const response = await route.fetch();
      ready();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(fixture.host.origin);
    const conversation = page.locator(".conversation");
    await expect(conversation).toBeVisible();
    await expect(conversation.locator(".message-row.user")).toHaveCount(0);
    await prefetched;
    expect(historyReads).toBe(1);
    expect(
      await conversation.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    await conversation.hover();
    await page.mouse.wheel(0, -100_000);
    await expect(
      page.getByRole("status").filter({ hasText: "正在加载历史…" }),
    ).toBeVisible();
    const anchor = conversation
      .locator(".message-row.assistant.response")
      .first();
    const key = await anchor.getAttribute("data-history-entry");
    const before = await anchor.boundingBox();
    release();
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toHaveCount(1);
    const anchored = conversation.locator(`[data-history-entry="${key}"]`);
    await expect
      .poll(async () => Math.abs((await anchored.boundingBox())!.y - before!.y))
      .toBeLessThanOrEqual(2);
    const stableScroll = await conversation.evaluate(
      (element) => element.scrollTop,
    );
    const measureReading = () =>
      conversation.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const rows = Array.from(
          element.querySelectorAll<HTMLElement>("[data-history-entry]"),
        )
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return {
              key: row.dataset.historyEntry,
              top: rect.top - viewport.top,
              bottom: rect.bottom - viewport.top,
              height: rect.height,
            };
          })
          .filter((row) => row.height > 0 && row.bottom > 0)
          .slice(0, 3);
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          rows,
        };
      });
    const beforeLive = await measureReading();
    expect(stableScroll).toBeGreaterThan(0);
    expect(historyReads).toBe(1);
    fixture.host.publish("message_update", {
      sessionId: fixture.manager.getSessionId(),
      messageKey: "live-answer",
      message: {
        role: "assistant",
        content: "A new streamed answer is growing.",
      },
    });
    await expect(
      conversation.getByText("A new streamed answer is growing.", {
        exact: true,
      }),
    ).toHaveCount(1);
    const afterLive = await measureReading();
    await testInfo.attach("live-reading-geometry", {
      body: JSON.stringify({ beforeLive, afterLive }, null, 2),
      contentType: "application/json",
    });
    // The long single-turn fixture reaches the bottom while restoring its
    // prepended process. At the bottom, new content must remain followed.
    expect(
      Math.abs(
        beforeLive.scrollTop +
          beforeLive.clientHeight -
          beforeLive.scrollHeight,
      ),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        afterLive.scrollTop + afterLive.clientHeight - afterLive.scrollHeight,
      ),
    ).toBeLessThanOrEqual(2);

    await conversation.hover();
    await page.mouse.wheel(0, -1_000);
    await expect(page.getByRole("button", { name: "跳至最新" })).toBeVisible();
    await expect
      .poll(async () => {
        const measured = await measureReading();
        return (
          measured.scrollHeight - measured.clientHeight - measured.scrollTop
        );
      })
      .toBeGreaterThan(100);
    const readerBeforeLive = await measureReading();
    const visibleAnchor = readerBeforeLive.rows[0]!;
    const growingAnswer =
      "A new streamed answer is growing. More content arrives while reading older messages.";
    fixture.host.publish("message_update", {
      sessionId: fixture.manager.getSessionId(),
      messageKey: "live-answer",
      message: { role: "assistant", content: growingAnswer },
    });
    await expect(
      conversation.getByText(growingAnswer, { exact: true }),
    ).toHaveCount(1);
    const readerAfterLive = await measureReading();
    await testInfo.attach("older-reader-live-geometry", {
      body: JSON.stringify({ readerBeforeLive, readerAfterLive }, null, 2),
      contentType: "application/json",
    });
    expect(readerAfterLive.rows[0]?.key).toBe(visibleAnchor.key);
    expect(
      Math.abs(readerAfterLive.rows[0]!.top - visibleAnchor.top),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(readerAfterLive.scrollTop - readerBeforeLive.scrollTop),
    ).toBeLessThanOrEqual(2);
    const newLeaf = fixture.assistant(growingAnswer);
    const refresh = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/snapshot" &&
        url.searchParams.has("historyAnchor") &&
        response.ok() &&
        (await response.json()).selectedSession?.history?.leafEntryId ===
          newLeaf
      );
    });
    fixture.host.publish("message_end", {
      sessionId: fixture.manager.getSessionId(),
      messageKey: "live-answer",
      message: {
        role: "assistant",
        content: growingAnswer,
      },
    });
    const refreshed = await (await refresh).json();
    expect(refreshed.selectedSession.history.anchorOnBranch).toBe(true);
    await expect
      .poll(() => conversation.locator(".message-row.user").count())
      .toBe(2);
    await conversation.evaluate((element) =>
      element.scrollTo({ top: 0, behavior: "instant" }),
    );
    await expect(
      page.getByRole("button", { name: "加载更早的消息" }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("history-original-question-restored.png"),
    });
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("New user request while reading old history");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(
      conversation.getByText("New user request while reading old history", {
        exact: true,
      }),
    ).toBeInViewport();
  } finally {
    release();
    await context.close();
    await fixture.close();
  }
});

test("automatic native pages retain chronological turns with repeated provider timestamps", async ({
  browser,
}, testInfo) => {
  const fixture = await historyFixture(60);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let reads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/session/history") reads++;
  });
  try {
    await page.goto(fixture.host.origin);
    const conversation = page.locator(".conversation");
    const questions = conversation.locator(".message-row.user");
    const answers = conversation.locator(".message-row.assistant.response");
    const rowText = () =>
      conversation.locator(".message-row .message-content").allTextContents();
    const expected = (from: number) => [
      ...(from === 1 ? ["Shared fixture root"] : []),
      ...Array.from({ length: 61 - from }, (_, index) => [
        `History question ${from + index}`,
        `History answer ${from + index}`,
      ]).flat(),
    ];
    await expect(questions).toHaveCount(20);
    await expect(answers).toHaveCount(20);
    await expect.poll(rowText).toEqual(expected(41));
    await expect.poll(() => reads).toBe(1);
    for (const [from, count, requestCount] of [
      [21, 40, 2],
      [1, 60, 3],
    ]) {
      await conversation.hover();
      await page.mouse.wheel(0, -100_000);
      await expect(questions).toHaveCount(count + (from === 1 ? 1 : 0));
      await expect(answers).toHaveCount(count);
      await expect.poll(rowText).toEqual(expected(from));
      await expect.poll(() => reads).toBe(requestCount);
      const nativeIds = await conversation
        .locator(".message-row")
        .evaluateAll((rows) =>
          rows.map((row) => {
            const element = row as HTMLElement;
            return (
              element.dataset.historyMessage ?? element.dataset.historyEntry
            );
          }),
        );
      expect(nativeIds).toHaveLength(count * 2 + (from === 1 ? 1 : 0));
      expect(new Set(nativeIds).size).toBe(nativeIds.length);
    }
    await page.screenshot({
      path: testInfo.outputPath("history-chronological-native-pages.png"),
    });
  } finally {
    await context.close();
    await fixture.close();
  }
});

test("a late real history page cannot enter a different native branch", async ({
  browser,
}) => {
  const fixture = await historyFixture();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const read = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    await page.route("**/api/session/history?**", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      expect(
        payload.session.entries.some(
          (entry: { message?: { content?: string } }) =>
            entry.message?.content ===
            "Original question unique to the old branch",
        ),
      ).toBe(true);
      ready();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(fixture.host.origin);
    const conversation = page.locator(".conversation");
    await expect(conversation).toBeVisible();
    await read;
    fixture.manager.branch(fixture.root);
    fixture.manager.appendMessage({
      role: "user",
      content: "New branch question",
      timestamp: Date.now(),
    });
    fixture.assistant("New branch answer");
    fixture.host.publish("session_progress", {
      sessionId: fixture.manager.getSessionId(),
    });
    await expect(
      conversation.getByText("New branch question", { exact: true }),
    ).toBeVisible();
    release();
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("New branch answer", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("会话分支已更改，已切换到当前分支的历史。", {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    release();
    await context.close();
    await fixture.close();
  }
});

test("native turn rail indexes unloaded prompts, lazily previews, and reveals exact bounded windows", async ({
  browser,
}, testInfo) => {
  const fixture = await historyFixture(60, true);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const nativeIds = fixture.manager
      .getBranch()
      .flatMap((entry) =>
        (entry.type === "message" && entry.message.role === "user") ||
        (entry.type === "custom_message" &&
          entry.customType === "openpi-setup-request")
          ? [entry.id]
          : [],
      );
    const nativePrompt = (number: number) =>
      fixture.manager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.content === `History question ${number}`,
        )!.id;
    const opening = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/snapshot",
    );
    let previewReads = 0;
    let bodyReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/session/prompt-preview") previewReads++;
      if (path === "/api/session/message-window") bodyReads++;
    });
    await page.goto(fixture.host.origin);
    const initial = (await (await opening).json()) as WebSnapshot;
    const initialIds = initial.selectedSession!.entries.flatMap((entry) =>
      entry.message?.role === "user" ||
      entry.message?.customType === "openpi-setup-request"
        ? [entry.id]
        : [],
    );
    const conversation = page.locator(".conversation");
    const rail = page.getByRole("navigation", { name: "会话轮次" });
    const ticks = rail.locator(".turn-tick");
    const ids = () =>
      ticks.evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.turnEntry),
      );
    await expect(rail).toBeVisible();
    await expect.poll(ids).toEqual(nativeIds);
    expect(nativeIds).toHaveLength(62);
    expect(initialIds).toHaveLength(21);
    await expect(conversation.locator(".message-row.user")).toHaveCount(
      initialIds.length,
    );
    expect(bodyReads).toBe(0);
    expect(previewReads).toBe(0);
    const oldId = nativePrompt(5);
    const oldTick = rail.locator(`[data-turn-entry="${oldId}"]`);
    await expect(
      conversation.locator(`[data-history-entry="${oldId}"]`),
    ).toHaveCount(0);
    const idleWidth = (await rail.boundingBox())!.width;
    await oldTick.hover();
    await expect(page.locator(".turn-preview")).toHaveCount(1);
    await expect(page.locator(".turn-preview")).toContainText(
      "History question 5",
    );
    await expect(page.locator(".turn-preview")).toContainText(
      "History answer 5",
    );
    expect(previewReads).toBe(1);
    expect(bodyReads).toBe(0);
    expect(
      (await page.locator(".turn-preview-layer").boundingBox())!.width,
    ).toBeLessThanOrEqual(320);
    const previewBounds = (await page
      .locator(".turn-preview-layer")
      .boundingBox())!;
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(
      (await oldTick.boundingBox())!.x,
    );
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(
      (await rail.boundingBox())!.x,
    );
    expect((await rail.boundingBox())!.width).toBe(idleWidth);
    const initialCurrent = await rail
      .locator("[aria-current]")
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.turnEntry),
      );
    expect(initialCurrent).toContain(fixture.setupEntryId);
    expect(initialCurrent).not.toContain(oldId);
    await oldTick.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".turn-preview")).toHaveCount(0);
    await expect(oldTick).toBeFocused();
    await page.keyboard.press("Enter");
    const oldPrompt = conversation.locator(`[data-history-entry="${oldId}"]`);
    await expect(oldPrompt).toBeFocused();
    await expect(oldPrompt).toBeInViewport();
    await expect(
      conversation.getByText("History answer 5", { exact: true }),
    ).toBeVisible();
    await expect(oldTick).toHaveAttribute("aria-current", "location");
    expect(bodyReads).toBe(1);
    await expect.poll(ids).toEqual(nativeIds);
    const bodyIds = () =>
      conversation
        .locator(".message-row")
        .evaluateAll((rows) =>
          rows.map(
            (row) =>
              (row as HTMLElement).dataset.historyMessage ??
              (row as HTMLElement).dataset.historyEntry,
          ),
        );
    const before = await bodyIds();
    expect(new Set(before).size).toBe(before.length);
    fixture.host.publish("session_progress", {
      sessionId: fixture.manager.getSessionId(),
    });
    await expect.poll(bodyIds).toEqual(before);
    await expect(
      conversation.getByText("History answer 5", { exact: true }),
    ).toHaveCount(1);

    // A loaded click must cancel an earlier unloaded reveal, even though it
    // does not issue a second store navigation request.
    const distantId = nativePrompt(30);
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      ready = resolve;
    });
    await page.route("**/api/session/message-window?**", async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("entryId") !== distantId
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      ready();
      await delayed;
      await route.fulfill({ response }).catch(() => {});
    });
    await rail.locator(`[data-turn-entry="${distantId}"]`).click();
    await pending;
    await oldTick.click();
    await expect(oldPrompt).toBeFocused();
    release();
    await expect.poll(bodyIds).toEqual(before);
    await expect(oldPrompt).toBeFocused();

    // Focus can remain on turn 5 after bottom clamping while turn 3 is at the
    // reading edge. Establish a native prompt at the edge before testing its
    // keyboard neighbors; the keyboard follows geometry, not focused IDs.
    const thirdId = nativePrompt(3);
    const thirdPrompt = conversation.locator(
      `[data-history-entry="${thirdId}"]`,
    );
    const offset = (entryId: string) =>
      conversation.evaluate((root, id) => {
        const target = [
          ...root.querySelectorAll<HTMLElement>("[data-history-entry]"),
        ].find((item) => item.dataset.historyEntry === id)!;
        return (
          target.getBoundingClientRect().top - root.getBoundingClientRect().top
        );
      }, entryId);
    await rail.locator(`[data-turn-entry="${thirdId}"]`).click();
    await expect(thirdPrompt).toBeFocused();
    await expect
      .poll(async () => Math.abs((await offset(thirdId)) - 16))
      .toBeLessThanOrEqual(2);
    await page.keyboard.press("Alt+ArrowUp");
    const secondId = nativePrompt(2);
    await expect(
      conversation.locator(`[data-history-entry="${secondId}"]`),
    ).toBeFocused();
    await expect
      .poll(async () => Math.abs((await offset(secondId)) - 16))
      .toBeLessThanOrEqual(2);
    await page.keyboard.press("Alt+ArrowDown");
    await expect(thirdPrompt).toBeFocused();
    await expect
      .poll(async () => Math.abs((await offset(thirdId)) - 16))
      .toBeLessThanOrEqual(2);
    await expect(rail.locator("[aria-current]")).not.toHaveCount(0);

    const geometry = () =>
      page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(".conversation")!;
        const rail = document.querySelector<HTMLElement>(".turn-rail")!;
        const content = root.querySelector<HTMLElement>(".conversation-turn")!;
        const jump = document.querySelector<HTMLElement>(".jump-to-latest");
        const rect = (element: HTMLElement) => {
          const b = element.getBoundingClientRect();
          return {
            top: b.top,
            bottom: b.bottom,
            left: b.left,
            right: b.right,
            width: b.width,
            height: b.height,
          };
        };
        return {
          root: rect(root),
          rail: rect(rail),
          content: rect(content),
          jump: jump ? rect(jump) : null,
        };
      });
    const boxes = await geometry();
    expect(boxes.rail.width).toBe(36);
    expect(boxes.root.right - boxes.rail.right).toBeCloseTo(12, 0);
    expect(boxes.rail.left).toBeGreaterThanOrEqual(boxes.content.right);
    expect(boxes.rail.top).toBeGreaterThanOrEqual(boxes.root.top);
    expect(boxes.rail.bottom).toBeLessThanOrEqual(boxes.root.bottom);
    expect(boxes.rail.height).toBeLessThanOrEqual(Math.min(900 * 0.7, 640));
    if (boxes.jump)
      expect(boxes.rail.bottom).toBeLessThanOrEqual(boxes.jump.top - 12);
    await page.screenshot({
      path: testInfo.outputPath("native-codex-turn-rail.png"),
    });
    const chatWidth = (await conversation.boundingBox())!.width;
    await oldTick.hover();
    await expect(page.locator(".turn-preview")).toHaveCount(1);
    await page.setViewportSize({ width: 1600 - chatWidth + 840, height: 900 });
    await expect(rail).toBeHidden();
    await expect(page.locator(".turn-preview")).toHaveCount(0);
    const hidden = await geometry();
    expect(hidden.root.right - hidden.content.right).toBeLessThan(48);
    // A missing rail gutter does not hide the transcript. Establish the native
    // prompt at the reading edge after resize, then exercise real key events.
    await thirdPrompt.click();
    await thirdPrompt.evaluate((target) => {
      const root = target.closest<HTMLElement>(".conversation")!;
      root.scrollTop +=
        target.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        16;
      (target as HTMLElement).focus({ preventScroll: true });
    });
    await expect
      .poll(async () => Math.abs((await offset(thirdId)) - 16))
      .toBeLessThanOrEqual(2);
    await page.keyboard.press("Alt+ArrowUp");
    await expect(
      conversation.locator(`[data-history-entry="${secondId}"]`),
    ).toBeFocused();
    await expect
      .poll(async () => Math.abs((await offset(secondId)) - 16))
      .toBeLessThanOrEqual(2);
    await page.keyboard.press("Alt+ArrowDown");
    await expect(thirdPrompt).toBeFocused();
    await expect
      .poll(async () => Math.abs((await offset(thirdId)) - 16))
      .toBeLessThanOrEqual(2);
    await expect(rail).toBeHidden();
    await page.setViewportSize({ width: 2000, height: 900 });
    await page.getByRole("button", { name: "打开工具", exact: true }).click();
    await expect(page.locator(".workbar-panel")).toBeVisible();
    await expect(rail).toBeVisible();
    const workbar = await geometry();
    expect(workbar.rail.left).toBeGreaterThanOrEqual(workbar.content.right);
    expect(workbar.root.right - workbar.rail.right).toBeCloseTo(12, 0);
  } finally {
    release();
    await context.close();
    await fixture.close();
  }
});
