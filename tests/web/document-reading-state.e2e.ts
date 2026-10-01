import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  attachmentFormatFixtures,
  createAttachmentHost,
} from "./file-formats-e2e-support.ts";

test("real document parsers preserve PDF page and zoom and the selected worksheet across tool switches", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  const originalBranchLength = fixture.first.getBranch().length;
  const files = (await attachmentFormatFixtures()).filter((file) =>
    ["分页报告.pdf", "明细.xlsx"].includes(file.name),
  );
  try {
    await Promise.all(
      files.map((file) =>
        writeFile(join(fixture.first.getCwd(), file.name), file.buffer),
      ),
    );
    const input = page.getByRole("textbox", {
      name: /描述任务|Describe a task/u,
    });
    await expect(input).toBeEnabled();
    const draft = "阅读文件时保留这条未发送草稿";
    await input.fill(draft);
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    await page
      .locator(".workbar-launcher")
      .getByRole("button", { name: /^(文件|Files)/u })
      .click();
    await page.locator('[data-pane-resizer="right"]').press("End");

    const workbar = page.locator(".workbar-panel");
    const filesPanel = workbar.locator('[data-tool="files"]');
    const tree = filesPanel.locator(".file-tree");
    const openFile = async (name: string) => {
      const toggle = filesPanel.getByRole("button", {
        name: /显示文件树|Show file tree/u,
      });
      if (await toggle.isVisible()) await toggle.click();
      await filesPanel
        .getByRole("textbox", { name: /筛选文件|Filter files/u })
        .fill(name);
      await tree
        .locator("button[data-file-row]")
        .filter({ hasText: name })
        .click();
    };
    const switchAwayAndBack = async () => {
      await workbar.locator(".workbar-add-tab").click();
      await workbar
        .locator(".workbar-launcher")
        .getByRole("button", { name: /^(浏览器|Browser)/u })
        .click();
      await expect(workbar.locator('[data-tool="browser"]')).toBeVisible();
      await expect(filesPanel).toBeHidden();
      await workbar.locator(".workbar-add-tab").click();
      await workbar
        .locator(".workbar-launcher")
        .getByRole("button", { name: /^(文件|Files)/u })
        .click();
      await expect(filesPanel).toBeVisible();
      await expect(workbar.locator(".workbar-tab")).toHaveCount(2);
      await expect(
        workbar
          .getByRole("toolbar", { name: /打开工具|Open tools/u })
          .getByRole("button", {
            name: /^(文件|Files)$/u,
          }),
      ).toBeFocused();
      await expect(input).toHaveValue(draft);
    };
    const expectRenderedPdf = async () => {
      const canvas = filesPanel.getByRole("img", {
        name: /第 2 页|Page 2/u,
      });
      await expect(canvas).toBeVisible();
      await expect(filesPanel.locator(".file-pdf [role='status']")).toHaveCount(
        0,
      );
      expect(
        await canvas.evaluate((node) => (node as HTMLCanvasElement).width),
      ).toBeGreaterThan(0);
      await expect(
        filesPanel.getByRole("button", { name: /重置缩放|Reset zoom/u }),
      ).toContainText("125%");
    };

    await openFile("分页报告.pdf");
    const next = filesPanel.getByRole("button", { name: /下一页|Next page/u });
    await expect(next).toBeEnabled();
    await next.click();
    await filesPanel.getByRole("button", { name: /放大|Zoom in/u }).click();
    await expectRenderedPdf();
    await page.screenshot({
      path: testInfo.outputPath("pdf-page2-125-before-tool-switch.png"),
      animations: "disabled",
    });
    await switchAwayAndBack();
    await expectRenderedPdf();
    await page.screenshot({
      path: testInfo.outputPath("pdf-page2-125-restored-after-tool-switch.png"),
      animations: "disabled",
    });

    await openFile("明细.xlsx");
    const sheet = filesPanel.getByRole("button", { name: "明细", exact: true });
    await sheet.click();
    await expect(sheet).toHaveAttribute("aria-pressed", "true");
    await expect(
      filesPanel.getByRole("region", { name: "明细", exact: true }),
    ).toContainText("第二页表格");
    await switchAwayAndBack();
    await expect(
      filesPanel.getByRole("button", { name: "明细", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      filesPanel.getByRole("region", { name: "明细", exact: true }),
    ).toContainText("第二页表格");
    await page.screenshot({
      path: testInfo.outputPath(
        "xlsx-second-sheet-restored-after-tool-switch.png",
      ),
      animations: "disabled",
    });
    for (const file of files)
      expect(await readFile(join(fixture.first.getCwd(), file.name))).toEqual(
        file.buffer,
      );
    expect(fixture.prompts).toEqual([]);
    expect(fixture.first.getBranch()).toHaveLength(originalBranchLength);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
