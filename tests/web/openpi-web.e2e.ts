import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, type Page, test } from "@playwright/test";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
} from "./thinking-e2e-support.ts";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authenticatedPath = "/";

for (const width of [1280, 390]) {
  test(`message editing and composer resizing preserve readable layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/events?**", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      }),
    );
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.selectedSession.entries = [
        {
          id: "layout-user",
          type: "message",
          timestamp: "2026-09-18T00:00:00Z",
          message: { role: "user", content: "Original message ".repeat(30) },
        },
        {
          id: "layout-assistant",
          type: "message",
          timestamp: "2026-09-18T00:00:01Z",
          message: {
            role: "assistant",
            content: Array.from(
              { length: 50 },
              (_, index) => `Paragraph ${index + 1}`,
            ).join("\n\n"),
          },
        },
      ];
      await route.fulfill({ response, json: snapshot });
    });
    await openWorkbench(page);
    const conversation = page.getByRole("log", { name: "Conversation" });
    const input = page.getByRole("textbox", { name: "描述任务" });
    const bottomGap = () =>
      conversation.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect.poll(bottomGap).toBeLessThan(2);
    await input.fill(
      Array.from({ length: 14 }, (_, index) => `Draft line ${index}`).join(
        "\n",
      ),
    );
    await expect.poll(bottomGap).toBeLessThan(2);
    await input.fill("");
    await expect.poll(bottomGap).toBeLessThan(2);
    await conversation.evaluate((el) => {
      // Establish a reading position, rather than starting the stylesheet's
      // smooth-scroll animation while a resize notification is still pending.
      el.scrollTo({ top: 120, behavior: "instant" });
    });
    await expect
      .poll(() => conversation.evaluate((el) => el.scrollTop))
      .toBe(120);
    await input.fill("Reading history\n".repeat(12));
    await expect
      .poll(() => conversation.evaluate((el) => el.scrollTop))
      .toBe(120);
    await input.fill("");
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑消息", exact: true });
    await expect(editor).toBeVisible();
    await expect(page.locator(".message-row.user .message-body")).toBeHidden();
    const dimensions = await page.locator(".message-editor").evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      rowWidth: el.parentElement!.getBoundingClientRect().width,
      right: el.getBoundingClientRect().right,
      viewport: document.documentElement.clientWidth,
    }));
    expect(dimensions.width).toBeGreaterThan(
      Math.min(600, dimensions.rowWidth - 2),
    );
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
    await editor.fill("Cancelled edit");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    await expect(editor).toHaveValue("Original message ".repeat(30));
  });
}

for (const width of [1280, 390]) {
  test(`long code blocks copy cleanly without widening the page at ${width}px`, async ({
    page,
  }, testInfo) => {
    const source = [
      'const messages = ["开始处理", "处理中", "处理完成"];',
      'const greeting = "你好，OpenPI";',
      'const longLine = "' + "long-code-value-".repeat(20) + '\";',
      "console.log(messages, greeting, longLine);",
    ].join("\n");
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText(text: string) {
            (
              window as Window & {
                __openPiCopiedCode?: string;
              }
            ).__openPiCopiedCode = text;
            return Promise.resolve();
          },
        },
      });
    });
    await page.route("**/events?**", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      }),
    );
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.selectedSession.entries = [
        {
          id: "code-assistant",
          type: "message",
          timestamp: "2026-09-19T00:00:00Z",
          message: {
            role: "assistant",
            content: `Use \`inlineCode\` here.\n\n\`\`\`ts\n${source}\n\`\`\``,
          },
        },
      ];
      await route.fulfill({ response, json: snapshot });
    });
    await openWorkbench(page);

    const block = page.locator(".markdown-code-block");
    const copy = page.getByRole("button", { name: "复制代码", exact: true });
    await expect(block).toHaveCount(1);
    await expect(copy).toBeVisible();
    await expect
      .poll(() =>
        block.evaluate((element) => {
          const scroll = element.querySelector(".markdown-code-scroll");
          return scroll ? scroll.scrollWidth - scroll.clientWidth : 0;
        }),
      )
      .toBeGreaterThan(0);
    const dimensions = await block.evaluate((element) => {
      const scroll = element.querySelector(".markdown-code-scroll");
      const button = element.querySelector("button");
      const bounds = element.getBoundingClientRect();
      const buttonBounds = button?.getBoundingClientRect();
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        blockRight: bounds.right,
        buttonRight: buttonBounds?.right ?? Number.POSITIVE_INFINITY,
        preClientWidth: scroll?.clientWidth ?? 0,
        preScrollWidth: scroll?.scrollWidth ?? 0,
      };
    });
    expect(dimensions.pageWidth).toBeLessThanOrEqual(width);
    expect(dimensions.blockRight).toBeLessThanOrEqual(width);
    expect(dimensions.buttonRight).toBeLessThanOrEqual(width);
    expect(dimensions.preScrollWidth).toBeGreaterThan(
      dimensions.preClientWidth,
    );

    const scroll = page.locator(".markdown-code-scroll");
    await scroll.focus();
    await expect(scroll).toHaveCSS("outline-style", "solid");
    await expect(scroll).toHaveCSS("outline-width", "2px");
    for (let index = 0; index < 8; index++) await scroll.press("ArrowRight");
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);

    await copy.click();
    await expect(
      page.getByRole("button", { name: "代码已复制", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __openPiCopiedCode?: string;
            }
          ).__openPiCopiedCode,
      ),
    ).toBe(`${source}\n`);
    expect(
      (await new AxeBuilder({ page }).include(".markdown-code-block").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`code-block-${width}.png`),
    });
  });
}

for (const viewport of [
  { width: 768, height: 1024, label: "tablet" },
  { width: 640, height: 500, label: "effective 200% of 1280x1000" },
] as const) {
  test(`composer remains reachable at ${viewport.width}px (${viewport.label})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    let admissions = 0;
    await page.route("**/api/prompt", (route) => {
      admissions++;
      return route.abort();
    });
    await openWorkbench(page);
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("组合输入");
    await input.evaluate((element) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    expect(admissions).toBe(0);
    await expect(input).toHaveValue("组合输入");
    await input.evaluate((element) =>
      element.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("组合输入\n");
    await input.fill("多行草稿\n".repeat(12));
    const send = page.getByRole("button", { name: "发送", exact: true });
    await expect(send).toBeVisible();
    const bounds = await send.boundingBox();
    expect(bounds?.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`composer-${viewport.width}.png`),
    });
    expect(admissions).toBe(0);
  });
}

test("provider failures remain visible after refresh without discarding partial text", async ({
  page,
}, testInfo) => {
  let content = "";
  let stopReason: "error" | "aborted" = "error";
  const retried: string[] = [];
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.selectedSession.entries = [
      {
        id: "failed-user",
        type: "message",
        timestamp: "2026-09-18T00:00:00Z",
        message: { role: "user", content: "Question" },
      },
      {
        id: "failed-assistant",
        type: "message",
        timestamp: "2026-09-18T00:00:01Z",
        message: {
          role: "assistant",
          content,
          stopReason,
          ...(stopReason === "error"
            ? { errorMessage: "gateway_concurrency_limit (429)" }
            : {}),
        },
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/prompt", async (route) => {
    const body = route.request().postDataJSON() as { content: string };
    retried.push(body.content);
    await route.fulfill({ json: { id: "provider-retry", accepted: true } });
  });
  await openWorkbench(page);
  await expect(page.getByRole("alert")).toContainText(
    "gateway_concurrency_limit (429)",
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "重试消息" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`provider-retry-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "重试消息" }).click();
  await expect.poll(() => retried).toEqual(["Question"]);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "gateway_concurrency_limit (429)",
  );
  content = "Partial answer";
  await page.reload();
  await expect(page.getByText("Partial answer")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "gateway_concurrency_limit (429)",
  );
  stopReason = "aborted";
  await page.reload();
  await expect(page.getByText("Partial answer")).toBeVisible();
  await expect(page.getByText("模型请求已停止")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function openWorkbench(page: Page) {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      url.origin !== "http://127.0.0.1:57109"
    ) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(authenticatedPath, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "描述任务" })).toBeVisible();
  return externalRequests;
}

async function dragPane(page: Page, side: "left" | "right", deltaX: number) {
  const handle = page.locator(`[data-pane-resizer="${side}"]`);
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + Math.min(120, bounds!.height / 2);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, y, { steps: 8 });
  await page.mouse.up();
}

