import { XMLParser, XMLValidator } from "fast-xml-parser";
import { strFromU8 } from "fflate";
import { WEB_PROMPT_FILE_MAX_TEXT_BYTES } from "../../../../protocol/prompt-files.ts";
import { readOfficeArchive } from "../files/office-archive.ts";

export interface PromptFileText {
  text?: string;
  extraction: "text" | "unavailable" | "truncated";
  extractionError?: "encoding" | "document";
}

const textExtensions = new Set(
  "txt md markdown csv tsv json jsonl ndjson xml html htm css scss sass less yaml yml toml ini cfg conf config log rst tex diff patch sql graphql gql py ipynb js mjs cjs jsx ts mts cts tsx java kt kts scala c cc cpp cxx h hpp cs go rs rb php swift sh bash zsh fish ps1 bat cmd r lua pl proto vue svelte astro svg srt vtt env gitignore dockerignore editorconfig properties lock".split(
    " ",
  ),
);

export function promptFileKind(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
) {
  const extension = name.split(".").at(-1)?.toLowerCase() || "";
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 5)) === "%PDF-")
    return "pdf";
  if (["pdf", "docx", "xlsx", "pptx"].includes(extension)) return extension;
  if (
    textExtensions.has(extension) ||
    /^(?:readme|license|licence|changelog|dockerfile|makefile|gemfile)$/iu.test(
      name,
    ) ||
    mimeType.startsWith("text/") ||
    /^application\/(?:json|(?:[^;]+\+)?xml|javascript|x-yaml)(?:;|$)/iu.test(
      mimeType,
    )
  )
    return "text";
  return "binary";
}

export function boundedPromptText(text: string): PromptFileText {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= WEB_PROMPT_FILE_MAX_TEXT_BYTES)
    return { text, extraction: "text" };
  // Streaming decode omits a character whose UTF-8 bytes cross the limit.
  return {
    text: new TextDecoder().decode(
      bytes.subarray(0, WEB_PROMPT_FILE_MAX_TEXT_BYTES),
      { stream: true },
    ),
    extraction: "truncated",
  };
}

export function decodePromptText(bytes: Uint8Array) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("file-text-encoding");
  }
  // NUL and other binary control bytes are not readable source text. Keep tabs,
  // newlines and form feeds, which occur in ordinary documents and code.
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text))
    throw new Error("file-text-encoding");
  return boundedPromptText(text);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

