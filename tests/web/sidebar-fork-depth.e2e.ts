import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import { readSessionFork } from "../../web/protocol/session-fork.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import type { WebSessionForkResult } from "../../web/runtime/types.ts";
import { readSessionWorktreeReceipt } from "../../web/runtime/session-worktree.ts";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const labels = {
  "zh-CN": {
    options: "会话选项",
    fork: "分叉",
    local: "创建聊天分支",
    worktree: "在新工作树中创建聊天分支",
    pending: "正在创建工作树和聊天分支…",
    cancelling: "正在请求取消…",
  },
  "en-US": {
    options: "Conversation options",
    fork: "Fork",
    local: "Fork chat",
    worktree: "Fork chat in new worktree",
    pending: "Creating a worktree and conversation…",
    cancelling: "Requesting cancellation…",
  },
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

async function git(cwd: string, ...args: string[]) {
  const result = await execute(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  return result.stdout.trim();
}

function messages(manager: SessionManager) {
  return manager.getBranch().filter((entry) => entry.type === "message");
}

function requireChild(result: WebSessionForkResult) {
  expect(result.state).toBe("forked");
  if (
    result.state !== "forked" ||
    !result.sessionId ||
    !result.sessionPath ||
    !result.cwd
  )
    throw new Error(`No confirmed native fork: ${JSON.stringify(result)}`);
  return {
    ...result,
    sessionId: result.sessionId,
    sessionPath: result.sessionPath,
    cwd: result.cwd,
  };
}

// This is a native Pi + real HTTP Host fixture, with actual isolated Git data.
// The provider only counts accidental calls; no model is called by idle forks.
async function createForkHost(browser: Browser, locale: keyof typeof labels) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "openpi-fork-browser-")),
  );
  const cleanupTasks: Array<() => Promise<unknown>> = [
    () => rm(root, { recursive: true, force: true }),
  ];
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const dispose of cleanupTasks.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Fork browser fixture cleanup failed");
  };
  try {
    const agent = join(root, "agent");
    const sourceRoot = join(root, "Git project");
    const plainRoot = join(root, "Plain project");
    await Promise.all([
      mkdir(join(agent, "extensions"), { recursive: true }),
      mkdir(sourceRoot),
      mkdir(plainRoot),
    ]);
    await git(sourceRoot, "init", "--initial-branch=fixture-source");
    await writeFile(join(sourceRoot, "tracked.txt"), "committed\n");
    await writeFile(join(sourceRoot, ".gitignore"), "ignored.txt\n");
    await git(sourceRoot, "add", "tracked.txt", ".gitignore");
    await git(
      sourceRoot,
      "-c",
      "user.name=Fork fixture",
      "-c",
      "user.email=fork@example.invalid",
      "commit",
      "-m",
      "Fixture base",
    );
    const baseSha = await git(sourceRoot, "rev-parse", "HEAD");
    await writeFile(join(sourceRoot, "tracked.txt"), "staged change\n");
    await git(sourceRoot, "add", "tracked.txt");
    await writeFile(
      join(sourceRoot, "tracked.txt"),
      "staged change\nthen unstaged change\n",
    );
    await mkdir(join(sourceRoot, "new files"));
    await writeFile(
      join(sourceRoot, "new files", "untracked.txt"),
      "untracked fixture\n",
    );
    await writeFile(join(sourceRoot, "ignored.txt"), "excluded fixture\n");
    const sourceStatus = await git(
      sourceRoot,
      "status",
      "--porcelain=v1",
      "-uall",
    );
    const sourceIndex = createHash("sha256")
      .update(await readFile(join(sourceRoot, ".git", "index")))
      .digest("hex");
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      providerRequests++;
      request.resume();
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Fixture forbids live provider requests" },
        }),
      );
    });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    cleanupTasks.push(
      () =>
        new Promise<void>((done, reject) =>
          provider.close((error) => (error ? reject(error) : done())),
        ),
    );
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture provider port");
    const key = `openpi-fork-browser-${root}`;
    const hooks = {
      forkCount: 0,
      wait: undefined as Promise<void> | undefined,
      entered: undefined as (() => void) | undefined,
    };
    Object.assign(globalThis, { [key]: hooks });
    cleanupTasks.push(async () => {
      Reflect.deleteProperty(globalThis, key);
    });
    await writeFile(
      join(agent, "extensions", "fork-gate.ts"),
      `export default function (pi) {
    const hooks = globalThis[${JSON.stringify(key)}];
    pi.on("session_before_fork", async () => {
      hooks.forkCount++;
      hooks.entered?.();
      if (hooks.wait) await hooks.wait;
    });
  }`,
    );
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        packages: [repository],
        defaultProvider: "fork-browser-fixture",
        defaultModel: "fixture",
        defaultThinkingLevel: "medium",
      }),
    );
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "fork-browser-fixture": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-only",
            models: [
              {
                id: "fixture",
                name: "Fork browser fixture",
                reasoning: true,
                input: ["text"],
                contextWindow: 100_000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    cleanupTasks.push(async () => {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
    });
    const provenance = await execute(
      process.execPath,
      [
        join(
          repository,
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "list",
      ],
      { cwd: sourceRoot, env: { ...process.env }, timeout: 30_000 },
    );
    expect(provenance.stdout).toContain(repository);
    await writeFile(
      test.info().outputPath("runtime-provenance.txt"),
      `Checkout: ${repository}\nHEAD: ${await git(repository, "rev-parse", "HEAD")}\nIsolated PI_CODING_AGENT_DIR; packages=[checkout]; actual PiWebRuntime imported from checkout.\n${provenance.stdout}`,
    );
    let runtime = await PiWebRuntime.create(sourceRoot);
    cleanupTasks.push(() => runtime.dispose());
    const answer = `NATIVE_HISTORY_START\n${"Complete saved answer must survive the conversation fork.\n".repeat(800)}NATIVE_HISTORY_END`;
    const sessions = [sourceRoot, plainRoot].map((cwd, index) => {
      const manager =
        index === 0
          ? runtime.sessionManager
          : SessionManager.create(cwd, runtime.sessionDirectory);
      manager.appendModelChange("fork-browser-fixture", "fixture");
      manager.appendThinkingLevelChange("medium");
      manager.appendMessage({
        role: "user",
        content: `Saved question ${index}`,
        timestamp: 1,
      });
      manager.appendMessage({
        ...fauxAssistantMessage(index === 0 ? answer : "Plain project answer"),
        api: "openai-completions",
        provider: "fork-browser-fixture",
        model: "fixture",
        timestamp: 2,
      });
      const title = index === 0 ? "Git conversation" : "Plain conversation";
      manager.appendSessionInfo(title);
      manager.appendCustomEntry("fork-browser-fixture", { nativeTail: index });
      return {
        id: manager.getSessionId(),
        path: manager.getSessionFile()!,
        cwd,
        title,
      };
    });
    const token = "fc".repeat(32);
    let host = new WebHost({ runtime, token });
    cleanupTasks.push(() => host.stop());
    const context = await browser.newContext({
      locale,
      viewport: { width: 1440, height: 1000 },
      colorScheme: "light",
    });
    cleanupTasks.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    const prohibited: string[] = [];
    const forkRequests: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/session/fork")
        forkRequests.push(request.postDataJSON());
    });
    await context.route(/\/api\/(?:prompt|sessions\/open)$/u, (route) => {
      prohibited.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        status: 500,
        json: {
          error:
            "Fixture forbids browser model requests and external application launch",
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
      const result: unknown = await response.json();
      expect(response.ok, `Host ${path}: ${JSON.stringify(result)}`).toBe(true);
      return result;
    };
    await host.start();
    await api("/api/settings/preferences", {
      sidebarGrouping: "project",
      projectsInRecents: false,
      theme: "light",
    });
    await api("/api/workspaces/order", { path: plainRoot, before: null });
    await api("/api/workspaces/order", { path: sourceRoot, before: plainRoot });
    await page.goto(host.origin);
    await expect(
      page.locator(".workspace-tree .workspace-label strong"),
    ).toHaveText(["Git project", "Plain project"]);
    return {
      page,
      hooks,
      sourceRoot,
      baseSha,
      sessions,
      errors,
      prohibited,
      forkRequests,
      get runtime() {
        return runtime;
      },
      get providerRequests() {
        return providerRequests;
      },
      api,
      snapshot: async () => (await api("/api/snapshot")) as WebSnapshot,
      async restart(path: string) {
        const port = Number(new URL(host.origin).port);
        await page.goto("about:blank");
        await host.stop();
        runtime = await PiWebRuntime.create(sourceRoot);
        await runtime.switchSession(path);
        host = new WebHost({ runtime, token, port });
        await host.start();
        await page.goto(host.origin);
      },
      async verifySourceGit() {
        expect(await git(sourceRoot, "rev-parse", "HEAD")).toBe(baseSha);
        expect(await git(sourceRoot, "symbolic-ref", "--short", "HEAD")).toBe(
          "fixture-source",
        );
        expect(await git(sourceRoot, "status", "--porcelain=v1", "-uall")).toBe(
          sourceStatus,
        );
        expect(
          createHash("sha256")
            .update(await readFile(join(sourceRoot, ".git", "index")))
            .digest("hex"),
        ).toBe(sourceIndex);
      },
      async close() {
        await page
          .screenshot({
            path: test.info().outputPath("fork-flow-final.png"),
            animations: "disabled",
          })
          .catch(() => {});
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function rowFor(page: Page, title: string) {
  return page
    .locator(".workspace-tree .session-row")
    .filter({ has: page.getByText(title, { exact: true }) });
}

async function openMenu(row: Locator, locale: keyof typeof labels) {
  await row.hover();
  const trigger = row.getByRole("button", {
    name: labels[locale].options,
    exact: true,
  });
  await expect(row.locator(":scope > .astryx-menu-trigger")).toHaveCSS(
    "opacity",
    "1",
  );
  await trigger.focus();
  await trigger.press("Enter");
  return trigger;
}

async function enterFork(page: Page, locale: keyof typeof labels) {
  const parent = page.getByRole("menuitem", {
    name: labels[locale].fork,
    exact: true,
  });
  await parent.focus();
  await parent.press("ArrowRight");
  await expect(
    page.getByRole("menuitem", { name: labels[locale].local, exact: true }),
  ).toBeFocused();
  return parent;
}

async function clickFork(
  page: Page,
  locale: keyof typeof labels,
  environment: "local" | "worktree",
) {
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === "/api/session/fork" &&
      result.request().method() === "POST",
  );
  await page
    .getByRole("menuitem", { name: labels[locale][environment], exact: true })
    .click();
  const result = await response;
  const receipt = (await result.json()) as WebSessionForkResult;
  expect(result.ok(), JSON.stringify(receipt)).toBe(true);
  return receipt;
}

async function assertProjectSelection(page: Page, title: string) {
  const group = page.locator(".workspace-tree > .workspace-group").filter({
    has: page.locator(".workspace-label strong", {
      hasText: /^Git project$/u,
    }),
  });
  await expect(group.locator(".workspace-label")).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expect(group.locator(".workspace-label")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(group.locator(".workspace-folder")).toHaveCSS(
    "color",
    "rgb(66, 99, 235)",
  );
  await expect(group.locator(".session.active")).toContainText(title);
  await expect(
    page.locator(".workspace-tree .workspace-label strong"),
  ).toHaveText(["Git project", "Plain project"]);
}

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`${locale}: native fork submenu, return navigation, Git eligibility, complete local history and detached dirty worktree`, async ({
    browser,
  }) => {
    const fixture = await createForkHost(browser, locale);
    const { page } = fixture;
    const text = labels[locale];
    try {
      const source = fixture.sessions[0]!;
      const original = await readFile(source.path, "utf8");
      const originalMessages = messages(SessionManager.open(source.path));
      const plain = rowFor(page, "Plain conversation");
      const plainOptions = page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname === "/api/sessions/fork-options",
      );
      const plainTrigger = await openMenu(plain, locale);
      expect(await (await plainOptions).json()).toMatchObject({
        local: true,
        worktree: false,
      });
      await enterFork(page, locale);
      await expect(
        page.getByRole("menuitem", { name: text.worktree, exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("menuitem", { name: text.local, exact: true })
        .press("Escape");
      await expect(
        page.getByRole("menuitem", { name: text.fork, exact: true }),
      ).toBeFocused();
      await page
        .getByRole("menuitem", { name: text.fork, exact: true })
        .press("Escape");
      await expect(plainTrigger).toBeFocused();
      const sourceRow = rowFor(page, "Git conversation");
      const options = page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname === "/api/sessions/fork-options",
      );
      const trigger = await openMenu(sourceRow, locale);
      expect(await (await options).json()).toMatchObject({
        local: true,
        worktree: true,
      });
      const parent = await enterFork(page, locale);
      const local = page.getByRole("menuitem", {
        name: text.local,
        exact: true,
      });
      await expect(
        page.getByRole("menuitem", { name: text.worktree, exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`fork-submenu-${locale}.png`),
        animations: "disabled",
      });
      await local.press("ArrowLeft");
      await expect(parent).toBeFocused();
      await expect(local).toBeHidden();
      // Astryx suppresses accidental re-entry when a just-closed flyout
      // exposes its trigger under the pointer. Deliberately leave and return.
      await parent.hover();
      await page
        .locator('.sidebar-conversation-menu[role="menu"]:visible')
        .getByRole("menuitem")
        .first()
        .hover();
      await parent.hover();
      await expect(local).toBeVisible();
      await local.hover();
      await expect(
        page.getByRole("menuitem", { name: text.worktree, exact: true }),
      ).toBeVisible();
      await page.locator(".sidebar-brand-title").click();
      await expect(
        page.locator('.sidebar-conversation-menu[role="menu"]:visible'),
      ).toHaveCount(0);
      expect(fixture.forkRequests).toEqual([]);
      // Native popover light-dismiss precedes React's toggle notification.
      // Reopen only once its public trigger state confirms the close.
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.focus();
      await trigger.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await enterFork(page, locale);
      const localFork = requireChild(await clickFork(page, locale, "local"));
      expect(localFork).toMatchObject({
        environment: "local",
        cwd: source.cwd,
        workspacePath: source.cwd,
        source: { sessionId: source.id, sessionPath: source.path },
        snapshot: { kind: "persisted-prefix", interrupted: false },
        sourceStillRunning: false,
      });
      const localManager = SessionManager.open(localFork.sessionPath);
      expect(localManager.getHeader()?.parentSession).toBe(source.path);
      expect(localManager.getCwd()).toBe(source.cwd);
      expect(messages(localManager)).toEqual(originalMessages);
      expect(JSON.stringify(messages(localManager))).toContain(
        "NATIVE_HISTORY_END",
      );
      expect(localManager.getSessionName()).toBe("Git conversation (2)");
      await assertProjectSelection(page, "Git conversation (2)");
      expect(await readFile(source.path, "utf8")).toBe(original);
      await openMenu(sourceRow, locale);
      await enterFork(page, locale);
      const worktreeFork = requireChild(
        await clickFork(page, locale, "worktree"),
      );
      expect(worktreeFork.environment).toBe("worktree");
      expect(worktreeFork.workspacePath).toBe(source.cwd);
      expect(worktreeFork.cwd).not.toBe(source.cwd);
      expect(worktreeFork.worktree).toMatchObject({
        path: worktreeFork.cwd,
        baseSha: fixture.baseSha,
        sourceRoot: source.cwd,
      });
      expect(await git(worktreeFork.cwd, "rev-parse", "HEAD")).toBe(
        fixture.baseSha,
      );
      expect(await git(worktreeFork.cwd, "branch", "--show-current")).toBe("");
      expect(
        await readFile(join(worktreeFork.cwd, "tracked.txt"), "utf8"),
      ).toBe("staged change\nthen unstaged change\n");
      expect(
        await readFile(
          join(worktreeFork.cwd, "new files", "untracked.txt"),
          "utf8",
        ),
      ).toBe("untracked fixture\n");
      await expect(
        readFile(join(worktreeFork.cwd, "ignored.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const worktreeManager = SessionManager.open(worktreeFork.sessionPath);
      expect(worktreeManager.getCwd()).toBe(worktreeFork.cwd);
      expect(worktreeManager.getHeader()?.parentSession).toBe(source.path);
      expect(worktreeManager.getSessionName()).toBe("Git conversation (3)");
      expect(messages(worktreeManager)).toEqual(originalMessages);
      expect(
        readSessionFork(
          worktreeManager.getBranch(),
          worktreeFork.sessionId,
          worktreeFork.cwd,
        ),
      ).toMatchObject({
        workspacePath: source.cwd,
        cwd: worktreeFork.cwd,
        environment: "worktree",
      });
      await assertProjectSelection(page, "Git conversation (3)");
      await expect(
        rowFor(page, "Git conversation (3)").locator(".sidebar-worktree-icon"),
      ).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await fixture.snapshot()).sessions.find(
              (session) => session.id === worktreeFork.sessionId,
            )?.cwd,
        )
        .toBe(worktreeFork.cwd);
      await fixture.restart(worktreeFork.sessionPath);
      await assertProjectSelection(page, "Git conversation (3)");
      expect(
        (await fixture.snapshot()).sessions.find(
          (session) => session.id === worktreeFork.sessionId,
        ),
      ).toMatchObject({
        cwd: worktreeFork.cwd,
        workspacePath: source.cwd,
        worktree: { baseSha: fixture.baseSha },
      });
      expect(await readFile(source.path, "utf8")).toBe(original);
      await fixture.verifySourceGit();
      expect(fixture.providerRequests).toBe(0);
      expect(fixture.prohibited).toEqual([]);
      expect(fixture.errors).toEqual([]);
      expect(fixture.forkRequests).toHaveLength(2);
      expect(fixture.forkRequests).toEqual([
        expect.objectContaining({
          scope: "conversation",
          sessionId: source.id,
          sessionPath: source.path,
        }),
        expect.objectContaining({
          scope: "conversation",
          environment: "worktree",
          sessionId: source.id,
          sessionPath: source.path,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
}

test("native before-fork gate keeps cancellation pending until the receipt and removes only the prepared worktree", async ({
  browser,
}) => {
  const fixture = await createForkHost(browser, "zh-CN");
  const entered = gate();
  const release = gate();
  fixture.hooks.wait = release.promise;
  fixture.hooks.entered = entered.release;
  try {
    const source = fixture.sessions[0]!;
    const original = await readFile(source.path, "utf8");
    const beforeIds = (await fixture.snapshot()).sessions
      .map((session) => session.id)
      .sort();
    const initialWorktrees = await git(
      fixture.sourceRoot,
      "worktree",
      "list",
      "--porcelain",
    );
    await openMenu(rowFor(fixture.page, source.title), "zh-CN");
    await enterFork(fixture.page, "zh-CN");
    let finished = false;
    const receipt = clickFork(fixture.page, "zh-CN", "worktree").then(
      (result) => {
        finished = true;
        return result;
      },
    );
    await entered.promise;
    expect(
      await git(fixture.sourceRoot, "worktree", "list", "--porcelain"),
    ).not.toBe(initialWorktrees);
    const progress = fixture.page.locator(".session-fork-progress");
    await expect(progress).toContainText(labels["zh-CN"].pending);
    const cancellation = fixture.page.waitForResponse(
      (result) => new URL(result.url()).pathname === "/api/session/fork/cancel",
    );
    await progress.getByRole("button", { name: "取消", exact: true }).click();
    expect(await (await cancellation).json()).toEqual({ state: "requested" });
    await expect(progress).toContainText(labels["zh-CN"].cancelling);
    await expect(
      progress.getByRole("button", { name: "取消", exact: true }),
    ).toBeDisabled();
    expect(finished).toBe(false);
    await fixture.page.screenshot({
      path: test.info().outputPath("fork-cancellation-pending.png"),
      animations: "disabled",
    });
    release.release();
    expect(await receipt).toMatchObject({
      state: "cancelled",
      environment: "worktree",
      source: { sessionId: source.id },
    });
    await expect(progress).toBeHidden();
    await expect
      .poll(async () =>
        (await fixture.snapshot()).sessions.map((session) => session.id).sort(),
      )
      .toEqual(beforeIds);
    expect((await fixture.snapshot()).currentSessionId).toBe(source.id);
    expect(await readFile(source.path, "utf8")).toBe(original);
    expect(
      await git(fixture.sourceRoot, "worktree", "list", "--porcelain"),
    ).toBe(initialWorktrees);
    await fixture.verifySourceGit();
    await assertProjectSelection(fixture.page, source.title);
    expect(fixture.providerRequests).toBe(0);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    release.release();
    await fixture.close();
  }
});

test("forking an active native stream freezes the saved prefix while the source continues independently", async ({
  browser,
}) => {
  const fixture = await createForkHost(browser, "en-US");
  const entered = gate();
  const release = gate();
  const source = fixture.sessions[0]!;
  const owner = (fixture.runtime as unknown as { runtime: AgentSessionRuntime })
    .runtime;
  let streamCalls = 0;
  let aborts = 0;
  owner.session.refreshContext();
  owner.session.agent.streamFunction = (model, _context, options) => {
    streamCalls++;
    const stream = createAssistantMessageEventStream();
    const onAbort = () => {
      aborts++;
      release.release();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      const identity = {
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      const partial = {
        ...fauxAssistantMessage("UNPERSISTED_STREAMING_TEXT"),
        ...identity,
      };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "UNPERSISTED_STREAMING_TEXT",
        partial,
      });
      entered.release();
      await release.promise;
      options?.signal?.removeEventListener("abort", onAbort);
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          ...fauxAssistantMessage("SOURCE_COMPLETED_AFTER_FORK"),
          ...identity,
        },
      });
    })();
    return stream;
  };
  try {
    await fixture.runtime.sendPrompt("Continue source while I fork it", {
      commandId: "browser-source-turn",
      expectedSessionId: source.id,
      expectedSessionPath: source.path,
    });
    await entered.promise;
    expect(
      fixture.runtime.getSessionExecution(source.id, source.path).status,
    ).toBe("running");
    const prefix = messages(SessionManager.open(source.path));
    expect(JSON.stringify(prefix)).toContain("Continue source while I fork it");
    expect(JSON.stringify(prefix)).not.toContain("UNPERSISTED_STREAMING_TEXT");
    await openMenu(rowFor(fixture.page, source.title), "en-US");
    await enterFork(fixture.page, "en-US");
    const child = requireChild(await clickFork(fixture.page, "en-US", "local"));
    expect(child).toMatchObject({
      sourceStillRunning: true,
      snapshot: { kind: "persisted-prefix", interrupted: true },
    });
    const manager = SessionManager.open(child.sessionPath);
    expect(messages(manager)).toEqual(prefix);
    expect(
      readSessionFork(manager.getBranch(), child.sessionId, child.cwd)?.snapshot
        ?.interrupted,
    ).toBe(true);
    expect(
      fixture.runtime.getSessionExecution(source.id, source.path).status,
    ).toBe("running");
    expect(
      fixture.runtime.getSessionExecution(child.sessionId, child.sessionPath)
        .status,
    ).toBe("idle");
    expect(fixture.runtime.cwd).toBe(source.cwd);
    expect(aborts).toBe(0);
    expect(streamCalls).toBe(1);
    await assertProjectSelection(fixture.page, "Git conversation (2)");
    await expect(
      fixture.page.getByText("Forked · Ready to continue", { exact: true }),
    ).toBeVisible();
    await expect(
      fixture.page.getByText("Waiting for response", { exact: true }),
    ).toHaveCount(0);
    await fixture.page.screenshot({
      path: test.info().outputPath("active-source-idle-child.png"),
      animations: "disabled",
    });
    const frozenChild = await readFile(child.sessionPath, "utf8");
    release.release();
    await owner.session.waitForIdle();
    // A drained retained runtime is disposed, so its live status becomes
    // unknown. The exact persisted turn receipt proves terminal completion.
    await expect
      .poll(
        () =>
          fixture.runtime.getSessionExecution(source.id, source.path).lastTurn,
      )
      .toMatchObject({
        commandId: "browser-source-turn",
        outcome: "completed",
      });
    expect(await readFile(source.path, "utf8")).toContain(
      "SOURCE_COMPLETED_AFTER_FORK",
    );
    expect(await readFile(child.sessionPath, "utf8")).toBe(frozenChild);
    expect(frozenChild).not.toContain("UNPERSISTED_STREAMING_TEXT");
    expect(frozenChild).not.toContain("SOURCE_COMPLETED_AFTER_FORK");
    expect(aborts).toBe(0);
    expect(streamCalls).toBe(1);
    expect(fixture.providerRequests).toBe(0);
    expect(fixture.prohibited).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    release.release();
    await fixture.close();
  }
});

test("retained managed worktrees remain discoverable after reload and native restart, require confirmation and replay lost receipts", async ({
  browser,
}) => {
  const fixture = await createForkHost(browser, "en-US");
  const { page } = fixture;
  try {
    const source = fixture.sessions[0]!;
    await openMenu(rowFor(page, "Git conversation"), "en-US");
    await enterFork(page, "en-US");
    const child = requireChild(await clickFork(page, "en-US", "worktree"));
    const project = page.locator(".workspace-tree > .workspace-group").filter({
      has: page.locator(".workspace-label strong", {
        hasText: /^Git project$/u,
      }),
    });
    const openRetained = async () => {
      const trigger = project.getByRole("button", {
        name: "Workspace options",
        exact: true,
      });
      await trigger.focus();
      await trigger.press("Enter");
      await page
        .getByRole("menuitem", { name: "Retained worktrees", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Retained worktrees",
        exact: true,
      });
      await expect(dialog.getByText(child.cwd, { exact: true })).toBeVisible();
      return { trigger, dialog };
    };
    // An extant canonical child keeps its worktree: UI never calls listing eligibility.
    let view = await openRetained();
    await view.dialog
      .getByRole("button", { name: "Review removal", exact: true })
      .click();
    await view.dialog
      .getByRole("button", { name: "Remove worktree", exact: true })
      .click();
    await expect(view.dialog.getByRole("status")).toContainText(
      "Worktree kept:",
    );
    await expect(
      view.dialog.getByText(child.cwd, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(view.dialog).toBeHidden();
    await expect(view.trigger).toBeFocused();
    // A native local descendant shares this actual cwd and must retain it too.
    const descendant = requireChild(
      (await fixture.api("/api/session/fork", {
        commandId: "retained-local-descendant",
        scope: "conversation",
        environment: "local",
        sessionId: child.sessionId,
        sessionPath: child.sessionPath,
      })) as WebSessionForkResult,
    );
    expect(descendant.cwd).toBe(child.cwd);
    // Delete only the Session through its exact native identity, retaining cwd.
    await rowFor(page, "Git conversation").locator("button.session").click();
    await expect
      .poll(async () => (await fixture.snapshot()).currentSessionId)
      .toBe(source.id);
    await fixture.api("/api/sessions/delete", {
      commandId: "retained-delete",
      sessionId: child.sessionId,
      sessionPath: child.sessionPath,
    });
    await page.reload();
    view = await openRetained();
    await view.dialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await fixture.restart(source.path);
    view = await openRetained();
    await view.dialog
      .getByRole("button", { name: "Review removal", exact: true })
      .click();
    await expect(
      view.dialog.getByText(child.cwd, { exact: true }),
    ).toBeVisible();
    await view.dialog
      .getByRole("button", { name: "Remove worktree", exact: true })
      .click();
    await expect(view.dialog.getByRole("status")).toContainText(
      "Worktree kept:",
    );
    await page.keyboard.press("Escape");
    await fixture.api("/api/sessions/delete", {
      commandId: "retained-delete-descendant",
      sessionId: descendant.sessionId,
      sessionPath: descendant.sessionPath,
    });
    await page.reload();
    view = await openRetained();
    await view.dialog
      .getByRole("button", { name: "Review removal", exact: true })
      .click();
    const requests: Record<string, unknown>[] = [];
    let loseFirstReceipt = true;
    await page.route("**/api/sessions/worktree-release", async (route) => {
      requests.push(route.request().postDataJSON());
      if (loseFirstReceipt) {
        loseFirstReceipt = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await view.dialog
      .getByRole("button", { name: "Remove worktree", exact: true })
      .click();
    await expect(view.dialog.getByRole("status")).toContainText(
      "Removal outcome is unknown",
    );
    await view.dialog
      .getByRole("button", { name: "Retry request", exact: true })
      .click();
    await expect(view.dialog.getByRole("status")).toContainText(
      "Worktree removed.",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      sessionId: child.sessionId,
      sessionPath: child.sessionPath,
      worktreePath: child.cwd,
    });
    await view.dialog
      .getByRole("button", { name: "Back to worktrees", exact: true })
      .click();
    await expect(view.dialog.getByText(child.cwd, { exact: true })).toHaveCount(
      0,
    );
    await fixture.verifySourceGit();
    expect(fixture.providerRequests).toBe(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("native uncertain worktree outcomes survive new commands, restart and unreadable receipt without offering removal retry", async ({
  browser,
}) => {
  const fixture = await createForkHost(browser, "en-US");
  const { page } = fixture;
  try {
    const source = fixture.sessions[0]!;
    await openMenu(rowFor(page, "Git conversation"), "en-US");
    await enterFork(page, "en-US");
    const child = requireChild(await clickFork(page, "en-US", "worktree"));
    await rowFor(page, "Git conversation").locator("button.session").click();
    await expect
      .poll(async () => (await fixture.snapshot()).currentSessionId)
      .toBe(source.id);
    await fixture.api("/api/sessions/delete", {
      commandId: "delete-uncertain-owner",
      sessionId: child.sessionId,
      sessionPath: child.sessionPath,
    });
    const receipt = await readSessionWorktreeReceipt(
      child.cwd,
      dirname(child.sessionPath),
    );
    // Simulate the persisted crash window after an exact native resource claim.
    await writeFile(
      join(receipt.gitDir, "openpi-session-worktree.json.release-lock"),
      JSON.stringify(receipt),
      { flag: "wx", mode: 0o600 },
    );
    const commands: string[] = [];
    await page.route("**/api/sessions/worktree-release", async (route) => {
      commands.push(route.request().postDataJSON().commandId);
      await route.continue();
    });
    const verify = async (beforeRelease?: () => Promise<void>) => {
      const project = page
        .locator(".workspace-tree > .workspace-group")
        .filter({
          has: page.locator(".workspace-label strong", {
            hasText: /^Git project$/u,
          }),
        });
      const trigger = project.getByRole("button", {
        name: "Workspace options",
        exact: true,
      });
      await trigger.focus();
      await trigger.press("Enter");
      await page
        .getByRole("menuitem", { name: "Retained worktrees", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Retained worktrees",
        exact: true,
      });
      await expect(dialog.getByText(child.cwd, { exact: true })).toBeVisible();
      await dialog
        .getByRole("button", { name: "Review removal", exact: true })
        .click();
      await beforeRelease?.();
      await dialog
        .getByRole("button", { name: "Remove worktree", exact: true })
        .click();
      await expect(dialog.getByRole("status")).toContainText(
        "Removal outcome is uncertain",
      );
      await expect(
        dialog.getByRole("button", { name: "Retry request", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Remove worktree", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Back to worktrees", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    };
    await page.reload();
    await verify();
    await fixture.restart(source.path);
    const marker = join(receipt.gitDir, "openpi-session-worktree.json");
    // Discovery captured a valid target, then its private receipt becomes unreadable.
    // ENOENT is deterministic across platforms and must not downgrade the existing claim.
    try {
      await verify(() => rename(marker, `${marker}.unreadable-fixture`));
    } finally {
      await rename(`${marker}.unreadable-fixture`, marker);
    }
    expect(commands).toHaveLength(2);
    expect(commands[1]).not.toBe(commands[0]);
    expect(await readFile(join(child.cwd, "tracked.txt"), "utf8")).toBeTruthy();
    expect(fixture.providerRequests).toBe(0);
  } finally {
    await fixture.close();
  }
});