async function openWorkbarTool(page: Page, name: string) {
  await page.locator(".task-tools-trigger").click();
  const workbar = page.locator(".workbar-panel");
  await expect(workbar).toBeVisible();
  const existingTab = workbar
    .locator(".workbar-tab > button:first-child")
    .filter({ hasText: name });
  if (await existingTab.isVisible().catch(() => false)) {
    await existingTab.click();
  } else {
    await workbar
      .getByRole("button", { name: new RegExp(`^${name}`, "u") })
      .click();
  }
  return workbar;
}

test("desktop panes resize by pointer and collapse beyond their thresholds", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  const sidebar = page.locator(".session-sidebar");
  const conversation = page.locator(".conversation-shell");
  const initialSidebar = await sidebar.boundingBox();
  const initialConversation = await conversation.boundingBox();
  expect(initialSidebar).not.toBeNull();
  expect(initialConversation).not.toBeNull();

  const sidebarHandle = page.getByRole("separator", { name: "调整侧边栏宽度" });
  await sidebarHandle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebarHandle).toHaveAttribute("aria-valuenow", "296");
  await expect(sidebar).toHaveCSS("width", "296px");
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveCSS("width", "280px");

  await dragPane(page, "left", 80);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialSidebar!.width + 60);
  await expect
    .poll(async () => (await conversation.boundingBox())?.width ?? 0)
    .toBeLessThan(initialConversation!.width - 60);

  await dragPane(page, "left", -240);
  await expect(sidebar).toHaveCSS("width", "56px");
  await expect(page.locator('[data-pane-resizer="left"]')).toHaveCount(0);
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();

  const workbar = await openWorkbarTool(page, "生成文件");
  const workbarHandle = page.getByRole("separator", { name: "调整工具栏宽度" });
  await workbarHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(workbarHandle).toHaveAttribute("aria-valuenow", "536");
  await page.keyboard.press("Enter");
  await expect(workbarHandle).toHaveAttribute("aria-valuenow", "520");
  const centerBeforeRightDrag = await conversation.boundingBox();
  await dragPane(page, "right", -70);
  await expect
    .poll(async () => (await conversation.boundingBox())?.width ?? 0)
    .toBeLessThan(centerBeforeRightDrag!.width - 50);

  await dragPane(page, "right", -360);
  await expect(conversation).toBeHidden();
  await expect(workbar).toBeVisible();
  await expect(page.locator('[data-pane-resizer="right"]')).toHaveCount(0);
  await workbar.getByRole("button", { name: "恢复会话", exact: true }).click();
  await expect(conversation).toBeVisible();
  await expect(page.locator('[data-pane-resizer="right"]')).toHaveCount(1);

  await dragPane(page, "right", 420);
  await expect(workbar).toBeHidden();
  await expect(page.locator('[data-pane-resizer="right"]')).toHaveCount(0);
});

test("refreshing an open diff preserves the draft and composer focus", async ({
  page,
}) => {
  let refreshed = false;
  await page.route("**/api/git-review?**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        snapshot: {
          repositoryRoot: "/workspace",
          currentBranch: "main",
          baseBranch: null,
          comparison: "session",
          revision: refreshed ? "new" : "old",
          additions: 1,
          deletions: 0,
          truncated: false,
          files: [
            {
              path: "focus-note.txt",
              status: "untracked",
              additions: 1,
              deletions: 0,
              diff: `@@ -0,0 +1 @@\n+${refreshed ? "refreshed" : "original"}`,
              diffTruncated: false,
            },
          ],
        },
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  const workbar = await openWorkbarTool(page, "变更");
  await workbar
    .getByRole("button", { name: "focus-note.txt", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "描述任务" });
  await input.fill("Keep editing this draft");
  refreshed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(workbar.getByRole("figure")).toContainText("refreshed");
  await expect(input).toBeFocused();
  await input.press("End");
  await input.pressSequentially(" safely");
  await expect(input).toHaveValue("Keep editing this draft safely");
});

