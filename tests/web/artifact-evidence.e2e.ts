import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  createReadTool,
  createEditTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebHost } from "../../web/host/web-host.ts";
import { createEvidenceWriteTool } from "../../web/runtime/write-evidence.ts";
import type {
  WebRuntimeController,
  WebRuntimeEvent,
} from "../../web/runtime/types.ts";

test("real file evidence, authenticated downloads, edits, refresh and failure states", async ({
  browser,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-evidence-browser-"));
  const manager = SessionManager.inMemory(cwd);
  const path = join(cwd, "report space.md");
  const writeTool = createEvidenceWriteTool(cwd);
  const writer = {
    execute: (id: string, args: { path: string; content: string }) =>
      writeTool.execute(id, args, undefined, undefined, undefined!),
  };
  const initial = await writer.execute("write-1", {
    path,
    content: "# First report\nInitial content\n\n[Related](./sibling.md)",
  });
  await writer.execute("sibling", {
    path: join(cwd, "sibling.md"),
    content: "# Related report",
  });
  const read = await createReadTool(cwd).execute("read-1", { path });
  const edit = await createEditTool(cwd).execute("edit-1", {
    path,
    edits: [{ oldText: "Initial content", newText: "Reviewed content" }],
  });
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  manager.appendMessage({
    role: "user",
    content: "Create a report and verify it",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: {
          path,
          content: "# First report\nInitial content\n\n[Related](./sibling.md)",
        },
      },
      {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path, offset: 1 },
      },
      {
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: {
          path,
          edits: [{ oldText: "Initial content", newText: "Reviewed content" }],
        },
      },
      {
        type: "toolCall",
        id: "test-1",
        name: "bash",
        arguments: { command: "node --test" },
      },
      {
        type: "toolCall",
        id: "term-1",
        name: "bash",
        arguments: { command: "fixture-command" },
      },
      {
        type: "toolCall",
        id: "future-1",
        name: "future_tool",
        arguments: { input: "unknown" },
      },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  for (const row of [
    { id: "write-1", name: "write", result: initial },
    { id: "read-1", name: "read", result: read },
    { id: "edit-1", name: "edit", result: edit },
  ])
    manager.appendMessage({
      role: "toolResult",
      toolCallId: row.id,
      toolName: row.name,
      ...row.result,
      isError: false,
      timestamp: Date.now(),
    });
  for (const row of [
    {
      id: "test-1",
      name: "bash",
      content:
        "TAP version 13\nnot ok 1 - fixture failure\n# tests 1\n# pass 0\n# fail 1\n\nCommand exited with code 1",
      isError: true,
    },
    {
      id: "term-1",
      name: "bash",
      content: "fixture log\n\nCommand aborted",
      isError: true,
    },
    {
      id: "future-1",
      name: "future_tool",
      content: "unknown tool evidence",
      isError: false,
    },
  ])
    manager.appendMessage({
      role: "toolResult",
      toolCallId: row.id,
      toolName: row.name,
      content: [{ type: "text", text: row.content }],
      isError: row.isError,
      timestamp: Date.now(),
    });
  assistant("[Report](./report%20space.md)\n\n[Missing](./missing.md)");
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [
      {
        provider: "fixture",
        id: "fixture",
        name: "Fixture",
        label: "Fixture",
        current: true,
      },
    ],
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: async () => {
      listeners.clear();
    },
    sendPrompt: async (content) => {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
      await writer.execute("write-2", {
        path,
        content: "# Updated report\nSecond version",
      });
      assistant("The report has been updated.");
      for (const listener of listeners)
        listener({
          type: "message_end",
          detail: { sessionId: manager.getSessionId() },
        });
      return { pendingFollowUps: 0 };
    },
  };
  const host = new WebHost({ runtime });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await host.start();
    await page.goto(host.origin);
    await expect(
      page.getByRole("button", { name: "Report", exact: true }),
    ).toBeVisible();
    for (const group of await page.locator(".tool-group > summary").all())
      await group.click();
    for (const summary of await page
      .locator(".tool-evidence-card > summary")
      .all())
      await summary.click();
    await expect(
      page.getByRole("figure", { name: "File content" }),
    ).toContainText("Initial content");
    await expect(
      page
        .locator(".tool-evidence-card")
        .filter({ has: page.locator("summary strong", { hasText: "edit" }) })
        .getByRole("figure", { name: "Change diff" }),
    ).toContainText("Reviewed content");
    const writeCard = page
      .locator(".tool-evidence-card")
      .filter({ has: page.locator("summary strong", { hasText: "write" }) });
    await expect(writeCard).toContainText("File created");
    await expect(
      writeCard.getByRole("figure", { name: "Change diff" }),
    ).toContainText("+1 # First report");
    await expect(
      page.getByRole("figure", { name: "Test evidence" }),
    ).toContainText("1 failed");
    await expect(page.locator(".evidence-terminal")).toContainText("cancelled");
    expect(
      (await new AxeBuilder({ page }).include(".tool-evidence-card").analyze())
        .violations,
    ).toEqual([]);
    await page.locator(".evidence-file").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(tmpdir(), "openpi-345-renderers.png"),
      fullPage: true,
    });
    await expect(
      page.getByText("unknown tool evidence", { exact: true }).first(),
    ).toBeAttached();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Reviewed content");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const downloaded = await downloadPromise;
    expect(await readFile((await downloaded.path())!, "utf8")).toContain(
      "Reviewed content",
    );
    await page.screenshot({
      path: join(tmpdir(), "openpi-345-evidence-preview.png"),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page })
      .include(".artifact-panel")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "Related", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Related report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Related report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    const prompt = page.getByRole("textbox", { name: /描述任务|Describe/i });
    await prompt.fill("Update the report");
    await prompt.press("Enter");
    await expect(page.getByText("The report has been updated.")).toBeVisible();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Updated report" }),
    ).toBeVisible();
    await writer.execute("write-external", {
      path,
      content: "# Latest report\nExternal revision",
    });
    await expect(
      page.getByRole("heading", { name: "Latest report" }),
    ).toBeVisible({ timeout: 8_000 });
    await rm(path);
    await expect(page.getByRole("dialog")).toContainText(
      "Showing an older preview",
      { timeout: 8_000 },
    );
    await writer.execute("write-restore", {
      path,
      content: "# Restored report",
    });
    await page.reload();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Restored report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await page.getByRole("button", { name: "Missing", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "File no longer exists",
    );
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
