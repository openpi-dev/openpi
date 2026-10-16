import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Browser, expect, type Locator, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";

// This fixture exercises the actual runtime, Host and persisted adapter. In
// particular, no snapshot/order route may replace the server's ordering result.
async function createMenuHost(browser: Browser) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "openpi-sidebar-menu-")),
  );
  const agent = join(root, "agent");
  const paths = ["Alpha", "Beta", "Gamma"].map((name) => join(root, name));
  await Promise.all(
    [agent, ...paths].map((path) => mkdir(path, { mode: 0o700 })),
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "sidebar-fixture",
      defaultModel: "fixture",
    }),
  );
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "sidebar-fixture": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              contextWindow: 100_000,
              maxTokens: 1000,
              input: ["text"],
            },
          ],
        },
      },
    }),
  );
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let runtime = await PiWebRuntime.create(paths[0]!);
  const completeAnswer = `FULL_NATIVE_START\n${"完整原生会话正文，不应使用界面预览截断。\n".repeat(1700)}FULL_NATIVE_END`;
  const sessions = paths.map((cwd, index) => {
    const manager =
      index === 0
        ? runtime.sessionManager
        : SessionManager.create(cwd, runtime.sessionDirectory);
    manager.appendMessage({
      role: "user",
      content: `Question for ${index}`,
      timestamp: index + 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: index === 0 ? completeAnswer : `Answer for ${index}`,
        },
      ],
      api: "openai-completions",
      provider: "sidebar-fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: index + 10,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendSessionInfo(
      `${["Alpha", "Beta", "Gamma"][index]} conversation`,
    );
    manager.appendCustomEntry("sidebar-menu-fixture", { nativeTail: index });
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, cwd };
  });
  const token = "be".repeat(32);
  let host = new WebHost({ runtime, token });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const prohibited: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => {
    // Keep clipboard verification inside this isolated browser context.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, "sidebarCopiedText", text);
        },
      },
    });
  });
  await context.route(/\/api\/(?:prompt|sessions\/open)$/u, (route) => {
    prohibited.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 500,
      json: {
        error: "Browser fixture forbids model requests and external app launch",
      },
    });
  });
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${host.origin}${path}`, {
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: host.origin,
      },
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const snapshot = async () => (await api("/api/snapshot")) as WebSnapshot;
  try {
    await host.start();
    await api("/api/settings/preferences", {
      sidebarGrouping: "project",
      projectsInRecents: false,
      theme: "light",
    });
    await api("/api/workspaces/order", { path: paths[2], before: null });
    await api("/api/workspaces/order", { path: paths[1], before: paths[2] });
    await api("/api/workspaces/order", { path: paths[0], before: paths[1] });
    await page.goto(host.origin);
  } catch (error) {
    await context.close();
    await host.stop();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    page,
    sessions,
    paths,
    completeAnswer,
    errors,
    prohibited,
    snapshot,
    archived: () => api("/api/sessions/archived"),
    async restart() {
      const port = Number(new URL(host.origin).port);
      await page.goto("about:blank");
      await host.stop();
      runtime = await PiWebRuntime.create(paths[0]!);
      await runtime.switchSession(sessions[0]!.path);
      host = new WebHost({ runtime, token, port });
      await host.start();
      await page.goto(host.origin);
    },
    async close() {
      await page
        .screenshot({
          path: test.info().outputPath("native-flow-final.png"),
          animations: "disabled",
        })
        .catch(() => {});
      await context.close();
      await host.stop();
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function openConversationMenu(row: Locator) {
  await row.hover();
  const trigger = row.getByRole("button", { name: "会话选项", exact: true });
  await expect(row.locator(":scope > .astryx-menu-trigger")).toHaveCSS(
    "opacity",
    "1",
  );
  await trigger.focus();
  await trigger.press("Enter");
  return trigger;
}

test("archive notifications view or undo the exact native session and expire without restoring it", async ({
  browser,
}) => {
  const fixture = await createMenuHost(browser);
  const { page } = fixture;
  try {
    const rows = page.locator(".workspace-tree .session-row");
    await expect(rows).toHaveCount(3);
    await page.clock.install();
    const archive = async (name: string) => {
      await openConversationMenu(
        rows.filter({ has: page.getByText(name, { exact: true }) }),
      );
      await page.getByRole("menuitem", { name: "归档", exact: true }).click();
      const notice = page.locator(".archive-notification").filter({
        hasText: name,
      });
      await expect(notice).toBeVisible();
      return notice;
    };
    const beta = await archive("Beta conversation");
    const gamma = await archive("Gamma conversation");
    await expect(page.locator(".archive-notification")).toHaveCount(2);
    await page.screenshot({
      path: test.info().outputPath("archive-notifications-stacked.png"),
      animations: "disabled",
    });

    await beta.getByRole("button", { name: "查看", exact: true }).click();
    await expect(beta).toBeHidden();
    await expect
      .poll(async () => (await fixture.snapshot()).selectedSession?.id)
      .toBe(fixture.sessions[1]!.id);
    expect(
      (await fixture.snapshot()).sessions.find(
        (session) => session.id === fixture.sessions[1]!.id,
      )?.archived,
    ).toBe(true);
    await gamma.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(gamma).toBeHidden();
    await expect(
      rows.getByText("Gamma conversation", { exact: true }),
    ).toBeVisible();
    expect(
      (await fixture.snapshot()).sessions.find(
        (session) => session.id === fixture.sessions[1]!.id,
      )?.archived,
    ).toBe(true);

    const timed = await archive("Gamma conversation");
    await timed.hover();
    await page.clock.runFor(9000);
    await expect(timed).toBeVisible();
    await page.mouse.move(5, 5);
    await page.clock.runFor(7000);
    await expect(timed).toBeVisible();
    await page.clock.runFor(1000);
    await expect(timed).toBeHidden();
    expect((await fixture.archived()).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.sessions[2]!.id,
          archived: true,
        }),
      ]),
    );
    await page.reload();
    await expect(rows).toHaveCount(1);
    await expect(page.locator(".archive-notification")).toHaveCount(0);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("native sidebar project drag survives Host restart while ordinary project and conversation clicks preserve order", async ({
  browser,
}) => {
  const fixture = await createMenuHost(browser);
  const { page } = fixture;
  try {
    const sidebar = page.locator(".session-sidebar");
    const rows = sidebar.locator(".workspace-tree > .workspace-group");
    const labels = rows.locator(".workspace-label strong");
    await expect(labels).toHaveText(["Alpha", "Beta", "Gamma"]);
    const alpha = rows.filter({
      has: page.locator(".workspace-label strong", { hasText: /^Alpha$/u }),
    });
    const gamma = rows.filter({
      has: page.locator(".workspace-label strong", { hasText: /^Gamma$/u }),
    });
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/workspaces/order" &&
        response.request().method() === "POST",
    );
    const source = await gamma.locator(".workspace-button").boundingBox();
    expect(source).not.toBeNull();
    const start = { x: source!.x + 60, y: source!.y + source!.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, start.y, { steps: 4 });
    await expect(sidebar.locator(".pinned-section")).toBeVisible();
    // Native dragstart reveals a pin drop area. Measure the ordinary project
    // target afterwards, rather than using its previous screen position.
    const target = await alpha.boundingBox();
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x + 60, target!.y + 4, { steps: 12 });
    await page.mouse.up();
    expect((await saved).ok()).toBe(true);
    await expect(labels).toHaveText(["Gamma", "Alpha", "Beta"]);
    await expect
      .poll(async () =>
        (await fixture.snapshot()).workspaces.map(
          (workspace) => workspace.name,
        ),
      )
      .toEqual(["Gamma", "Alpha", "Beta"]);
    await alpha.locator(".workspace-label").click();
    await alpha.locator(".workspace-label").click();
    await gamma.locator(".session").click();
    await expect
      .poll(async () => (await fixture.snapshot()).currentSessionId)
      .toBe(fixture.sessions[2]!.id);
    await expect(labels).toHaveText(["Gamma", "Alpha", "Beta"]);
    await fixture.restart();
    await expect(labels).toHaveText(["Gamma", "Alpha", "Beta"]);
    expect(
      (await fixture.snapshot()).workspaces.map((workspace) => workspace.name),
    ).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("native conversation hover menu groups actions and restores keyboard focus through submenu Escape and delete Cancel", async ({
  browser,
}) => {
  const fixture = await createMenuHost(browser);
  const { page } = fixture;
  const deleteRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sessions/delete")
      deleteRequests.push(request.url());
  });
  try {
    const row = page
      .locator(".workspace-tree .session-row")
      .filter({ has: page.getByText("Beta conversation", { exact: true }) });
    const trigger = await openConversationMenu(row);
    const menu = page.locator(
      '.sidebar-conversation-menu[role="menu"]:visible',
    );
    await expect(
      menu.getByRole("menuitem", { name: /^重命名/u }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^置顶/u })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "标记为未读", exact: true }),
    ).toBeVisible();
    expect(await menu.getByRole("separator").count()).toBeGreaterThanOrEqual(4);
    await page.screenshot({
      path: test.info().outputPath("native-conversation-menu.png"),
      animations: "disabled",
    });
    const copy = menu.getByRole("menuitem", { name: "复制", exact: true });
    await copy.focus();
    await copy.press("ArrowRight");
    await expect(
      page.getByRole("menuitem", { name: "复制会话链接", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("native-copy-submenu.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menuitem", { name: "复制会话链接", exact: true }),
    ).toBeHidden();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await menu.getByRole("menuitem", { name: "永久删除", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "删除会话？",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "取消", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath("native-delete-dialog.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(deleteRequests).toEqual([]);
    expect(
      (await fixture.snapshot()).sessions.some(
        (session) => session.id === fixture.sessions[1]!.id,
      ),
    ).toBe(true);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("conversation copy exports full native Markdown beyond the bounded transcript preview", async ({
  browser,
}) => {
  const fixture = await createMenuHost(browser);
  const { page } = fixture;
  try {
    expect(
      JSON.stringify((await fixture.snapshot()).selectedSession),
    ).not.toContain("FULL_NATIVE_END");
    const row = page
      .locator(".workspace-tree .session-row")
      .filter({ has: page.getByText("Alpha conversation", { exact: true }) });
    await openConversationMenu(row);
    const copy = page.getByRole("menuitem", { name: "复制", exact: true });
    await copy.focus();
    await copy.press("ArrowRight");
    const response = page.waitForResponse(
      (result) => new URL(result.url()).pathname === "/api/sessions/markdown",
    );
    await page
      .getByRole("menuitem", { name: "复制为 Markdown", exact: true })
      .click();
    const exported = await (await response).json();
    expect(exported.markdown).toContain(fixture.completeAnswer);
    await expect
      .poll(() =>
        page.evaluate(
          () => Reflect.get(window, "sidebarCopiedText") as string | undefined,
        ),
      )
      .toBe(exported.markdown);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("conversation menu forks the native leaf and permanently deletes only its confirmed child", async ({
  browser,
}) => {
  const fixture = await createMenuHost(browser);
  const { page } = fixture;
  try {
    const source = fixture.sessions[0]!;
    const original = await readFile(source.path, "utf8");
    await openConversationMenu(
      page.locator(".workspace-tree .session-row:has(.session.active)"),
    );
    const fork = page.getByRole("menuitem", { name: "分叉", exact: true });
    await fork.focus();
    await fork.press("ArrowRight");
    const forkResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/session/fork",
    );
    await page
      .getByRole("menuitem", { name: "创建聊天分支", exact: true })
      .click();
    const forked = await (await forkResponse).json();
    expect(forked.state).toBe("forked");
    expect(forked.source.sessionId).toBe(source.id);
    await expect
      .poll(async () => (await fixture.snapshot()).currentSessionId)
      .toBe(forked.sessionId);
    const child = SessionManager.open(forked.sessionPath);
    expect(child.getHeader()?.parentSession).toBe(source.path);
    expect(child.getBranch()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "sidebar-menu-fixture",
          data: { nativeTail: 0 },
        }),
      ]),
    );
    expect(child.getEntry(forked.source.entryId)).toMatchObject({
      type: "custom",
      customType: "sidebar-menu-fixture",
    });
    expect(await readFile(source.path, "utf8")).toBe(original);
    await openConversationMenu(
      page.locator(".workspace-tree .session-row:has(.session.active)"),
    );
    await page.getByRole("menuitem", { name: "永久删除", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "删除会话？",
      exact: true,
    });
    const deletion = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/sessions/delete",
    );
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    expect(await (await deletion).json()).toMatchObject({
      state: "deleted",
      sessionId: forked.sessionId,
      sessionPath: forked.sessionPath,
      activeSessionChanged: true,
    });
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () =>
        (await fixture.snapshot()).sessions.some(
          (session) => session.id === forked.sessionId,
        ),
      )
      .toBe(false);
    await expect(readFile(forked.sessionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(source.path, "utf8")).toBe(original);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