test("file reference validation can be cancelled without changing the draft", async ({
  page,
}) => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/artifacts/resolve", async (route) => {
    started();
    await pending;
    await route
      .fulfill({ status: 503, json: { error: "fixture unavailable" } })
      .catch(() => {});
  });
  try {
    await openWorkbench(page);
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("Keep this draft");
    await page.getByRole("button", { name: "添加上下文", exact: true }).click();
    await page.getByRole("menuitem", { name: /引用工作区文件/u }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("README.md");
    await dialog.getByRole("button", { name: "插入引用" }).click();
    await requested;
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(input).toHaveValue("Keep this draft");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("workbar exposes five tools and completes a side conversation lifecycle", async ({
  page,
}) => {
  type SideAction = {
    sessionId: string;
    kind: "subagents";
    action: "spawn-btw" | "send-btw" | "cancel-btw";
    prompt?: string;
    id?: string;
    text?: string;
  };
  const actions: SideAction[] = [];
  const turns: Array<{ question: string; answer: string }> = [];
  let status: "running" | "done" = "running";
  const detail = () => ({
    kind: "subagents" as const,
    id: "btw-e2e",
    title: "Focused side question",
    origin: "btw" as const,
    status,
    ...(status === "done"
      ? { outcome: "interrupted" as const, settledAt: 2 }
      : {}),
    createdAt: 1,
    cwd: "/workspace",
    model: "fixture/model",
    prompt: turns[0]?.question ?? "",
    transcript: turns.flatMap((turn) => [
      { kind: "user" as const, text: turn.question },
      {
        kind: "assistant" as const,
        parts: [{ type: "text" as const, text: turn.answer }],
      },
    ]),
    liveTools: [],
    finalText: turns.at(-1)?.answer ?? "",
    truncated: false,
    omittedEntries: 0,
  });
  await page.route("**/api/capabilities/action", async (route) => {
    const action = route.request().postDataJSON() as SideAction;
    actions.push(action);
    if (action.action === "spawn-btw") {
      turns.push({
        question: action.prompt ?? "",
        answer: "Side response",
      });
    } else if (action.action === "send-btw") {
      turns.push({
        question: action.text ?? "",
        answer: "Follow-up response",
      });
    } else {
      status = "done";
    }
    await route.fulfill({
      json: { sessionId: action.sessionId, detail: detail() },
    });
  });
  await page.route("**/api/capabilities/detail?**", async (route) => {
    const sessionId = new URL(route.request().url()).searchParams.get(
      "sessionId",
    );
    await route.fulfill({ json: { sessionId, detail: detail() } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await page.getByRole("button", { name: "打开工具", exact: true }).click();
  const launcher = page.locator(".workbar-panel");
  const launcherButtons = launcher.locator(".workbar-launcher-list > button");
  await expect(launcherButtons).toHaveCount(5);
  expect(await launcherButtons.locator("strong").allTextContents()).toEqual([
    "侧边对话",
    "变更",
    "终端",
    "浏览器",
    "生成文件",
  ]);
  await launcher.getByRole("button", { name: /^变更/u }).click();
  const review = launcher.locator(".review-panel");
  await expect(review).toBeVisible();
  await launcher
    .getByRole("button", { name: "关闭 变更", exact: true })
    .click();
  await expect(launcher.locator(".workbar-launcher-list")).toBeVisible();

  const workbar = await openWorkbarTool(page, "侧边对话");
  const question = workbar.getByPlaceholder("提出一个侧边问题…");
  await question.fill("Inspect this in isolation");
  await question.press("Enter");
  await expect(workbar.getByText("Side response")).toBeVisible();
  await expect
    .poll(() => actions.map((action) => action.action))
    .toEqual(["spawn-btw"]);

  const followUp = workbar.getByPlaceholder("继续追问…");
  await followUp.fill("Check one more detail");
  await followUp.press("Enter");
  await expect(workbar.getByText("Follow-up response")).toBeVisible();
  await expect
    .poll(() => actions.map((action) => action.action))
    .toEqual(["spawn-btw", "send-btw"]);
  await workbar.getByRole("button", { name: "停止", exact: true }).click();
  await expect
    .poll(() => actions.map((action) => action.action))
    .toEqual(["spawn-btw", "send-btw", "cancel-btw"]);
  await expect(workbar.getByRole("button", { name: "停止" })).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).include(".workbar-panel").analyze())
      .violations,
  ).toEqual([]);
});

test("terminal tool runs a real workspace shell", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await openWorkbarTool(page, "终端");
  const terminal = page.locator(".interactive-terminal");
  await expect(terminal.locator(".terminal-status-dot.ready")).toBeVisible();
  const input = terminal.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("printf 'OPENPI_WEB_TERMINAL_OK\\n'");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => terminal.locator(".xterm-rows").textContent())
    .toContain("OPENPI_WEB_TERMINAL_OK");
});

test("browser tool keeps an interactive page inside the workbar", async ({
  page,
}) => {
  type BrowserState = {
    sessionId: string;
    url: string;
    title: string;
    width: number;
    height: number;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  };
  let launch:
    | { sessionId: string; url: string; width: number; height: number }
    | undefined;
  let browserState: BrowserState | undefined;
  const actions: Array<{ action: string }> = [];
  await page.route("**/api/browser/open", async (route) => {
    launch = route.request().postDataJSON();
    browserState = {
      sessionId: launch!.sessionId,
      url: launch!.url,
      title: "Example Domain",
      width: launch!.width,
      height: launch!.height,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    await route.fulfill({ json: browserState });
  });
  await page.route("**/api/browser/state?**", async (route) => {
    if (!browserState) {
      await route.fulfill({
        status: 404,
        json: { error: "Browser is not open" },
      });
      return;
    }
    await route.fulfill({ json: browserState });
  });
  await page.route("**/api/browser/action", async (route) => {
    const action = route.request().postDataJSON() as {
      action: string;
      width?: number;
      height?: number;
    };
    actions.push(action);
    if (browserState && action.action === "resize") {
      browserState = {
        ...browserState,
        width: action.width ?? browserState.width,
        height: action.height ?? browserState.height,
      };
    }
    await route.fulfill({ json: browserState });
  });
  await page.route("**/api/browser/frame?**", (route) =>
    route.fulfill({
      contentType: "image/jpeg",
      body: Buffer.from(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
        "base64",
      ),
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  const workbar = await openWorkbarTool(page, "浏览器");
  await workbar
    .getByRole("textbox", { name: "浏览器地址" })
    .fill("example.com");
  await workbar.getByRole("button", { name: "打开地址" }).click();
  await expect(
    workbar.locator(".browser-viewport img[alt='Example Domain']"),
  ).toBeVisible();
  await expect(workbar.locator("iframe")).toHaveCount(0);
  expect(launch?.url).toBe("https://example.com/");
  expect(launch?.sessionId).toBeTruthy();
  expect(launch?.width).toBeGreaterThanOrEqual(320);
  expect(launch?.height).toBeGreaterThanOrEqual(240);
  await dragPane(page, "right", -70);
  await expect
    .poll(() => actions.some((action) => action.action === "resize"))
    .toBe(true);

  await workbar.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(workbar).toBeHidden();
  await page.locator(".task-tools-trigger").click();
  await expect(workbar).toBeVisible();
  await expect(
    workbar.locator(".browser-viewport img[alt='Example Domain']"),
  ).toBeVisible();
});

test("composer sends staged image data with the prompt", async ({ page }) => {
  let admission:
    | {
        content: string;
        images?: Array<{ data: string; mimeType: string }>;
      }
    | undefined;
  await page.route("**/api/prompt", async (route) => {
    admission = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      json: { id: "image-prompt", accepted: true },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await page.locator(".composer input[type=file]").setInputFiles({
    name: "sample.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.locator(".composer-attachment")).toContainText(
    "sample.png",
  );
  await page.getByRole("textbox", { name: "描述任务" }).fill("Inspect this");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => admission).toBeTruthy();
  expect(admission?.content).toBe("Inspect this");
  expect(admission?.images).toHaveLength(1);
  expect(admission?.images?.[0]?.mimeType).toBe("image/png");
  expect(admission?.images?.[0]?.data).toMatch(/^iVBOR/u);
});

test("sidebar settings stays open after an OpenPI configuration request", async ({
  page,
}) => {
  let request = "";
  await page.route("**/api/prompt", async (route) => {
    request = (route.request().postDataJSON() as { content: string }).content;
    await route.fulfill({
      status: 202,
      json: { id: "settings-request", accepted: true },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkbench(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await settings
    .getByRole("button", { name: "配置 OpenPI", exact: true })
    .click();
  await expect(settings).toBeVisible();
  await expect(settings.getByText("配置请求已接收。")).toBeVisible();
  expect(request).toBe("/openpi-setup 和我一起检查全部 OpenPI 配置项");
});

test("production workbench is local, keyboard-operable, and accessible", async ({
  page,
}) => {
  const externalRequests = await openWorkbench(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "新会话" }),
  ).toBeAttached();
  await expect(page.locator('script[src*="@vite/client"]')).toHaveCount(0);
  await expect.poll(() => externalRequests).toEqual([]);

  const logo = page.getByRole("button", {
    name: "Replay OpenPI logo animation",
  });
  await logo.click();
  await expect
    .poll(
      () =>
        logo
          .locator(".pixel-mark i")
          .first()
          .evaluate((node) => getComputedStyle(node).opacity),
      { timeout: 1_500 },
    )
    .not.toBe("0");

  const thinkingPicker = page.locator(".thinking-picker");
  await expect(thinkingPicker).toBeVisible();
  expect(
    await page.evaluate(() => {
      const model = document.querySelector(".model-picker");
      const thinking = document.querySelector(".thinking-picker");
      if (!model || !thinking) return null;
      return {
        sameToolbar: Boolean(
          model.closest(".composer-toolbar") &&
            thinking.closest(".composer-toolbar"),
        ),
        thinkingAfterModel: Boolean(
          model.compareDocumentPosition(thinking) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    }),
  ).toEqual({ sameToolbar: true, thinkingAfterModel: true });

  const workspaceMenu = page.getByRole("button", {
    name: "Workspace options",
  });
  await workspaceMenu.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Workspace options" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const width = await page.evaluate(() => ({
    client: document.body.clientWidth,
    scroll: document.body.scrollWidth,
  }));
  expect(width.scroll).toBe(width.client);

  const turnRailLayout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".conversation-shell");
    const conversation = document.querySelector<HTMLElement>(".conversation");
    if (!shell || !conversation)
      throw new Error("conversation shell is missing");
    const turn = document.createElement("section");
    turn.className = "conversation-turn";
    const rail = document.createElement("nav");
    rail.className = "turn-rail";
    conversation.append(turn);
    shell.append(rail);
    const turnRect = turn.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    turn.remove();
    rail.remove();
    return {
      gutter: shellRect.right - railRect.right,
      turnRight: turnRect.right,
      railLeft: railRect.left,
    };
  });
  expect(turnRailLayout.gutter).toBeCloseTo(24, 0);
  expect(turnRailLayout.railLeft).toBeGreaterThanOrEqual(
    turnRailLayout.turnRight,
  );
});

for (const theme of ["light", "dark"]) {
  test(`compact navigation preserves controls and drawer layout in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.preferences = { ...snapshot.preferences, theme };
      await route.fulfill({ json: snapshot });
    });
    await openWorkbench(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const sidebar = page.locator(".session-sidebar");
    const current = sidebar.getByRole("button", { name: "当前", exact: true });
    const archived = sidebar.getByRole("button", {
      name: "已归档",
      exact: true,
    });
    const create = sidebar.getByRole("button", {
      name: "新建会话",
      exact: true,
    });
    await archived.click();
    await expect(sidebar.locator(".sidebar-scope-note").first()).toBeVisible();
    await sidebar.getByRole("button", { name: "收起侧边栏" }).click();
    const expand = page.getByRole("button", { name: "展开侧边栏" });
    await expect(expand).toBeVisible();
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute("title", "新建会话");
    await expect(current).toBeHidden();
    await expect(archived).toBeHidden();
    await expect(sidebar.locator(".sidebar-scope-note").first()).toBeHidden();
    await expect(sidebar.locator(".workspace-tree")).toBeHidden();
    await expect(sidebar).toHaveCSS("width", "56px");
    const createBox = await create.boundingBox();
    const expandBox = await expand.boundingBox();
    if (!createBox || !expandBox) throw new Error("rail actions are missing");
    expect(createBox.width).toBe(40);
    expect(createBox.height).toBe(40);
    expect(createBox.y - expandBox.y - expandBox.height).toBe(8);
    expect(Math.abs(createBox.x - expandBox.x)).toBeLessThanOrEqual(1);
    await create.focus();
    await expect(create).toBeFocused();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`rail-${theme}.png`),
      animations: "disabled",
    });

    await expand.click();
    await expect(archived).toHaveAttribute("aria-pressed", "true");
    await expect(sidebar.locator(".sidebar-scope-note").first()).toBeVisible();
    await current.click();
    await sidebar.getByRole("button", { name: "收起侧边栏" }).click();
    await expect(sidebar.locator(".session-view-switch")).toBeHidden();

    // Carry the desktop collapsed state across the responsive boundary.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "打开侧边栏" }).click();
    await expect(current).toBeVisible();
    await expect(sidebar.locator(".sidebar-brand")).toBeVisible();
    await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
    const brand = await sidebar.locator(".brand-lockup").boundingBox();
    const drawer = await sidebar.boundingBox();
    if (!brand || !drawer) throw new Error("drawer brand is missing");
    expect(brand.x).toBeGreaterThanOrEqual(drawer.x);
    expect(brand.x + brand.width).toBeLessThanOrEqual(drawer.x + drawer.width);
    await page.screenshot({ path: testInfo.outputPath(`drawer-${theme}.png`) });
    await sidebar.getByRole("button", { name: "收起侧边栏" }).click();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
    const switcher = page.locator(".conversation-view-switch");
    const switchBox = await switcher.boundingBox();
    const buttons = await switcher.locator("button").all();
    const buttonBoxes = await Promise.all(
      buttons.map((button) => button.boundingBox()),
    );
    const contentWidth = buttonBoxes.reduce(
      (sum, box) => sum + (box?.width ?? 0),
      0,
    );
    expect(switchBox?.width).toBeLessThanOrEqual(contentWidth + 16);
    await page.screenshot({
      path: testInfo.outputPath(`navigation-${theme}.png`),
    });
  });
}

test("discovers and completes Pi commands without submitting unsupported commands", async ({
  page,
}) => {
  let commandReads = 0;
  const prompts: unknown[] = [];
  await page.route("**/api/commands?**", async (route) => {
    commandReads++;
    expect(
      new URL(route.request().url()).searchParams.get("sessionId"),
    ).toBeTruthy();
    await route.fulfill({
      status: 200,
      json: {
        commands: [
          {
            name: "extension:setup",
            description: "Configure the package",
            source: "extension",
            availability: "unsupported",
          },
          {
            name: "review",
            description: "Review the current change",
            source: "prompt",
            availability: "available",
            argumentHint: "[arguments]",
          },
          {
            name: "release",
            description: "Prepare a release",
            source: "skill",
            availability: "available",
            argumentHint: "[arguments]",
          },
          {
            name: "analyze",
            description: "Analyze the current change",
            source: "prompt",
            availability: "available",
          },
          {
            name: "deploy",
            description: "Prepare a deployment",
            source: "skill",
            availability: "available",
          },
          {
            name: "inspect",
            description: "Inspect the workspace",
            source: "prompt",
            availability: "available",
          },
          {
            name: "optimize",
            description: "Optimize the implementation",
            source: "skill",
            availability: "available",
          },
        ],
        totalAvailable: 7,
        truncation: {
          truncated: false,
          commandsOmitted: 0,
          maxCommands: 250,
          maxBytes: 65_536,
          bytes: 512,
        },
      },
    });
  });
  await page.route("**/api/prompt", async (route) => {
    prompts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { id: "unexpected-prompt", accepted: true },
    });
  });
  await openWorkbench(page);

  const input = page.getByRole("textbox", { name: "描述任务" });
  await input.fill("/");
  const listbox = page.getByRole("listbox", { name: "斜杠命令" });
  await expect(listbox).toBeVisible();
  await expect(page.locator(".conversation-shell")).toHaveClass(/\blanding\b/u);
  await expect(listbox.getByRole("option")).toHaveText([
    /\/review/u,
    /\/release/u,
    /\/analyze/u,
    /\/deploy/u,
    /\/inspect/u,
    /\/optimize/u,
  ]);
  const menu = page.locator(".slash-command-menu");
  const menuBox = await menu.boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(menuBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(menuBox!.height).toBeLessThanOrEqual(225);
  expect(menuBox!.y).toBeGreaterThanOrEqual(
    composerBox!.y + composerBox!.height + 7,
  );

  for (let index = 0; index < 5; index++) await input.press("ArrowDown");
  const selectedOption = listbox.getByRole("option", { selected: true });
  await expect(selectedOption).toContainText("/optimize");
  await expect
    .poll(() => menu.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const selectedBox = await selectedOption.boundingBox();
  const scrolledMenuBox = await menu.boundingBox();
  expect(selectedBox).not.toBeNull();
  expect(scrolledMenuBox).not.toBeNull();
  expect(selectedBox!.y).toBeGreaterThanOrEqual(scrolledMenuBox!.y);
  expect(selectedBox!.y + selectedBox!.height).toBeLessThanOrEqual(
    scrolledMenuBox!.y + scrolledMenuBox!.height,
  );

  await page.locator(".composer-dock").evaluate((element) => {
    element.style.top = "calc(100% - 160px)";
    window.dispatchEvent(new Event("resize"));
  });
  await expect(menu).toHaveAttribute("data-placement", "above");
  const flippedMenuBox = await menu.boundingBox();
  const shiftedComposerBox = await page.locator(".composer").boundingBox();
  expect(flippedMenuBox).not.toBeNull();
  expect(shiftedComposerBox).not.toBeNull();
  expect(flippedMenuBox!.y + flippedMenuBox!.height).toBeLessThanOrEqual(
    shiftedComposerBox!.y - 7,
  );
  await input.fill("/extension");
  const extension = page.getByRole("option", { name: /\/extension:setup/u });
  await expect(extension).toBeDisabled();
  await expect(extension).toContainText("当前 Web 不支持");

  await input.fill("/rev");
  await expect(page.getByRole("option", { name: /\/review/u })).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("/review ");
  expect(prompts).toEqual([]);
  expect(commandReads).toBe(1);

  await input.fill("/");
  await page.getByRole("option", { name: /\/release/u }).click();
  await expect(input).toHaveValue("/release ");
  expect(prompts).toEqual([]);
  expect(commandReads).toBe(1);
  await expect(page.locator("body")).not.toContainText("/private/project");
});

test.describe("touch viewport", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("keeps navigation and dialogs inside the mobile viewport", async ({
    page,
  }) => {
    await openWorkbench(page);
    await page.getByRole("button", { name: "打开侧边栏" }).click();

    const sidebar = page.locator(".session-sidebar");
    await expect(sidebar).toHaveCSS("backdrop-filter", "none");
    await expect
      .poll(async () => (await sidebar.boundingBox())?.x, { timeout: 1_500 })
      .toBe(0);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox?.width).toBeLessThanOrEqual(300);

    const sessionMenu = sidebar
      .getByRole("button", { name: "会话选项" })
      .first();
    await expect(sessionMenu).toBeVisible();
    await sessionMenu.click();
    const menu = page.getByRole("menu", { name: "会话选项" });
    await expect(menu).toBeVisible();
    // Keyboard dismissal belongs to the menu after its focus handoff, not to
    // the drawer trigger while the menu is still opening.
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(sidebar).toBeVisible();

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("menuitem", { name: "重命名工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "取消" }).click();

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    const width = await page.evaluate(() => ({
      client: document.body.clientWidth,
      scroll: document.body.scrollWidth,
    }));
    expect(width.scroll).toBe(width.client);
  });
});

for (const width of [320, 390]) {
  test(`mobile sidebar contains keyboard focus at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await openWorkbench(page);
    const trigger = page.getByRole("button", { name: "打开侧边栏" });
    const sidebar = page.locator(".session-sidebar");
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await expect(sidebar).not.toBeVisible();
    await page.keyboard.press("Enter");
    await expect(sidebar).toHaveAttribute("role", "dialog");
    await expect(sidebar).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    const close = sidebar.getByRole("button", { name: "收起侧边栏" });
    await expect(close).toBeFocused();
    await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);

    const last = sidebar.getByRole("button", { name: "设置", exact: true });
    const sessionOptions = sidebar
      .getByRole("button", { name: "会话选项" })
      .last();
    for (const source of ["brand", "search"] as const) {
      for (const key of ["Tab", "Shift+Tab", "Escape"]) {
        if (source === "brand") {
          await sidebar.locator(".brand-lockup").click();
          await expect(sidebar).toBeFocused();
        } else {
          const search = sidebar.getByRole("button", { name: "搜索会话" });
          await search.click();
          await sidebar.getByRole("button", { name: "关闭搜索" }).click();
          await expect(search).toBeFocused();
        }
        await page.keyboard.press(key);
        if (key === "Escape") {
          await expect(sidebar).not.toBeVisible();
          await expect(trigger).toBeFocused();
          await trigger.click();
        } else {
          expect(
            await sidebar.evaluate((element) =>
              element.contains(document.activeElement),
            ),
          ).toBe(true);
        }
      }
    }
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await sessionOptions.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名会话" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    for (let step = 0; step < 15; step++) {
      await page.keyboard.press("Tab");
      expect(
        await sidebar.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }

    const menu = sidebar.getByRole("button", { name: "Workspace options" });
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名工作区" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名工作区" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    await expect(
      dialog.getByRole("textbox", { name: "工作区名称" }),
    ).toBeFocused();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(menu).toBeFocused();
    await expect(sidebar).toBeVisible();
    await expect(menu).toHaveCSS("outline-style", "solid");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`sidebar-keyboard-${width}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(sidebar).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await page.keyboard.press("Tab");
    expect(
      await sidebar.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(false);
    expect(requests).toEqual([]);
  });
}

test("mobile sidebar releases focus isolation when resized to desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const trigger = page.getByRole("button", { name: "打开侧边栏" });
  await trigger.click();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".session-sidebar")).not.toHaveAttribute(
    "role",
    "dialog",
  );
  await page.getByRole("textbox", { name: "描述任务" }).focus();
  await expect(page.getByRole("textbox", { name: "描述任务" })).toBeFocused();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".session-sidebar")).not.toBeVisible();
  await trigger.click();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator(".sidebar-scrim").click({ position: { x: 380, y: 400 } });
  await expect(page.locator(".session-sidebar")).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("mobile sidebar recovers focus when archived and restored rows disappear", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const snapshot = await (
    await page.request.get("/api/snapshot", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  // Pi does not persist empty new Sessions; use a header-only fixture, not a model response.
  const fixture = SessionManager.inMemory(snapshot.selectedSession.cwd);
  const path = join(
    dirname(snapshot.selectedSession.path),
    `${fixture.getSessionId()}.jsonl`,
  );
  await writeFile(path, `${JSON.stringify(fixture.getHeader())}\n`, {
    flag: "wx",
  });
  try {
    await page.reload();
    const trigger = page.getByRole("button", { name: "打开侧边栏" });
    const sidebar = page.locator(".session-sidebar");
    const close = sidebar.getByRole("button", { name: "收起侧边栏" });
    await trigger.click();
    for (const action of ["归档会话", "恢复会话"]) {
      const rows = sidebar.locator(".session-row");
      const count = await rows.count();
      await rows
        .filter({ hasNot: page.locator('[aria-current="page"]') })
        .first()
        .getByRole("button", { name: "会话选项" })
        .focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: action }).click();
      await expect(rows).toHaveCount(count - 1);
      await expect(close).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        sidebar.getByRole("button", { name: "新建会话", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(sidebar).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await sidebar
        .getByRole("button", { name: "已归档", exact: true })
        .click();
    }
  } finally {
    await rm(path, { force: true });
  }
});

test.describe("reduced motion", () => {
  test.use({
    contextOptions: { locale: "zh-CN", reducedMotion: "reduce" },
  });

  test("renders the logo in its final static state", async ({ page }) => {
    await openWorkbench(page);
    const logo = page.getByRole("button", {
      name: "Replay OpenPI logo animation",
    });
    const state = await logo.evaluate((element) => {
      const word = element.querySelector<HTMLElement>(".brand-word");
      const pixel = element.querySelector<HTMLElement>(".pixel-mark i");
      return {
        pixelAnimation: pixel ? getComputedStyle(pixel).animationName : "",
        wordAnimation: word ? getComputedStyle(word).animationName : "",
        wordOpacity: word ? getComputedStyle(word).opacity : "",
      };
    });
    expect(state).toEqual({
      pixelAnimation: "none",
      wordAnimation: "none",
      wordOpacity: "1",
    });
  });
});

test("restores a running turn and canonical dark theme without losing cancellation", async ({
  page,
}, testInfo) => {
  const turn = {
    sessionId: "browser-parity-session",
    commandId: "browser-parity-turn",
    epoch: 7,
  };
  const cancelRequests: unknown[] = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.preferences = { theme: "dark" };
    snapshot.currentSessionId = turn.sessionId;
    snapshot.selectedSession = {
      id: turn.sessionId,
      path: "/browser-parity/session.jsonl",
      cwd: "/browser-parity",
      entries: [
        {
          id: "user",
          type: "message",
          timestamp: "2026-09-07T00:00:00Z",
          message: { role: "user", content: "Inspect the current task" },
        },
        {
          id: "assistant",
          type: "message",
          timestamp: "2026-09-07T00:00:01Z",
          message: {
            role: "assistant",
            content:
              "Working on the current task.\nStreaming output stays readable.",
          },
        },
      ],
      bytes: 200,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.runtime = {
      status: "running",
      activeTurn: turn,
      capabilities: {},
    };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/turns/cancel", async (route) => {
    cancelRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { ...turn, state: "accepted", accepted: true, cursor: 0 },
    });
  });
  await openWorkbench(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".message-row.assistant")).toContainText(
    "Streaming output stays readable.",
  );
  await page.screenshot({
    path: testInfo.outputPath("running-dark.png"),
    fullPage: true,
  });
  const stop = page.getByRole("button", { name: "停止当前轮次", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => cancelRequests).toEqual([turn]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  // Cancel triggers a snapshot reconcile. Finish its route handler before
  // Playwright disposes the response's request context during teardown.
  await page.unrouteAll({ behavior: "wait" });
});

test("recovers an unknown prompt admission only after an explicit user decision", async ({
  page,
}, testInfo) => {
  const sessionId = "unknown-admission-session";
  const promptRequests: Array<{
    commandId: string;
    content: string;
    retry: boolean;
  }> = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.currentSessionId = sessionId;
    snapshot.workspaces = [
      { path: "/unknown-admission", name: "Recovery", current: true },
    ];
    snapshot.sessions = [
      {
        id: sessionId,
        path: "/unknown-admission/session.jsonl",
        cwd: "/unknown-admission",
        name: "Recovery",
        modified: "2026-09-08T00:00:00Z",
        created: "2026-09-08T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 0,
      },
    ];
    snapshot.selectedSession = {
      id: sessionId,
      path: "/unknown-admission/session.jsonl",
      cwd: "/unknown-admission",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.runtime = { status: "idle", capabilities: {} };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": idle\n\n",
    }),
  );
  await page.route("**/api/prompt", async (route) => {
    const body = route.request().postDataJSON() as {
      commandId: string;
      content: string;
      retry: boolean;
    };
    promptRequests.push(body);
    if (promptRequests.length === 1) {
      await route.abort("failed");
      return;
    }
    if (promptRequests.length === 2) {
      await route.fulfill({
        status: 409,
        json: {
          code: "COMMAND_ADMISSION_UNKNOWN",
          error: "previous prompt admission is unknown",
        },
      });
      return;
    }
    await route.fulfill({
      status: 202,
      json: { id: body.commandId, accepted: true },
    });
  });

  await openWorkbench(page);
  const draft = page.getByRole("textbox", { name: "描述任务" });
  await draft.fill("可能产生副作用的请求");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => promptRequests.length).toBe(1);
  await page.getByRole("button", { name: "发送", exact: true }).click();

  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "无法确认上次发送的消息是否已被接收" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新状态" })).toHaveCount(0);
  await expect(draft).toHaveValue("可能产生副作用的请求");
  await expect(page.getByText("正在准备任务...", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("unknown-admission-recovery.png"),
    fullPage: true,
  });
  expect(promptRequests[1]?.commandId).toBe(promptRequests[0]?.commandId);
  expect(promptRequests[1]?.retry).toBe(true);

  await page.getByRole("button", { name: "作为新消息发送" }).click();
  await expect.poll(() => promptRequests.length).toBe(3);
  expect(promptRequests[2]?.commandId).not.toBe(promptRequests[0]?.commandId);
  expect(promptRequests[2]?.retry).toBe(false);
  await expect(draft).toHaveValue("");
  await expect(
    page.getByText("无法确认上次发送的消息是否已被接收。", {
      exact: true,
    }),
  ).toHaveCount(0);
});

test("inspects session-scoped runtime and terminal details on desktop and mobile", async ({
  page,
}, testInfo) => {
  const sessionId = "inspection-browser-session";
  const reads: string[] = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.currentSessionId = sessionId;
    snapshot.selectedSession = {
      id: sessionId,
      path: "/inspection/session.jsonl",
      cwd: "/inspection",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.runtime = {
      status: "idle",
      capabilities: {
        "background-terminals": {
          items: [
            {
              id: "bt-1",
              title: "Build logs",
              status: "done",
              createdAt: 1,
              settledAt: 2,
            },
          ],
          omitted: 0,
        },
      },
    };
    snapshot.models = [
      {
        provider: "example",
        id: "example-model",
        name: "Inspection Model",
        label: "Inspection Model",
        current: true,
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  for (const endpoint of [
    "thinking",
    "trust",
    "providers/auth-status",
    "capabilities/detail",
  ]) {
    await page.route(`**/api/${endpoint}?**`, async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("sessionId")).toBe(sessionId);
      reads.push(endpoint);
      const body =
        endpoint === "thinking"
          ? { sessionId, level: "medium", available: ["low", "medium", "high"] }
          : endpoint === "trust"
            ? {
                workspace: "/inspection",
                state: "restricted",
                refreshRequired: false,
              }
            : endpoint === "providers/auth-status"
              ? {
                  providers: [
                    { id: "example", name: "Example", configured: true },
                  ],
                  truncation: { truncated: false },
                }
              : {
                  sessionId,
                  detail: {
                    id: "bt-1",
                    title: "Build logs",
                    command: "bun run check",
                    cwd: "/inspection",
                    status: "done",
                    createdAt: 1,
                    exitCode: 0,
                    stdout: {
                      text:
                        '<script>alert("literal output")</script>\n' +
                        "long output ".repeat(100),
                      truncated: true,
                      omittedBytes: 100,
                    },
                    stderr: { text: "" },
                    truncated: true,
                  },
                };
      await route.fulfill({ json: body });
    });
  }
  await openWorkbench(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "运行状态", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(dialog).toContainText("medium");
    await expect(dialog).not.toContainText("Example");
    await expect
      .poll(() => reads.filter((x) => x === "thinking").length)
      .toBe(width === 1280 ? 1 : 2);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`status-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "服务商凭据", exact: true }).click();
    const providerSettings = page.getByRole("dialog", { name: "设置" });
    const settingsNavigation = providerSettings.getByRole("tablist", {
      name: "设置导航",
    });
    await expect(
      providerSettings.getByRole("heading", { name: "常规" }),
    ).toBeVisible();
    await expect(
      providerSettings.getByRole("button", { name: "打开运行详情" }),
    ).toBeVisible();
    await settingsNavigation
      .getByRole("tab", { name: "模型", exact: true })
      .click();
    await expect(
      providerSettings.getByRole("heading", { name: "Inspection Model" }),
    ).toBeVisible();
    await expect(providerSettings).toContainText("Example");
    await expect
      .poll(() => reads.filter((x) => x === "providers/auth-status").length)
      .toBe(width === 1280 ? 1 : 2);
    await settingsNavigation
      .getByRole("tab", { name: "常规", exact: true })
      .click();
    await expect(
      providerSettings.getByRole("heading", { name: "常规" }),
    ).toBeVisible();
    await expect(
      providerSettings.getByRole("button", { name: "打开运行详情" }),
    ).toBeVisible();
    await settingsNavigation
      .getByRole("tab", { name: "模型", exact: true })
      .click();
    await expect(
      providerSettings.getByRole("heading", { name: "Inspection Model" }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`providers-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(providerSettings).not.toBeVisible();
    await page.getByRole("button", { name: /Build logs/ }).click();
    await expect(dialog.locator("pre").first()).toContainText(
      '<script>alert("literal output")</script>',
    );
    const terminalOutput = dialog.getByRole("region", { name: "标准输出" });
    await terminalOutput.click();
    await expect(terminalOutput).toBeFocused();
    expect(
      await terminalOutput.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await expect(dialog.locator("script")).toHaveCount(0);
    await expect(dialog).toContainText("已完成");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`terminal-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("adds validated file references without hiding the prompt contract", async ({
  page,
}, testInfo) => {
  const sessionId = "file-reference-browser-session";
  const references: string[] = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const selected = snapshot.selectedSession;
    expect(selected).toBeTruthy();
    snapshot.currentSessionId = sessionId;
    snapshot.selectedSession = {
      ...selected,
      id: sessionId,
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.sessions = snapshot.sessions.map(
      (session: { path: string; id: string }) =>
        session.path === selected.path
          ? { ...session, id: sessionId }
          : session,
    );
    snapshot.runtime = { status: "idle", capabilities: {} };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/artifacts/resolve", async (route) => {
    const body = route.request().postDataJSON() as { reference: string };
    references.push(body.reference);
    if (body.reference.startsWith("..")) {
      await route.fulfill({
        status: 403,
        json: { error: "Host English", code: "ARTIFACT_DENIED" },
      });
      return;
    }
    await route.fulfill({ json: { handle: "file-reference-handle" } });
  });
  await page.route("**/api/artifacts/content?**", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ json: { released: true } });
      return;
    }
    await route.fulfill({ json: { identity: "stable" } });
  });

  await openWorkbench(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const draft = page.getByRole("textbox", { name: "描述任务" });
    await page.getByRole("button", { name: "添加上下文" }).click();
    await page.getByRole("menuitem", { name: /引用工作区文件/u }).click();
    const dialog = page.getByRole("dialog", { name: "引用工作区文件" });
    await dialog
      .getByRole("textbox", { name: "工作区文件路径" })
      .fill("README.md");
    await dialog.getByRole("button", { name: "插入引用" }).click();
    await expect(draft).toHaveValue("`README.md`");
    await expect(draft).toBeFocused();

    await page.getByRole("button", { name: "添加上下文" }).click();
    await expect(
      page.getByRole("menuitem", { name: /斜杠命令/u }),
    ).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: /引用工作区文件/u }).click();
    await dialog
      .getByRole("textbox", { name: "工作区文件路径" })
      .fill("../outside.txt");
    await dialog.getByRole("button", { name: "插入引用" }).click();
    await expect(dialog).toContainText("请选择当前会话工作区内的文件。");
    await expect(draft).toHaveValue("`README.md`");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`file-reference-${width}.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "取消" }).click();
    await draft.fill("");
  }
  expect(references).toEqual([
    "README.md",
    "../outside.txt",
    "README.md",
    "../outside.txt",
  ]);
});

test("restores archived history without switching the active Session", async ({
  page,
}) => {
  let archived = true;
  let restores = 0;
  const activations: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/sessions", "/api/sessions/select"].includes(pathname)
    )
      activations.push(pathname);
  });
  const path = "/archived/browser.jsonl";
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.sessions = [
      {
        id: "archived-browser",
        path,
        cwd: "/archived",
        name: "Saved browser work",
        archived,
        source: "web-session",
        origin: "web",
        controller: "none",
        readOnly: false,
        created: "2026-09-07T00:00:00Z",
        modified: "2026-09-07T00:00:00Z",
        messageCount: 1,
        firstMessage: "saved",
      },
    ];
    snapshot.workspaces = [];
    snapshot.truncation.sessionsOmitted = 20;
    snapshot.truncation.workspacesOmitted = 1;
    snapshot.truncation.truncated = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/sessions/unarchive?**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    restores++;
    if (restores === 1)
      await route.fulfill({ status: 500, json: { error: "Try again" } });
    else {
      archived = false;
      await route.fulfill({ json: { path, archived: false } });
    }
  });
  await openWorkbench(page);
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "搜索会话" }).click();
  await page
    .getByRole("searchbox", { name: "搜索会话" })
    .fill("not-in-loaded-history");
  await expect(
    page.getByText("已加载历史中没有匹配的会话", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/搜索仅覆盖已加载列表/u)).toBeVisible();
  await page.getByRole("button", { name: "关闭搜索" }).click();
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toBeVisible();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByText("Saved browser work", { exact: true }).hover();
    await page.getByRole("button", { name: "会话选项" }).click();
    await page.getByRole("menuitem", { name: "恢复会话" }).click();
    if (!attempt)
      await expect(
        page.getByText("暂时无法确认恢复结果，请刷新后重试。"),
      ).toBeVisible();
    if (!attempt)
      await expect(
        page.getByText("Saved browser work", { exact: true }),
      ).toBeVisible();
  }
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toHaveCount(0);
  expect(restores).toBe(2);
  expect(activations).toEqual([]);
  await page.getByRole("button", { name: "当前", exact: true }).click();
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toBeVisible();
});

test("trajectory inspects bounded prompt and tool evidence on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const entries = Array.from({ length: 55 }, (_, index) => ({
      id: `user-${index}`,
      type: "message",
      timestamp: "2026-09-07T00:00:00Z",
      message: { role: "user", content: "Repeated prompt" },
    }));
    snapshot.sessions = [];
    snapshot.workspaces = [];
    snapshot.currentSessionId = "trajectory-fixture";
    snapshot.selectedSession = {
      id: "trajectory-fixture",
      path: "/trajectory/a.jsonl",
      cwd: "/trajectory",
      bytes: 1000,
      truncation: {
        truncated: true,
        entriesOmitted: 4,
        messagePartsOmitted: 0,
        messagesTruncated: 1,
        maxBytes: 2097152,
      },
      entries: [
        ...entries,
        {
          id: "call",
          type: "message",
          timestamp: "2026-09-07T00:00:01Z",
          message: {
            role: "assistant",
            content: "",
            parts: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: '{"command":"printf hello"}',
              },
            ],
          },
        },
        {
          id: "result",
          type: "message",
          timestamp: "2026-09-07T00:00:02Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: '<script>alert("evidence")</script>',
            isError: false,
          },
        },
        {
          id: "custom-tail",
          type: "custom",
          timestamp: "2026-09-07T00:00:03Z",
        },
      ],
    };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await openWorkbench(page);
  await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
  const view = page.getByRole("region", { name: "执行轨迹", exact: true });
  await expect(view.locator(".trajectory-record")).toHaveCount(50);
  await expect(view.locator(".trajectory-inspector")).toContainText(
    "printf hello",
  );
  await expect(view.locator(".trajectory-inspector")).toContainText(
    "工具已返回结果。",
  );
  await expect(view.getByText(/省略 4 条记录/)).toBeVisible();
  await view.getByRole("button", { name: /显示更早记录/ }).click();
  await expect(view.locator(".trajectory-record")).toHaveCount(57);
  await view.locator(".trajectory-record").filter({ hasText: "bash" }).click();
  await expect(view.locator(".trajectory-inspector")).toContainText(
    "printf hello",
  );
  await expect(view.locator(".trajectory-inspector")).toContainText(
    '<script>alert("evidence")</script>',
  );
  await expect(view.locator("script")).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(view.locator(".trajectory-inspector")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include(".conversation-shell").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`trajectory-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(view).toHaveCount(0);
});

test("fresh browser contexts open the bare address and can request workspace selection", async ({
  browser,
}) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        sessionStorage.setItem("openpi.web.token", "stale-host-token");
        Object.defineProperty(Storage.prototype, "setItem", {
          value() {
            throw new Error("storage disabled");
          },
        });
      });
      let selections = 0;
      await page.route("**/api/workspaces/select", async (route) => {
        expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
        selections++;
        await route.fulfill({ json: { cancelled: true } });
      });
      const snapshot = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/snapshot" &&
          response.status() === 200,
      );
      await page.goto("http://127.0.0.1:57109/");
      await snapshot;
      await expect(page.locator(".notice")).toHaveCount(0);
      await page.locator(".workspace-heading button").last().click();
      await expect.poll(() => selections).toBe(1);
      await page.reload();
      await expect(page.locator(".notice")).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe("");
    } finally {
      await context.close();
    }
  }
});

