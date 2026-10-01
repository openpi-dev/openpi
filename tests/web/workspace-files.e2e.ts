import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

function pdfFixture() {
  const stream = "BT /F1 24 Tf 30 130 Td (OpenPI PDF preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(content.length);
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = content.length;
  content += `xref\n0 7\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return content;
}

test("workspace files stay beside previews, support rich documents and remain usable on mobile", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const cwd = await mkdtemp(join(tmpdir(), "openpi-files-browser-"));
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({
    role: "user",
    content: "Inspect workspace files",
    timestamp: Date.now(),
  });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
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
    sendPrompt: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({ runtime });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "zh-CN",
    colorScheme: "light",
  });
  const page = await context.newPage();
  // Keep the real host projection; only isolate theme preference from the developer's global setup.
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.preferences.theme = "system";
    await route.fulfill({ response, json: snapshot });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await mkdir(join(cwd, "src"));
    await Promise.all([
      writeFile(
        join(cwd, "README.md"),
        "# OpenPI 文件工作区\n\n文件树始终在右侧，点击文件即可原位阅读。\n\n## Markdown 与图表\n\n```mermaid\ngraph LR\nA[文件树] --> B[原位预览]\nB --> C[继续阅读]\n```\n\n<details><summary>更多说明</summary>安全的内嵌 HTML</details>\n\n## 数据预览\n\n| 格式 | 状态 |\n| --- | --- |\n| PDF | 支持 |\n| Office | 支持 |",
      ),
      writeFile(
        join(cwd, "preview.html"),
        '<style>body{background:#f3f7fa}h1{color:#286a85}</style><h1>HTML sandbox preview</h1><script>parent.previewUnsafe=true</script><img src="https://example.invalid/leak"><form action="https://example.invalid/post"><button>submit</button></form>',
      ),
      writeFile(
        join(cwd, "data.csv"),
        'name,note\n"OpenPI, files","line 1\nline 2"\n"<script>","=1+1"',
      ),
      writeFile(
        join(cwd, "src", "index.ts"),
        'export const workspace = "OpenPI";\n',
      ),
      writeFile(join(cwd, "document.pdf"), pdfFixture()),
      writeFile(
        join(cwd, "pixel.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==",
          "base64",
        ),
      ),
      writeFile(
        join(cwd, "images.md"),
        Array.from({ length: 6 }, (_, i) => `![Pixel ${i}](pixel.png)`).join(
          "\n\n",
        ),
      ),
      writeFile(
        join(cwd, "long.txt"),
        "First page\n" + "Long reading line\n".repeat(5_100) + "End of file",
      ),
    ]);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Summary").addRows([
      ["Name", "Value"],
      ["OpenPI", 42],
    ]);
    workbook.addWorksheet("Details").addRows([["More data", "Second sheet"]]);
    await writeFile(
      join(cwd, "workbook.xlsx"),
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    await writeFile(
      join(cwd, "document.docx"),
      zipSync({
        "[Content_Types].xml": strToU8(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        "word/document.xml": strToU8(
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenPI Word document</w:t></w:r></w:p></w:body></w:document>',
        ),
      }),
    );
    await writeFile(
      join(cwd, "slides.pptx"),
      zipSync({
        "ppt/presentation.xml": strToU8(
          '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
        ),
        "ppt/_rels/presentation.xml.rels": strToU8(
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
        ),
        "ppt/slides/slide1.xml": strToU8(
          '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>OpenPI slide preview</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        ),
      }),
    );
    await host.start();
    await page.goto(host.origin);
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    await page
      .locator(".workbar-launcher")
      .getByRole("button", { name: /^(文件|Files)/u })
      .click();
    await page.locator('[data-pane-resizer="right"]').press("End");
    const tree = page.locator(".file-tree");
    const open = async (name: string) => {
      const toggle = page.getByRole("button", {
        name: /显示文件树|Show file tree/u,
      });
      if (await toggle.isVisible()) await toggle.click();
      await page
        .getByRole("textbox", { name: /筛选文件|Filter files/u })
        .fill(name);
      await tree
        .locator("button[data-file-row]")
        .filter({ hasText: name })
        .click();
    };
    await open("README.md");
    await expect(page.locator(".artifact-panel-embedded h1")).toHaveText(
      "OpenPI 文件工作区",
    );
    await expect(page.locator(".file-diagram > img")).toBeVisible();
    expect(
      decodeURIComponent(
        (await page.locator(".file-diagram > img").getAttribute("src")) ?? "",
      ),
    ).toContain("文件树");
    await expect(tree).toBeVisible();
    const bounds = await page.locator(".files-workspace").evaluate((node) => {
      const preview = node
        .querySelector(".artifact-panel-body")!
        .getBoundingClientRect();
      const files = node
        .querySelector(".file-explorer")!
        .getBoundingClientRect();
      return {
        right: preview.right,
        left: files.left,
        overflow: node.scrollWidth > node.clientWidth,
      };
    });
    expect(bounds.right).toBeLessThanOrEqual(bounds.left + 1);
    expect(bounds.overflow).toBe(false);
    await page
      .getByRole("textbox", { name: /筛选文件|Filter files/u })
      .fill("");
    await expect(
      tree.getByRole("button", { name: "src", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({
      path: testInfo.outputPath("files-markdown-desktop.png"),
    });
    await page
      .getByRole("button", { name: /章节目录|Document outline/u })
      .click();
    await expect(
      page.getByRole("navigation", { name: /章节目录|Document outline/u }),
    ).toContainText("数据预览");
    await page.screenshot({
      path: testInfo.outputPath("files-outline-desktop.png"),
    });
    expect(
      (await new AxeBuilder({ page }).include(".files-workspace").analyze())
        .violations,
    ).toEqual([]);
    await page
      .getByRole("navigation", { name: /章节目录|Document outline/u })
      .getByRole("button", { name: "数据预览", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "数据预览", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("navigation", { name: /章节目录|Document outline/u }),
    ).not.toBeVisible();
    await page
      .getByRole("button", { name: /章节目录|Document outline/u })
      .click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".artifact-panel-embedded h1")).toHaveText(
      "OpenPI 文件工作区",
    );
    await page.locator(".artifact-panel-body").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page
      .getByRole("button", { name: /放大图表|Expand diagram/u })
      .click();
    await expect(page.locator(".file-diagram-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".workbar-panel")).toBeVisible();
    await expect(page.locator(".artifact-panel-embedded h1")).toHaveText(
      "OpenPI 文件工作区",
    );
    await open("preview.html");
    await expect(
      page
        .frameLocator(".file-preview-frame")
        .getByRole("heading", { name: "HTML sandbox preview" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, "previewUnsafe")),
    ).toBeUndefined();
    const htmlEditor = page.getByRole("textbox", {
      name: /文件编辑器|File editor/u,
    });
    await page.getByRole("button", { name: /^(编辑|Edit)$/u }).click();
    await expect(htmlEditor).toBeFocused();
    const htmlDraft =
      "<style>body{padding:24px;color:#384455}</style><h1>Edited HTML preview</h1><p>草稿预览与编辑保持一致。</p>";
    await htmlEditor.fill(htmlDraft);
    await htmlEditor.press("Home");
    await htmlEditor.press("ArrowRight");
    await htmlEditor.press("ArrowRight");
    const selection = await htmlEditor.evaluate(
      (node) => (node as HTMLTextAreaElement).selectionStart,
    );
    await page.getByRole("button", { name: /^(预览|Preview)$/u }).click();
    await expect(
      page
        .frameLocator(".file-preview-frame")
        .getByRole("heading", { name: "Edited HTML preview" }),
    ).toBeVisible();
    expect(await readFile(join(cwd, "preview.html"), "utf8")).toContain(
      "HTML sandbox preview",
    );
    await page.getByRole("button", { name: /^(编辑|Edit)$/u }).click();
    await expect(htmlEditor).toBeFocused();
    await expect(htmlEditor).toHaveValue(htmlDraft);
    expect(
      await htmlEditor.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(selection);
    await page.screenshot({ path: testInfo.outputPath("files-html-edit.png") });
    await page.getByRole("button", { name: /^(预览|Preview)$/u }).click();
    await page.getByRole("button", { name: /保存文件|Save file/u }).click();
    await expect
      .poll(() => readFile(join(cwd, "preview.html"), "utf8"))
      .toBe(htmlDraft);
    await expect(
      page
        .frameLocator(".file-preview-frame")
        .getByRole("heading", { name: "Edited HTML preview" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("files-html-preview.png"),
    });
    await open("data.csv");
    await expect(page.locator(".file-table")).toContainText("OpenPI, files");
    await expect(page.locator(".file-table")).toContainText("line 1\nline 2");
    await open("index.ts");
    await expect(page.locator(".file-code .hljs-keyword").first()).toHaveText(
      "export",
    );
    await page.getByRole("button", { name: /^(编辑|Edit)$/u }).click();
    const editor = page.getByRole("textbox", {
      name: /文件编辑器|File editor/u,
    });
    const draft = 'export const workspace = "Edited locally";\n';
    await editor.fill(draft);
    await open("data.csv");
    await open("index.ts");
    await page.getByRole("button", { name: /^(编辑|Edit)$/u }).click();
    await expect(editor).toHaveValue(draft);
    await editor.press("ControlOrMeta+s");
    await expect
      .poll(() => readFile(join(cwd, "src", "index.ts"), "utf8"))
      .toBe(draft);
    await expect(
      page.getByRole("button", { name: /保存文件|Save file/u }),
    ).toBeDisabled();
    await editor.fill('export const workspace = "Preserved draft";\n');
    await writeFile(
      join(cwd, "src", "index.ts"),
      'export const workspace = "External change";\n',
    );
    await page.getByRole("button", { name: /保存文件|Save file/u }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /磁盘上的文件已改变|file changed on disk/u }),
    ).toBeVisible();
    expect(await readFile(join(cwd, "src", "index.ts"), "utf8")).toContain(
      "External change",
    );
    await page
      .locator(".artifact-header-actions")
      .getByRole("button", { name: /刷新文件|Refresh file/u })
      .click();
    await expect(page.locator(".file-conflict")).toBeVisible();
    await expect(editor).toHaveValue(
      'export const workspace = "Preserved draft";\n',
    );
    await page
      .getByText(/查看当前磁盘版本|Inspect current disk version/u)
      .click();
    await expect(page.locator(".file-conflict pre")).toContainText(
      "External change",
    );
    await page.getByRole("button", { name: /已核对|Reviewed/u }).click();
    await editor.fill(
      'export const workspace = "External change plus draft";\n',
    );
    await page.getByRole("button", { name: /保存文件|Save file/u }).click();
    await expect
      .poll(() => readFile(join(cwd, "src", "index.ts"), "utf8"))
      .toContain("External change plus draft");
    await open("document.pdf");
    await expect(page.locator(".file-pdf canvas")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".file-pdf canvas")
          .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      )
      .toBeGreaterThan(400);
    const originalWidth = (await page
      .locator(".file-pdf canvas")
      .boundingBox())!.width;
    await page
      .getByRole("button", { name: /放大|Zoom in/u, exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await page.locator(".file-pdf canvas").boundingBox())!.width,
      )
      .toBeGreaterThan(originalWidth);
    await page
      .getByRole("button", { name: /下一页|Next page/u, exact: true })
      .click();
    await expect(page.locator(".file-pdf .file-preview-toolbar")).toContainText(
      "2 / 2",
    );
    await open("images.md");
    await expect(page.locator(".file-inline-image")).toHaveCount(6);
    await expect
      .poll(() =>
        page
          .locator(".file-inline-image")
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).naturalWidth === 1,
            ),
          ),
      )
      .toBe(true);
    await open("workbook.xlsx");
    await expect(page.locator(".file-table")).toContainText("42");
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.locator(".file-table")).toContainText("Second sheet");
    await open("document.docx");
    await expect(
      page
        .frameLocator(".file-preview-frame")
        .getByText("OpenPI Word document"),
    ).toBeVisible();
    await open("slides.pptx");
    await expect(
      page
        .frameLocator(".file-preview-frame")
        .getByText("OpenPI slide preview"),
    ).toBeVisible();
    await open("long.txt");
    await page
      .getByRole("button", { name: /继续读取|Continue reading/u })
      .click();
    await expect(page.locator(".file-code")).toContainText("End of file");
    await open("README.md");
    const accessibility = await new AxeBuilder({ page })
      .include(".files-workspace")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("textbox", { name: /筛选文件|Filter files/u })
      .fill("");
    await expect(
      tree.getByRole("button", { name: "src", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("files-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    for (const width of [720, 560, 456, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await open("README.md");
      await expect(tree).toBeVisible();
      await expect(page.locator(".file-markdown h1")).toBeVisible();
      const layout = await page.locator(".files-workspace").evaluate((node) => {
        const body = node.querySelector<HTMLElement>(".artifact-panel-body")!;
        const preview = body.getBoundingClientRect();
        const files = node
          .querySelector(".file-explorer")!
          .getBoundingClientRect();
        const header = node
          .querySelector(".artifact-panel > header")!
          .getBoundingClientRect();
        return {
          separated: preview.right <= files.left + 1,
          wrapped: body.scrollWidth <= body.clientWidth,
          aligned:
            Math.abs(preview.top - files.top) <= 1 &&
            header.bottom <= preview.top + 1,
          overflow: node.scrollWidth > node.clientWidth,
        };
      });
      expect(layout).toEqual({
        separated: true,
        wrapped: true,
        aligned: true,
        overflow: false,
      });
      await page.screenshot({
        path: testInfo.outputPath(`files-${width}.png`),
      });
    }
    await page
      .getByRole("button", { name: /收起文件树|Hide file tree/u })
      .click();
    await expect(tree).not.toBeVisible();
    await page
      .getByRole("button", { name: /显示文件树|Show file tree/u })
      .click();
    await expect(tree).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("files-mobile.png") });
    expect(context.pages()).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
