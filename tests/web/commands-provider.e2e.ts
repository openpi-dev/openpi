import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const headers = { Authorization: `Bearer ${process.env.OPENPI_WEB_E2E_TOKEN}` };

test("native command feedback survives refresh without model calls", async ({
  page,
}, info) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-web-commands-"));
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    const { path } = await imported.json();
    const created = await page.request.post("/api/sessions", {
      headers,
      data: { workspacePath: path, commandId: "commands" },
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    const discovery = await (
      await page.request.get(`/api/commands?sessionId=${session.sessionId}`, {
        headers,
      })
    ).json();
    for (const name of ["plan", "openpi-setup", "usage", "cron"])
      expect(
        discovery.commands.find(
          (command: { name: string }) => command.name === name,
        )?.availability,
      ).toBe("available");
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "描述任务" });
    for (const [command, feedback] of [
      ["/plan off", "Plan mode off. No implementation was started."],
      ["/cron in 1h Later test", "Scheduled prompt 1 once in 1h."],
      ["/cron list", "Later test"],
      ["/cron remove 1", "Removed scheduled prompt 1."],
      ["/usage", "No supported authenticated providers found"],
    ]) {
      await input.fill(command!);
      // Enter can complete an asynchronously loaded slash-menu item instead
      // of submitting it. This scenario verifies feedback, not completion.
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(
        page.locator(".command-feedback").filter({ hasText: feedback! }).last(),
      ).toBeVisible();
    }
    await page.reload();
    await expect(page.locator(".message-row.user")).toHaveCount(5);
    await expect(page.locator(".command-feedback")).toHaveCount(5);
    const texts = await page.locator(".message-row").allTextContents();
    expect(texts[0]).toContain("/plan off");
    expect(texts[1]).toContain("Plan mode off");
    await expect(page.getByText("普通模式", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("commands-light.png") });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