test("model picker distinguishes same-named models before choosing a directory", async ({
  page,
}) => {
  let modelWrites = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/model") modelWrites++;
  });
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    delete snapshot.currentSessionId;
    delete snapshot.selectedSession;
    snapshot.sessions = [];
    snapshot.workspaces = [];
    snapshot.runtime.status = "idle";
    snapshot.models = [
      {
        provider: "provider-alpha",
        id: "one",
        name: "Shared model",
        label: "Shared model",
        current: true,
      },
      {
        provider: "provider-beta",
        id: "two",
        name: "Shared model",
        label: "Shared model",
        current: false,
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": idle\n\n",
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const modelPicker = page.getByRole("button", {
    name: "Shared model (provider-alpha/one)",
  });
  await expect(modelPicker).toHaveText("Shared model (provider-alpha/one)");
  expect(
    await modelPicker.evaluate((element) => {
      const label = element.querySelector(".model-picker-label");
      return (
        label instanceof HTMLElement &&
        getComputedStyle(label).whiteSpace === "nowrap" &&
        getComputedStyle(label).textOverflow === "ellipsis" &&
        label.getBoundingClientRect().right <=
          document.documentElement.clientWidth
      );
    }),
  ).toBe(true);
  await modelPicker.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "描述任务" })).toHaveAttribute(
    "readonly",
    "",
  );
  expect(modelWrites).toBe(0);
});

