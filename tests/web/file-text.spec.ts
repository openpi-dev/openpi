import ExcelJS from "exceljs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { WEB_PROMPT_FILE_MAX_TEXT_BYTES } from "../../web/protocol/prompt-files.ts";
import {
  boundedPromptText,
  decodePromptText,
  extractPromptFileText,
  promptFileKind,
} from "../../web/ui/src/features/composer/file-text.ts";
import { readOfficeArchive } from "../../web/ui/src/features/files/office-archive.ts";

// Exercise the same browser parser that Vite selects for the staging worker.
const browserMammoth: typeof import("mammoth") = createRequire(import.meta.url)(
  "mammoth/mammoth.browser.js",
);
vi.mock("mammoth", () => ({ default: browserMammoth }));

const buffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
const docx = (text: string) =>
  buffer(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );

const pptx = (count: number, text = "演示文稿 &amp; figures") => {
  const zip: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst>${Array.from({ length: count }, (_, index) => `<p:sldId r:id="rId${index + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships>${Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  for (let index = 1; index <= count; index++)
    zip[`ppt/slides/slide${index}.xml`] = strToU8(
      `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Table ${index}</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
    );
  return buffer(zipSync(zip));
};

describe("browser attachment text extraction", () => {
  it("classifies document bytes, code, text MIME and opaque binary distinctly", () => {
    expect(promptFileKind("renamed.bin", "", strToU8("%PDF-1.7"))).toBe("pdf");
    expect(promptFileKind("report.DOCX", "", new Uint8Array())).toBe("docx");
    expect(promptFileKind("example.ts", "", strToU8("let x = 1"))).toBe("text");
    expect(promptFileKind("README", "", strToU8("hello"))).toBe("text");
    expect(promptFileKind("notes.data", "text/plain", strToU8("hello"))).toBe(
      "text",
    );
    expect(
      promptFileKind("archive.zip", "application/zip", new Uint8Array()),
    ).toBe("binary");
  });

  it("decodes UTF-8, either UTF-16 BOM and an empty text file", () => {
    expect(decodePromptText(strToU8("你好 🙂"))).toEqual({
      text: "你好 🙂",
      extraction: "text",
    });
    expect(
      decodePromptText(new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59])),
    ).toEqual({ text: "你好", extraction: "text" });
    expect(
      decodePromptText(new Uint8Array([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])),
    ).toEqual({ text: "你好", extraction: "text" });
    expect(decodePromptText(new Uint8Array())).toEqual({
      text: "",
      extraction: "text",
    });
  });

  it("rejects malformed text and binary control content rather than replacing it", () => {
    expect(() => decodePromptText(new Uint8Array([0xc3, 0x28]))).toThrow(
      "file-text-encoding",
    );
    expect(() => decodePromptText(new Uint8Array([0xff, 0xfe, 0x01]))).toThrow(
      "file-text-encoding",
    );
    expect(() => decodePromptText(strToU8("abc\u0000def"))).toThrow(
      "file-text-encoding",
    );
    expect(decodePromptText(strToU8("a\tb\r\nc\f"))).toEqual({
      text: "a\tb\r\nc\f",
      extraction: "text",
    });
  });

  it("caps UTF-8 bytes and reports truncation without splitting Unicode", () => {
    const text = "a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES - 1) + "你好";
    const result = boundedPromptText(text);
    expect(result.extraction).toBe("truncated");
    expect(result.text).toBe("a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES - 1));
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(
      WEB_PROMPT_FILE_MAX_TEXT_BYTES,
    );
    expect(
      boundedPromptText("a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES)).extraction,
    ).toBe("text");
  });

  it("extracts real Word content while a textless document remains unavailable", async () => {
    const result = await extractPromptFileText(
      docx("OpenPI &amp; 文件附件"),
      "docx",
    );
    expect(result.extraction).toBe("text");
    expect(result.text).toContain("OpenPI & 文件附件");
    expect(await extractPromptFileText(docx(""), "docx")).toEqual({
      extraction: "unavailable",
    });
  });

  it("retains Excel sheet labels, tabular values, formula results and bounded cells", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Summary").addRows([
      ["Name", "Amount"],
      ["OpenPI", 42],
    ]);
    const detail = workbook.addWorksheet("Details");
    detail.addRow(["Line\nbreak", { formula: "1+2", result: 3 }]);
    const result = await extractPromptFileText(
      buffer(new Uint8Array(await workbook.xlsx.writeBuffer())),
      "xlsx",
    );
    expect(result.extraction).toBe("text");
    expect(result.text).toContain("[Sheet: Summary]\nName\tAmount\nOpenPI\t42");
    expect(result.text).toContain("[Sheet: Details]\nLine / break\t3");
  });

  it("marks omitted Excel sheets as truncated", async () => {
    const workbook = new ExcelJS.Workbook();
    for (let index = 0; index < 21; index++)
      workbook.addWorksheet(`Sheet ${index}`).addRow([index]);
    const result = await extractPromptFileText(
      buffer(new Uint8Array(await workbook.xlsx.writeBuffer())),
      "xlsx",
    );
    expect(result.extraction).toBe("truncated");
    expect(result.text).toContain("[Sheet: Sheet 19]");
    expect(result.text).not.toContain("[Sheet: Sheet 20]");
  });

  it("extracts slide and table text in presentation order with page labels", async () => {
    const result = await extractPromptFileText(pptx(2), "pptx");
    expect(result).toEqual({
      text: "[Slide 1]\n演示文稿 & figures\nTable 1\n\n[Slide 2]\n演示文稿 & figures\nTable 2",
      extraction: "text",
    });
    const truncated = await extractPromptFileText(pptx(101), "pptx");
    expect(truncated.extraction).toBe("truncated");
    expect(truncated.text).toContain("[Slide 100]");
    expect(truncated.text).not.toContain("[Slide 101]");
  });

  it("joins styled slide runs, preserves numeric entities and includes speaker notes", async () => {
    const archive = unzipSync(
      new Uint8Array(pptx(1, "Hel</a:t></a:r><a:r><a:t>lo &#x1F642;")),
    );
    archive["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
      '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    );
    archive["ppt/notesSlides/notesSlide1.xml"] = strToU8(
      '<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    );
    const result = await extractPromptFileText(
      buffer(zipSync(archive)),
      "pptx",
    );
    expect(result.text).toBe(
      "[Slide 1]\nHello 🙂\nTable 1\n[Notes]\nSpeaker notes",
    );
    expect(result.extraction).toBe("text");
  });

  it("does not claim binary decoding and rejects malformed Office input", async () => {
    expect(
      await extractPromptFileText(buffer(new Uint8Array([0, 0xff])), "binary"),
    ).toEqual({ extraction: "unavailable" });
    await expect(
      extractPromptFileText(buffer(strToU8("not a zip")), "docx"),
    ).rejects.toThrow();
    await expect(
      extractPromptFileText(
        buffer(zipSync({ "ppt/presentation.xml": strToU8("broken") })),
        "pptx",
      ),
    ).rejects.toThrow("file-document-invalid");
  });

  it("checks declared Office expansion even when entries are not selected", () => {
    const archive = buffer(
      zipSync({ "word/large.xml": new Uint8Array(11 * 1024 * 1024) }),
    );
    expect(() => readOfficeArchive(archive, () => false)).toThrow(
      "expansion limit",
    );
  });
});
import { createRequire } from "node:module";