async function officeText(data: ArrayBuffer, kind: string) {
  const archive = readOfficeArchive(data, (path) =>
    kind === "pptx" ? path.endsWith(".xml") || path.endsWith(".rels") : false,
  );
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.default.extractRawText({ arrayBuffer: data });
    return result.value.trim()
      ? boundedPromptText(result.value)
      : ({ extraction: "unavailable" } satisfies PromptFileText);
  }
  if (kind === "xlsx") {
    const excel = await import("exceljs");
    const workbook = new excel.default.Workbook();
    await workbook.xlsx.load(data);
    const sections: string[] = [];
    let cells = 0;
    let truncated = workbook.worksheets.length > 20;
    for (const sheet of workbook.worksheets.slice(0, 20)) {
      const rows: string[] = [];
      const rowCount = Math.min(sheet.rowCount, 10_000);
      const columnCount = Math.min(sheet.columnCount, 200);
      truncated ||=
        rowCount < sheet.rowCount || columnCount < sheet.columnCount;
      for (let row = 1; row <= rowCount && cells < 100_000; row++) {
        const values: string[] = [];
        for (
          let column = 1;
          column <= columnCount && cells < 100_000;
          column++
        ) {
          const value = sheet.getCell(row, column).text;
          values.push(value.replace(/\t/gu, " ").replace(/\r?\n/gu, " / "));
          cells++;
        }
        rows.push(values.join("\t"));
      }
      truncated ||= rows.length < sheet.rowCount;
      sections.push(`[Sheet: ${sheet.name}]\n${rows.join("\n")}`);
    }
    const result = boundedPromptText(sections.join("\n\n"));
    return {
      ...result,
      extraction: truncated ? "truncated" : result.extraction,
    };
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    processEntities: false,
    parseTagValue: false,
    trimValues: false,
  });
  const xml = (path: string) => {
    const bytes = archive[path];
    if (!bytes) throw new Error("file-document-invalid");
    const text = strFromU8(bytes);
    if (/<!DOCTYPE/iu.test(text) || XMLValidator.validate(text) !== true)
      throw new Error("file-document-invalid");
    return object(parser.parse(text));
  };
  const presentation = object(xml("ppt/presentation.xml")["p:presentation"]);
  const relationships = new Map(
    list(
      object(xml("ppt/_rels/presentation.xml.rels").Relationships).Relationship,
    ).map((value) => {
      const relation = object(value);
      return [String(relation["@Id"]), relation];
    }),
  );
  const ids = list(object(presentation["p:sldIdLst"])["p:sldId"]);
  if (!ids.length) throw new Error("file-document-invalid");
  const decodeXmlText = (value: unknown) =>
    String(value ?? "").replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu,
      (_, entity: string) => {
        if (!entity.startsWith("#"))
          return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
            entity.toLowerCase()
          ]!;
        const codePoint = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        )
          throw new Error("file-document-invalid");
        return String.fromCodePoint(codePoint);
      },
    );
  const textRuns = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(textRuns);
    return Object.entries(object(value)).flatMap(([key, child]) =>
      key === "a:t" ? [decodeXmlText(child)] : textRuns(child),
    );
  };
  const textBlocks = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(textBlocks);
    return Object.entries(object(value)).flatMap(([key, child]) => {
      if (key === "a:p")
        return list(child).map((paragraph) => textRuns(paragraph).join(""));
      if (key === "a:tr")
        return list(child).map((row) =>
          list(object(row)["a:tc"])
            .map((cell) => textBlocks(cell).join(" / "))
            .join("\t"),
        );
      return textBlocks(child);
    });
  };
  const sections = ids.slice(0, 100).map((id, index) => {
    const relation = relationships.get(String(object(id)["@r:id"]));
    const target = String(relation?.["@Target"] ?? "");
    if (
      relation?.["@TargetMode"] === "External" ||
      !/^slides\/slide\d+\.xml$/u.test(target)
    )
      throw new Error("file-document-invalid");
    let text = textBlocks(xml(`ppt/${target}`)).join("\n");
    const relationshipPath = `ppt/slides/_rels/${target.split("/").at(-1)}.rels`;
    if (archive[relationshipPath]) {
      for (const item of list(
        object(xml(relationshipPath).Relationships).Relationship,
      )) {
        const notes = object(item);
        const notesTarget = String(notes["@Target"] ?? "");
        if (
          notes["@TargetMode"] !== "External" &&
          /^\.\.\/notesSlides\/notesSlide\d+\.xml$/u.test(notesTarget)
        ) {
          const notesText = textBlocks(xml(`ppt/${notesTarget.slice(3)}`)).join(
            "\n",
          );
          if (notesText.trim()) text += `\n[Notes]\n${notesText}`;
        }
      }
    }
    return {
      label: `[Slide ${index + 1}]`,
      text,
    };
  });
  if (!sections.some((section) => section.text.trim()))
    return { extraction: "unavailable" } satisfies PromptFileText;
  const result = boundedPromptText(
    sections.map((section) => `${section.label}\n${section.text}`).join("\n\n"),
  );
  return {
    ...result,
    extraction: ids.length > 100 ? "truncated" : result.extraction,
  } satisfies PromptFileText;
}

async function pdfText(data: ArrayBuffer) {
  const [library, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  library.GlobalWorkerOptions.workerSrc = worker.default;
  // The outer staging worker supplies the cancellation and time boundary. PDF.js
  // falls back to its in-process worker there, so no orphan nested worker remains.
  const task = library.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    useSystemFonts: true,
    disableAutoFetch: true,
    maxImageSize: 1,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const sections: string[] = [];
    let size = 0;
    let readable = false;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "",
        )
        .join("")
        .trim();
      page.cleanup();
      readable ||= !!text;
      const section = `[Page ${pageNumber}]\n${text}`;
      sections.push(section);
      size += new TextEncoder().encode(section).length;
      if (size > WEB_PROMPT_FILE_MAX_TEXT_BYTES) {
        truncated = true;
        break;
      }
    }
    if (!readable)
      return { extraction: "unavailable" } satisfies PromptFileText;
    const result = boundedPromptText(sections.join("\n\n"));
    return {
      ...result,
      extraction: truncated ? "truncated" : result.extraction,
    } satisfies PromptFileText;
  } finally {
    await task.destroy();
  }
}

export async function extractPromptFileText(data: ArrayBuffer, kind: string) {
  if (kind === "text") return decodePromptText(new Uint8Array(data));
  if (kind === "pdf") return pdfText(data);
  if (["docx", "xlsx", "pptx"].includes(kind)) return officeText(data, kind);
  return { extraction: "unavailable" } satisfies PromptFileText;
}