test("same-named model selection sends the exact identity for an active Session", async ({
  page,
}) => {
  let selectedIdentity = "provider-alpha/one";
  const writes: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.runtime.status = "idle";
    snapshot.models = [
      {
        provider: "provider-alpha",
        id: "one",
        name: "Shared model",
        label: "Shared model",
        current: selectedIdentity === "provider-alpha/one",
      },
      {
        provider: "provider-beta",
        id: "two",
        name: "Shared model",
        label: "Shared model",
        current: selectedIdentity === "provider-beta/two",
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/model", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    selectedIdentity = `${body.provider}/${body.modelId}`;
    await route.fulfill({
      status: 200,
      json: {
        provider: body.provider,
        id: body.modelId,
        name: "Shared model",
        label: "Shared model",
        current: true,
      },
    });
  });
  await openWorkbench(page);

  await page
    .getByRole("button", { name: "Shared model (provider-alpha/one)" })
    .click();
  await page
    .getByRole("option", { name: "Shared model (provider-beta/two)" })
    .click();

  await expect(
    page.getByRole("button", { name: "Shared model (provider-beta/two)" }),
  ).toBeEnabled();
  expect(writes).toEqual([
    {
      provider: "provider-beta",
      modelId: "two",
      sessionId: expect.any(String),
    },
  ]);
});

