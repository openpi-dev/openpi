import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Browser } from "@playwright/test";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type {
  WebPromptOptions,
  WebRuntimeController,
} from "../../web/runtime/types.ts";

export function attachmentPdf(contents: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  contents.forEach((stream, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  let content = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

export async function attachmentFormatFixtures() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Summary").addRows([
    ["Name", "Value"],
    ["OpenPI", 42],
  ]);
  workbook.addWorksheet("明细").addRows([["第二页表格", "你好"]]);
  return [
    {
      name: "分页报告.pdf",
      mimeType: "application/pdf",
      buffer: attachmentPdf([
        "BT /F1 12 Tf 50 700 Td (OpenPI page one) Tj ET",
        "BT /F1 12 Tf 50 700 Td (OpenPI page two) Tj ET",
      ]),
      text: "[Page 1]\nOpenPI page one\n\n[Page 2]\nOpenPI page two",
    },
    {
      name: "扫描报告.pdf",
      mimeType: "application/pdf",
      buffer: attachmentPdf([
        "q 100 0 0 100 50 600 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI Q",
      ]),
      text: undefined,
    },
    {
      name: "说明.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from(
        zipSync({
          "[Content_Types].xml": strToU8(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          ),
          "_rels/.rels": strToU8(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          ),
          "word/document.xml": strToU8(
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenPI Word &amp; 文件附件</w:t></w:r></w:p></w:body></w:document>',
          ),
        }),
      ),
      text: "OpenPI Word & 文件附件\n\n",
    },
    {
      name: "明细.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      text: "[Sheet: Summary]\nName\tValue\nOpenPI\t42\n\n[Sheet: 明细]\n第二页表格\t你好",
    },
    {
      name: "幻灯片.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(
        zipSync({
          "ppt/presentation.xml": strToU8(
            '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
          ),
          "ppt/_rels/presentation.xml.rels": strToU8(
            '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
          ),
          "ppt/slides/slide1.xml": strToU8(
            '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>OpenPI slide &amp; 附件</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
          ),
        }),
      ),
      text: "[Slide 1]\nOpenPI slide & 附件",
    },
    {
      name: "中文说明.ts",
      mimeType: "text/plain",
      buffer: Buffer.from('export const message = "你好 🙂";\n'),
      text: 'export const message = "你好 🙂";\n',
    },
    {
      name: "empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(0),
      text: "",
    },
  ];
}

export async function createAttachmentHost(browser: Browser) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "openpi-file-formats-")),
  );
  const sessionDirectory = join(cwd, "sessions");
  await mkdir(sessionDirectory, { mode: 0o700 });
  const createSession = (name: string) => {
    const session = SessionManager.create(cwd, sessionDirectory);
    session.appendMessage({
      role: "user",
      content: `${name} seed`,
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Fixture ready. No provider calls." }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    session.appendSessionInfo(name);
    return session;
  };
  const first = createSession("Formats A");
  const second = createSession("Formats B");
  let manager = first;
  const prompts: { content: string; options?: WebPromptOptions }[] = [];
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory,
    get sessionManager() {
      return manager;
    },
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async (content, options) => {
      if (
        options?.expectedSessionId !== manager.getSessionId() ||
        options.expectedSessionPath !== manager.getSessionFile()
      )
        throw new Error("Fixture prompt crossed Session ownership.");
      prompts.push({ content, options });
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
      return { pendingFollowUps: 0, delivery: "prompt" };
    },
    newSession: async () => {
      throw new Error("Fixture only uses precreated native Sessions.");
    },
    switchSession: async (path) => {
      const selected = [first, second].find(
        (session) => session.getSessionFile() === path,
      );
      if (!selected) throw new Error("Unknown fixture Session.");
      manager = selected;
      return { cancelled: false };
    },
    listModels: () => [
      {
        provider: "fixture",
        id: "fixture",
        name: "Fixture (no model call)",
        label: "Fixture (no model call)",
        current: true,
      },
    ],
    searchModels: (query, limit) =>
      projectWebModelSearch(runtime.listModels(), query, limit),
    setModel: async () => {
      throw new Error("No provider calls in file staging fixture.");
    },
    subscribe: () => () => undefined,
    dispose: async () => undefined,
  };
  const host = new WebHost({ runtime, port: 57_249 });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await host.start();
    await page.goto(host.origin);
  } catch (error) {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  return {
    host,
    page,
    prompts,
    errors,
    first,
    second,
    async close() {
      await context.close();
      await host.stop();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
