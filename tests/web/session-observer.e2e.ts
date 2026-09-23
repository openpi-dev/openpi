import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { Type } from "typebox";
import { WebHost } from "../../web/host/web-host.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";

function gate() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => entered(),
    release: () => release(),
  };
}

async function observerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "openpi-observer-browser-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const gates = [gate(), gate(), gate(), gate()];
  const aborts = { A: 0, B: 0 };
  const makeRuntime = async (name: "A" | "B") => {
    const agentDir = join(directory, `agent-${name}`);
    await mkdir(agentDir);
    const provider = `observer-fixture-${name}`;
    const faux = fauxProvider({
      api: provider,
      provider,
      models: [{ id: "fixture", name: `Fixture ${name}`, reasoning: false }],
    });
    const holding = (phase: number, label: string) =>
      fauxAssistantMessage(
        [
          { type: "text", text: label },
          fauxToolCall(
            "hold_fixture",
            { phase },
            { id: `hold-${name}-${phase}` },
          ),
        ],
        { stopReason: "toolUse" },
      );
    faux.setResponses(
      name === "A"
        ? [
            holding(0, "A entered the first tool"),
            holding(1, "A entered the second tool"),
            fauxAssistantMessage("A finished"),
            fauxAssistantMessage("A first follow-up finished"),
            fauxAssistantMessage("A second follow-up finished"),
          ]
        : [
            holding(2, "B bootstrap tool is running"),
            fauxAssistantMessage("B bootstrap finished"),
            holding(3, "B consumed its own follow-up"),
            fauxAssistantMessage("B follow-up finished"),
          ],
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(provider, "fixture-key");
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const services = {
      cwd: workspace,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoader: loader,
      diagnostics: [],
    };
    const create: CreateAgentSessionRuntimeFactory = async (options) => {
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        model: faux.getModel(),
        tools: ["read", "hold_fixture"],
        customTools: [
          {
            name: "hold_fixture",
            label: "Hold fixture",
            description: "Wait for the explicit browser test gate",
            parameters: Type.Object({ phase: Type.Number() }),
            async execute(_id, args, signal, onUpdate) {
              if (
                !args ||
                typeof args !== "object" ||
                !("phase" in args) ||
                typeof args.phase !== "number"
              )
                throw new Error("Invalid fixture phase");
              const current = gates[args.phase];
              if (!current) throw new Error("Unknown fixture phase");
              current.enter();
              onUpdate?.({
                content: [
                  { type: "text", text: `Phase ${args.phase} entered` },
                ],
                details: {},
              });
              await Promise.race([
                current.released,
                new Promise<void>((resolve) => {
                  if (signal?.aborted) resolve();
                  else
                    signal?.addEventListener("abort", () => resolve(), {
                      once: true,
                    });
                }),
              ]);
              return {
                content: [{ type: "text", text: "Gate released" }],
                details: {},
              };
            },
          },
        ],
      });
      created.session.setSessionName(`Observer ${name}`);
      const abort = created.session.abort.bind(created.session);
      created.session.abort = async () => {
        aborts[name]++;
        await abort();
      };
      return { ...created, services, diagnostics: [] };
    };
    return createAgentSessionRuntime(create, {
      cwd: workspace,
      agentDir,
      sessionManager: SessionManager.create(
        workspace,
        join(directory, "sessions"),
      ),
    });
  };
  const a = await makeRuntime("A");
  const b = await makeRuntime("B");
  const web = Reflect.construct(PiWebRuntime, [
    b,
    join(directory, "sessions"),
    { timeoutMs: 10000, release: async () => {} },
    { release: async () => {} },
    true,
  ]) as PiWebRuntime;
  const internal = web as unknown as {
    startRuntimeSession(): Promise<void>;
    replaceRuntime(runtime: AgentSessionRuntime): Promise<void>;
  };
  // Reach a real retained-B/current-A state before the browser connects. All
  // later switches and cancellation go through the public authenticated API.
  await internal.startRuntimeSession();
  await web.sendPrompt("Start the B fixture", { commandId: "bootstrap-b" });
  await gates[2]!.entered;
  await internal.replaceRuntime(a);
  const host = new WebHost({ runtime: web });
  await host.start();
  return {
    host,
    web,
    a,
    b,
    gates,
    aborts,
    async close() {
      for (const item of gates) item.release();
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a readonly observer keeps its pending messages and native progress, then retakes control and stops only its Session", async ({
  browser,
}, testInfo) => {
  const fixture = await observerFixture();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const aId = fixture.a.session.sessionManager.getSessionId();
  const aPath = fixture.a.session.sessionManager.getSessionFile()!;
  const bId = fixture.b.session.sessionManager.getSessionId();
  const bPath = fixture.b.session.sessionManager.getSessionFile()!;
  const token = new URLSearchParams(
    new URL(fixture.host.url).hash.slice(1),
  ).get("token")!;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await page.goto(fixture.host.origin);
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("Run observer A");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await fixture.gates[0]!.entered;
    await expect(
      page
        .locator(".conversation")
        .getByText("Run observer A", { exact: true }),
    ).toHaveCount(1);
    const original = fixture.web.getActiveTurn()!;
    const pendingText = "shared pending message";
    for (let index = 0; index < 2; index++) {
      await expect(input).toHaveValue("");
      await input.fill(pendingText);
      if (index === 0) {
        await expect(
          page.getByRole("button", { name: "停止当前轮次", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "发送", exact: true }).click();
      } else {
        await input.press("Enter");
      }
      await expect(input).toHaveValue("");
    }
    const conversation = page.locator(".conversation");
    const queue = page.getByRole("region", { name: "2 条消息正在排队" });
    const ownPending = queue
      .getByRole("listitem")
      .filter({ hasText: pendingText });
    await expect(ownPending).toHaveCount(2);
    await expect(
      conversation.getByText(pendingText, { exact: true }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("2 条消息正在排队", { exact: true }),
    ).toBeVisible();
    const toolbar = page.locator(".composer-toolbar");
    const hint = page.locator(".composer-hint");
    await expect(hint).toHaveAttribute("data-visible", "false");
    await page.reload();
    await expect(ownPending).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 740 });
    await expect(queue).toBeInViewport();
    const queueBounds = await queue.boundingBox();
    const composerBounds = await page.locator(".composer").boundingBox();
    expect(
      queueBounds &&
        composerBounds &&
        queueBounds.y + queueBounds.height <= composerBounds.y,
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("queued-messages-mobile.png"),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const timer = conversation.getByRole("timer");
    await expect(timer).toBeVisible();
    const beforeTimer = await timer.innerText();
    const switched = await context.request.post(
      `${fixture.host.origin}/api/sessions/select`,
      { headers, data: { path: bPath } },
    );
    expect(switched.ok()).toBe(true);
    expect(fixture.web.sessionManager.getSessionId()).toBe(bId);
    const activate = page.getByRole("button", {
      name: "切换到此会话",
      exact: true,
    });
    await expect(activate).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(toolbar).toBeHidden();
    await expect(hint).toHaveAttribute("data-visible", "false");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Observer A",
    );
    const bPrompt = await context.request.post(
      `${fixture.host.origin}/api/prompt`,
      {
        headers,
        data: {
          sessionId: bId,
          sessionPath: bPath,
          commandId: "b-other-client-follow-up",
          content: pendingText,
        },
      },
    );
    expect(bPrompt.status()).toBe(202);
    fixture.gates[2]!.release();
    await fixture.gates[3]!.entered;
    fixture.gates[0]!.release();
    await fixture.gates[1]!.entered;
    await expect(
      conversation.getByText("A entered the second tool", { exact: true }),
    ).toBeVisible();
    await expect(
      conversation.getByText("B consumed its own follow-up", { exact: true }),
    ).toHaveCount(0);
    await expect(ownPending).toHaveCount(2);
    await expect(
      conversation.getByText("2 条消息正在排队", { exact: true }),
    ).toBeVisible();
    await expect(timer).not.toHaveText(beforeTimer);
    await expect(toolbar).toBeHidden();
    await expect(hint).toHaveAttribute("data-visible", "false");
    expect(
      fixture.web
        .getSessionExecution(aId, aPath)
        .liveTools.map((tool) => tool.call.id),
    ).toContain("hold-A-1");
    expect(fixture.web.getSessionExecution(aId, aPath).pendingFollowUps).toBe(
      2,
    );
    await page.screenshot({
      path: testInfo.outputPath("readonly-session-A-progress.png"),
    });
    await activate.click();
    await expect(activate).toHaveCount(0);
    await expect(input).toBeEnabled();
    await expect(toolbar).toBeVisible();
    await expect(hint).toHaveAttribute("data-visible", "false");
    await expect(queue).toBeVisible();
    expect(fixture.web.getActiveTurn()).toMatchObject({
      sessionId: aId,
      commandId: original.commandId,
      epoch: original.epoch,
    });
    const stopRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/turns/cancel" &&
        request.method() === "POST",
    );
    await page
      .getByRole("button", { name: "停止当前轮次", exact: true })
      .click();
    expect((await stopRequest).postDataJSON()).toMatchObject({
      sessionId: aId,
      commandId: original.commandId,
      epoch: original.epoch,
    });
    await expect.poll(() => fixture.a.session.isIdle).toBe(true);
    expect(fixture.aborts.A).toBe(1);
    expect(fixture.aborts.B).toBe(0);
    expect(fixture.b.session.isStreaming).toBe(true);
    await expect(
      page.getByRole("button", { name: "停止当前轮次", exact: true }),
    ).toHaveCount(0);
    await expect(timer).toHaveCount(0);
    await expect(queue).toHaveCount(0);
    await expect(
      conversation
        .locator(".message-row.user .message-body")
        .filter({ hasText: pendingText }),
    ).toHaveCount(2);
    await page.screenshot({
      path: testInfo.outputPath("observer-A-stopped-B-still-running.png"),
    });
  } finally {
    await context.close();
    await fixture.close();
  }
});