test("finds and selects a model omitted from the bounded snapshot", async ({
  page,
}) => {
  const visibleModels = Array.from({ length: 250 }, (_, index) => ({
    provider: "fixture",
    id: `visible-${index}`,
    name: `Visible ${index}`,
    label: `Visible ${index}`,
    current: index === 0,
  }));
  const hiddenModel = {
    provider: "provider-hidden",
    id: "needle-251",
    name: "Needle 251",
    label: "Needle 251",
    current: false,
  };
  const searchRequests: URL[] = [];
  const modelWrites: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  let activeSessionId: string | undefined;
  let selectedIdentity = "fixture/visible-0";

  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    activeSessionId = snapshot.currentSessionId;
    snapshot.runtime.status = "idle";
    snapshot.models =
      selectedIdentity === "provider-hidden/needle-251"
        ? [
            { ...hiddenModel, current: true },
            ...visibleModels.slice(0, 249).map((model) => ({
              ...model,
              current: false,
            })),
          ]
        : visibleModels;
    snapshot.truncation.modelsOmitted = 1;
    snapshot.truncation.truncated = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/models?**", async (route) => {
    searchRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      json: {
        models: [hiddenModel],
        totalAvailable: 251,
        totalMatches: 1,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 128,
        },
      },
    });
  });
  await page.route("**/api/model", async (route) => {
    const body = route.request().postDataJSON();
    modelWrites.push(body);
    selectedIdentity = `${body.provider}/${body.modelId}`;
    await route.fulfill({
      status: 200,
      json: { ...hiddenModel, current: true },
    });
  });
  await openWorkbench(page);

  expect(activeSessionId).toBeTruthy();
  await page
    .getByRole("button", { name: "Visible 0 (fixture/visible-0)" })
    .click();
  await expect(
    page.getByText("当前显示 250 个模型，还有 1 个可用；搜索即可查找。"),
  ).toBeVisible();
  const hiddenOption = page.getByRole("option", {
    name: "Needle 251 (provider-hidden/needle-251)",
  });
  await expect(hiddenOption).toHaveCount(0);

  await page
    .getByPlaceholder("搜索服务商、模型名称或 ID...")
    .fill("needle-251");
  await expect(hiddenOption).toBeVisible();

  expect(searchRequests).toHaveLength(1);
  expect(searchRequests[0]?.searchParams.get("query")).toBe("needle-251");
  expect(searchRequests[0]?.searchParams.get("limit")).toBe("50");
  expect(searchRequests[0]?.searchParams.get("sessionId")).toBe(
    activeSessionId,
  );

  await hiddenOption.click();
  expect(modelWrites).toEqual([
    {
      provider: "provider-hidden",
      modelId: "needle-251",
      sessionId: activeSessionId,
    },
  ]);
  await expect(
    page.getByRole("button", {
      name: "Needle 251 (provider-hidden/needle-251)",
    }),
  ).toBeEnabled();
});

