import { expect, test } from "@playwright/test";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import type { WebSessionForkRequest } from "../../web/runtime/types.ts";

test("older-message edit and successful regeneration use an exact new branch, retain attachments on rejection, and return to the original", async ({
  page,
}, testInfo) => {
  const source = {
    sessionId: "rerun-source",
    sessionPath: "/mock/workspace/source.jsonl",
    entryId: "older-question",
  };
  const images = [
    {
      mimeType: "image/png",
      name: "original.png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
    },
  ];
  let child = false;
  let rejected = true;
  const forks: WebSessionForkRequest[] = [];
  const prompts: Array<{
    sessionId: string;
    sessionPath: string;
    content: string;
    images: typeof images;
  }> = [];
  let base: WebSnapshot | undefined;
  const projection = () =>
    ({
      id: child ? `rerun-child-${forks.length}` : source.sessionId,
      path: child
        ? `/mock/workspace/child-${forks.length}.jsonl`
        : source.sessionPath,
      cwd: "/mock/workspace",
      bytes: 10,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2_097_152,
      },
      history: {
        leafEntryId: child ? null : "later-question",
        beforeEntryId: null,
      },
      ...(child
        ? { rerun: { source, mode: forks.at(-1)?.rerun?.mode ?? "edit" } }
        : {}),
      entries: child
        ? []
        : [
            {
              type: "message",
              id: source.entryId,
              timestamp: "2026-10-02T00:00:00Z",
              message: { role: "user", content: "原来的第一条问题" },
            },
            {
              type: "message",
              id: "successful-answer",
              timestamp: "2026-10-02T00:00:01Z",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: "原回答，必须保留在原对话。",
              },
            },
            {
              type: "message",
              id: "later-question",
              timestamp: "2026-10-02T00:00:02Z",
              message: { role: "user", content: "后来的第二条问题" },
            },
          ],
    }) satisfies WebSnapshot["selectedSession"];
  await page.route("**/events?**", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": idle\n\n" }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    if (!base) base = (await (await route.fetch()).json()) as WebSnapshot;
    const value = structuredClone(base);
    const selected = projection();
    value.workspaces = [
      { path: selected.cwd, name: "Rerun fixture", current: true },
    ];
    value.sessions = [
      {
        id: selected.id,
        path: selected.path,
        cwd: selected.cwd,
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        created: "2026-10-02T00:00:00Z",
        modified: "2026-10-02T00:00:00Z",
        messageCount: selected.entries.length,
        firstMessage: "原来的第一条问题",
      },
    ];
    value.currentSessionId = selected.id;
    value.currentSessionPath = selected.path;
    value.selectedSession = selected;
    value.selectedExecution = undefined;
    value.runtime = { status: "idle", capabilities: {} };
    await route.fulfill({ json: value });
  });
  await page.route("**/api/session/fork", async (route) => {
    const request = route.request().postDataJSON() as WebSessionForkRequest;
    forks.push(request);
    child = true;
    await route.fulfill({
      json: {
        state: "forked",
        commandId: request.commandId,
        source,
        sessionId: `rerun-child-${forks.length}`,
        sessionPath: `/mock/workspace/child-${forks.length}.jsonl`,
        prompt: {
          content:
            request.rerun?.mode === "edit"
              ? `${request.rerun.content}\n\n[attached.txt](</mock/workspace/original/attached.txt>)`
              : "原来的第一条问题",
          images,
        },
      },
    });
  });
  await page.route("**/api/prompt", async (route) => {
    const body = route.request().postDataJSON();
    prompts.push(body);
    await route.fulfill(
      rejected
        ? {
            status: 422,
            json: { code: "PROMPT_REJECTED", error: "确定拒绝，未启动模型" },
          }
        : { status: 202, json: { id: body.commandId, accepted: true } },
    );
  });
  await page.route("**/api/sessions/select", async (route) => {
    expect(route.request().postDataJSON().path).toBe(source.sessionPath);
    child = false;
    await route.fulfill({
      json: {
        cancelled: false,
        sessionId: source.sessionId,
        path: source.sessionPath,
      },
    });
  });
  await page.route("**/api/session/message-window**", (route) =>
    route.fulfill({
      json: {
        session: {
          ...projection(),
          history: {
            leafEntryId: "later-question",
            beforeEntryId: null,
            anchorEntryId: source.entryId,
            anchorOnBranch: true,
          },
        },
      },
    }),
  );
  for (const width of [1440, 390]) {
    child = false;
    rejected = true;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const older = page.locator(`[data-history-entry="${source.entryId}"]`);
    await older.hover();
    await older.getByRole("button", { name: "修改并从这里重跑" }).click();
    const editor = page.getByRole("textbox", { name: "修改并从这里重跑" });
    await editor.fill("修改后的第一条问题");
    await page.screenshot({
      path: testInfo.outputPath(`edit-from-here-${width}.png`),
    });
    await page.getByRole("button", { name: "保存并重新运行" }).click();
    await expect(page.getByRole("textbox", { name: "描述任务" })).toHaveValue(
      "修改后的第一条问题\n\n[attached.txt](</mock/workspace/original/attached.txt>)",
    );
    await expect(page.locator(".composer-attachment")).toHaveCount(1);
    expect(forks.at(-1)).toMatchObject({
      ...source,
      rerun: { mode: "edit", content: "修改后的第一条问题" },
    });
    expect(prompts.at(-1)).toMatchObject({
      sessionId: `rerun-child-${forks.length}`,
      sessionPath: `/mock/workspace/child-${forks.length}.jsonl`,
      images,
    });
    await page.getByRole("button", { name: "查看原对话" }).click();
    await expect(older).toBeVisible();
    await expect(
      page.getByText("原回答，必须保留在原对话。", { exact: true }),
    ).toBeVisible();
    rejected = false;
    const answer = page.locator(".message-row.assistant.response");
    await answer.hover();
    await answer.getByRole("button", { name: "重新生成回答" }).click();
    await expect.poll(() => forks.at(-1)?.rerun?.mode).toBe("regenerate");
    await expect(
      page.getByText("已在新分支接收重跑消息，原对话已保留。", { exact: true }),
    ).toBeVisible();
    expect(prompts.at(-1)).toMatchObject({
      sessionId: `rerun-child-${forks.length}`,
      sessionPath: `/mock/workspace/child-${forks.length}.jsonl`,
      content: "原来的第一条问题",
      images,
    });
    await page.screenshot({
      path: testInfo.outputPath(`rerun-original-link-${width}.png`),
    });
  }
});
