import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installThinkingFixture,
  MOCK_SESSION_ID,
} from "./thinking-e2e-support.ts";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authenticatedPath = "/";

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

test("production workbench is local, keyboard-operable, and accessible", async ({
  page,
}) => {
  const externalRequests = await openWorkbench(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "OpenPI" }),
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
  await expect(thinkingPicker).toBeDisabled();
  await expect(thinkingPicker).toHaveAttribute("aria-label", "暂不支持思考");
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
    const message = document.createElement("article");
    message.className = "message-row assistant";
    message.textContent = "Layout probe";
    const rail = document.createElement("nav");
    rail.className = "turn-rail";
    conversation.append(message);
    shell.append(rail);
    const messageRect = message.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    message.remove();
    rail.remove();
    return {
      gutter: shellRect.right - railRect.right,
      messageRight: messageRect.right,
      railLeft: railRect.left,
    };
  });
  expect(turnRailLayout.gutter).toBeCloseTo(24, 0);
  expect(turnRailLayout.railLeft).toBeGreaterThanOrEqual(
    turnRailLayout.messageRight,
  );
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
    await expect(page.getByRole("menu", { name: "会话选项" })).toBeVisible();
    await page.keyboard.press("Escape");

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
    await expect(dialog).toContainText("medium");
    await expect(dialog).toContainText("Example");
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
    await page.getByRole("button", { name: /Build logs/ }).click();
    await expect(dialog.locator("pre").first()).toContainText(
      '<script>alert("literal output")</script>',
    );
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
  await expect(view.getByText(/省略 4 条记录/)).toBeVisible();
  await view.getByRole("button", { name: /显示更早记录/ }).click();
  await expect(view.locator(".trajectory-record")).toHaveCount(56);
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
        getComputedStyle(label).whiteSpace === "normal" &&
        label.scrollWidth <= label.clientWidth
      );
    }),
  ).toBe(true);
  await modelPicker.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", {
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
    .getByRole("menuitem", { name: "Shared model (provider-beta/two)" })
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
    const workspaceName = canonicalWorkspace.split("/").at(-1);
    const prompts: Array<{ sessionId: string; content: string }> = [];
    // Only intercept model admission. Workspace import, snapshots and native
    // Session creation use the isolated real Host and Pi runtime.
    await page.route("**/api/prompt", async (route) => {
      const body = route.request().postDataJSON();
      prompts.push({ sessionId: body.sessionId, content: body.content });
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
    await page
      .getByRole("textbox", { name: "描述任务" })
      .fill("Only work in the selected repository");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => prompts.length).toBe(1);
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

test.describe("thinking picker", () => {
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