test("workspace selection survives refresh and creates the exact native Session before sending", async ({
  page,
}, testInfo) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-issue-467-"));
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: "http://127.0.0.1:57109",
  };
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path: canonicalWorkspace } = await imported.json();
    const before = await page.request.get("/api/snapshot", { headers });
    const initial = await before.json();
    const workspaceName = canonicalWorkspace.split(/[\\/]/u).at(-1);
    const prompts: Array<{ sessionId: string; content: string }> = [];
    // Only intercept model admission. Workspace import, snapshots and native
    // Session creation use the isolated real Host and Pi runtime.
    await page.route("**/api/prompt", async (route) => {
      const body = route.request().postDataJSON();
      prompts.push({ sessionId: body.sessionId, content: body.content });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 202,
        json: { id: body.commandId, accepted: true },
      });
    });
    await openWorkbench(page);
    const picker = page.locator(".workspace-picker");
    await picker.click();
    await page
      .getByRole("menuitem", { name: workspaceName, exact: true })
      .click();
    await expect(picker).toHaveText(workspaceName);
    await expect(page.locator(".model-picker")).toBeEnabled();
    // Importing the same directory again triggers a real workspace event and
    // refresh while the canonical Session still belongs to the original cwd.
    const refresh = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/snapshot",
    );
    await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    await refresh;
    await expect(picker).toHaveText(workspaceName);
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("Only work in the selected repository");
    await Promise.all([input.press("Enter"), input.press("Enter")]);
    await expect.poll(() => prompts.length).toBe(1);
    await expect(input).toHaveValue("");
    const after = await page.request.get("/api/snapshot", { headers });
    const current = await after.json();
    expect(current.selectedSession.cwd).toBe(canonicalWorkspace);
    expect(current.currentSessionId).not.toBe(initial.currentSessionId);
    expect(prompts).toEqual([
      {
        sessionId: current.currentSessionId,
        content: "Only work in the selected repository",
      },
    ]);
    await page.screenshot({
      path: testInfo.outputPath("workspace-selection.png"),
      fullPage: true,
    });
  } finally {
    await page.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a delayed creation receipt never retargets the first prompt to another tab's Session", async ({
  page,
}) => {
  const workspaceA = await mkdtemp(join(tmpdir(), "openpi-issue-466-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "openpi-issue-466-b-"));
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: "http://127.0.0.1:57109",
  };
  const promptRequests: unknown[] = [];
  let createdSessionId: string | undefined;
  let externalSessionId: string | undefined;
  try {
    const importedA = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspaceA },
    });
    const importedB = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspaceB },
    });
    expect(importedA.status()).toBe(201);
    expect(importedB.status()).toBe(201);
    const { path: canonicalA } = await importedA.json();
    const { path: canonicalB } = await importedB.json();
    const workspaceNameA = canonicalA.split("/").at(-1);

    await page.route("**/events?**", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      }),
    );
    await page.route("**/api/prompt", async (route) => {
      promptRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: {
          id: route.request().postDataJSON().commandId,
          accepted: true,
        },
      });
    });
    await page.route("**/api/sessions", async (route) => {
      const createdResponse = await route.fetch();
      const created = await createdResponse.json();
      createdSessionId = created.sessionId;
      const external = await page.request.post("/api/sessions", {
        headers,
        data: {
          workspacePath: canonicalB,
          commandId: "external-tab-switch",
        },
      });
      expect(external.status()).toBe(201);
      externalSessionId = (await external.json()).sessionId;
      await route.fulfill({ response: createdResponse, json: created });
    });

    await openWorkbench(page);
    const picker = page.locator(".workspace-picker");
    await picker.click();
    await page
      .getByRole("menuitem", { name: workspaceNameA, exact: true })
      .click();
    const composer = page.getByRole("textbox", { name: "描述任务" });
    await composer.fill("Only edit repository A");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await expect(page.locator(".notice")).toContainText("no longer active");
    await expect(composer).toHaveValue("Only edit repository A");
    expect(promptRequests).toEqual([]);
    expect(createdSessionId).toEqual(expect.any(String));
    expect(externalSessionId).toEqual(expect.any(String));
    expect(createdSessionId).not.toBe(externalSessionId);
    const snapshot = await page.request.get("/api/snapshot", { headers });
    expect((await snapshot.json()).currentSessionId).toBe(externalSessionId);
  } finally {
    await page.close();
    await Promise.all(
      [workspaceA, workspaceB].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
});

test.describe("thinking picker", () => {
  test("disables thinking when the runtime reports it unsupported", async ({
    page,
  }) => {
    await installThinkingFixture(page, { supported: false, available: [] });
    await openWorkbench(page);
    const thinkingPicker = page.locator(".thinking-picker");
    await expect(thinkingPicker).toBeDisabled();
    await expect(thinkingPicker).toHaveAttribute("aria-label", "暂不支持思考");
  });

  test("opens with a section heading and marks the confirmed level", async ({
    page,
  }) => {
    await installThinkingFixture(page);
    await openWorkbench(page);
    const picker = page.locator(".thinking-picker");
    await expect(picker).toBeEnabled();
    await picker.click();
    await expect(page.getByRole("group", { name: "思考等级" })).toBeVisible();
    await expect(
      page
        .getByRole("menuitem", { name: "off", exact: true })
        .locator("svg.lucide-check"),
    ).toHaveCount(1);
  });

  test("selecting the confirmed level issues no write", async ({ page }) => {
    const fixture = await installThinkingFixture(page);
    await openWorkbench(page);
    await page.locator(".thinking-picker").click();
    await page.getByRole("menuitem", { name: "off", exact: true }).click();
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "off",
    );
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-pending",
      "false",
    );
    expect(fixture.posts).toEqual([]);
  });

  test("selecting another level issues exactly one write and confirms it", async ({
    page,
  }) => {
    const fixture = await installThinkingFixture(page);
    await openWorkbench(page);
    await page.locator(".thinking-picker").click();
    await page.getByRole("menuitem", { name: "high", exact: true }).click();
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "high",
    );
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-pending",
      "false",
    );
    expect(fixture.posts).toEqual([
      { sessionId: MOCK_SESSION_ID, level: "high" },
    ]);
  });

  test("is keyboard-operable and cancels with Escape", async ({ page }) => {
    const fixture = await installThinkingFixture(page);
    await openWorkbench(page);
    const picker = page.locator(".thinking-picker");
    await picker.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "off", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "low", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "low",
    );
    expect(fixture.posts).toEqual([
      { sessionId: MOCK_SESSION_ID, level: "low" },
    ]);

    await picker.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(fixture.posts).toHaveLength(1);
  });

  test("keeps the last intent when the first write is in flight", async ({
    page,
  }) => {
    const fixture = await installThinkingFixture(page);
    await openWorkbench(page);
    const picker = page.locator(".thinking-picker");
    fixture.holdNextPost();
    await picker.click();
    await page.getByRole("menuitem", { name: "low", exact: true }).click();
    await expect.poll(() => fixture.posts.length, { timeout: 5_000 }).toBe(1);

    await picker.click();
    await page.getByRole("menuitem", { name: "high", exact: true }).click();
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-pending",
      "true",
    );
    fixture.releaseHeldPost();
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "high",
    );
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-pending",
      "false",
    );
    expect(fixture.posts).toEqual([
      { sessionId: MOCK_SESSION_ID, level: "low" },
      { sessionId: MOCK_SESSION_ID, level: "high" },
    ]);
  });

  test("surfaces a notice and reconciles after a failed write", async ({
    page,
  }) => {
    const fixture = await installThinkingFixture(page);
    fixture.failNextPost(500, { error: "Mock thinking failure" });
    await openWorkbench(page);
    await page.locator(".thinking-picker").click();
    await page.getByRole("menuitem", { name: "high", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Mock thinking failure",
    );
    await expect.poll(() => fixture.getCount()).toBe(1);
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-level",
      "off",
    );
    await expect(page.locator(".thinking-picker-wrap")).toHaveAttribute(
      "data-pending",
      "false",
    );
  });

  test("surfaces a notice when thinking control is unavailable", async ({
    page,
  }) => {
    const fixture = await installThinkingFixture(page);
    fixture.failNextPost(501, {
      code: "THINKING_CONTROL_UNAVAILABLE",
      error: "thinking control is unavailable",
    });
    await openWorkbench(page);
    await page.locator(".thinking-picker").click();
    await page.getByRole("menuitem", { name: "low", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "thinking control is unavailable",
    );
  });

  test("warns when the confirmed level is outside the supported set", async ({
    page,
  }) => {
    await installThinkingFixture(page, {
      level: "medium",
      available: ["off", "low", "high"],
    });
    await openWorkbench(page);
    await page.locator(".thinking-picker").click();
    await expect(
      page.locator('.thinking-picker-wrap[data-warning="true"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /当前确认的思考等级/ }),
    ).toBeVisible();
  });

  test("locks the picker while a turn is running", async ({ page }) => {
    await installThinkingFixture(page, { runtimeStatus: "running" });
    await openWorkbench(page);
    await expect(page.locator(".thinking-picker")).toBeDisabled();
  });

  test("keeps the toolbar inside a narrow viewport", async ({ page }) => {
    await installThinkingFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkbench(page);
    await expect(page.locator(".thinking-picker")).toBeVisible();
    const width = await page.evaluate(() => ({
      client: document.body.clientWidth,
      scroll: document.body.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });

  test("has an accessible trigger and an accessible open menu", async ({
    page,
  }) => {
    await installThinkingFixture(page);
    await openWorkbench(page);
    const picker = page.locator(".thinking-picker");
    await expect(picker).toHaveAccessibleName(/思考等级.*off/);
    await picker.click();
    await expect(page.getByRole("group", { name: "思考等级" })).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
  });
});
