import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";
import type { OfficePreview, PreviewTable } from "./preview-data.ts";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

async function preview(
  data: ArrayBuffer,
  extension: string,
): Promise<OfficePreview> {
  let count = 0;
  let total = 0;
  // Inspect declared expansion sizes before allocation. The worker also has
  // a wall-clock limit and is terminated when the file/view changes.
  const zip = unzipSync(new Uint8Array(data), {
    filter: (entry) => {
      total += entry.originalSize;
      if (
        ++count > 2_000 ||
        total > 40 * 1024 * 1024 ||
        entry.originalSize > 10 * 1024 * 1024
      )
        throw new Error("Office preview exceeds the expansion limit.");
      return extension === "pptx";
    },
  });
  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.default.convertToHtml(
      { arrayBuffer: data },
      { externalFileAccess: false, includeEmbeddedStyleMap: false },
    );
    if (result.value.length > 10 * 1024 * 1024)
      throw new Error("Document preview is too large.");
    return { kind: "document", html: result.value };
  }
  if (extension === "xlsx") {
    const excel = await import("exceljs");
    const workbook = new excel.default.Workbook();
    await workbook.xlsx.load(data);
    let cells = 0;
    const sheets: PreviewTable[] = workbook.worksheets
      .slice(0, 20)
      .map((sheet) => {
        const rows: string[][] = [];
        for (
          let r = 1;
          r <= Math.min(sheet.rowCount, 500) && cells < 20_000;
          r++
        ) {
          const row: string[] = [];
          for (
            let c = 1;
            c <= Math.min(sheet.columnCount, 50) && cells < 20_000;
            c++
          ) {
            row.push(sheet.getCell(r, c).text.slice(0, 10_000));
            cells++;
          }
          rows.push(row);
        }
        return {
          name: sheet.name,
          rows,
          truncated: rows.length < sheet.rowCount || sheet.columnCount > 50,
        };
      });
    return {
      kind: "sheets",
      sheets,
      truncated: workbook.worksheets.length > 20,
    };
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    processEntities: false,
    parseTagValue: false,
  });
  const xml = (path: string) =>
    object(parser.parse(strFromU8(zip[path] ?? new Uint8Array())));
  const presentation = object(xml("ppt/presentation.xml")["p:presentation"]);
  const slideSize = object(presentation["p:sldSz"]);
  const width = Number(slideSize["@cx"]) || 9_144_000;
  const height = Number(slideSize["@cy"]) || 6_858_000;
  const relationships = (path: string) =>
    new Map(
      list(object(xml(path).Relationships).Relationship).map((value) => {
        const relation = object(value);
        return [String(relation["@Id"]), relation];
      }),
    );
  const rels = relationships("ppt/_rels/presentation.xml.rels");
  const ids = list(object(presentation["p:sldIdLst"])["p:sldId"]);
  const slides = ids.slice(0, 100).map((id) => {
    const target = String(
      rels.get(String(object(id)["@r:id"]))?.["@Target"] ?? "",
    );
    if (!/^slides\/slide\d+\.xml$/u.test(target))
      throw new Error("Unsupported slide relationship.");
    const slide = object(xml(`ppt/${target}`)["p:sld"]);
    const tree = object(object(slide["p:cSld"])["p:spTree"]);
    const slideRels = relationships(
      `ppt/slides/_rels/${target.split("/").at(-1)}.rels`,
    );
    const blocks: string[] = [];
    const position = (value: unknown) => {
      const transform = object(object(value)["a:xfrm"]);
      const off = object(transform["a:off"]);
      const size = object(transform["a:ext"]);
      const percent = (value: unknown, max: number) =>
        Math.max(0, Math.min(100, ((Number(value) || 0) / max) * 100));
      return transform["a:off"]
        ? `position:absolute;left:${percent(off["@x"], width)}%;top:${percent(off["@y"], height)}%;width:${percent(size["@cx"], width)}%;height:${percent(size["@cy"], height)}%;overflow:hidden`
        : "position:relative;margin:12px";
    };
    for (const value of list(tree["p:sp"])) {
      const shape = object(value);
      const paragraphs = list(object(shape["p:txBody"])["a:p"])
        .map((p) => {
          const runs = list(object(p)["a:r"]);
          return `<p style="margin:0 0 .4em">${runs
            .map((r) => {
              const run = object(r);
              const props = object(run["a:rPr"]);
              const size = Math.min(
                64,
                Math.max(10, (Number(props["@sz"]) || 1800) / 100),
              );
              return `<span style="font-size:${size}px;${props["@b"] === "1" ? "font-weight:bold" : ""}">${escapeHtml(run["a:t"])}</span>`;
            })
            .join("")}</p>`;
        })
        .join("");
      blocks.push(
        `<div style="${position(shape["p:spPr"])}">${paragraphs}</div>`,
      );
    }
    for (const value of list(tree["p:pic"])) {
      const picture = object(value);
      const rel = slideRels.get(
        String(object(object(picture["p:blipFill"])["a:blip"])["@r:embed"]),
      );
      const target = String(rel?.["@Target"] ?? "");
      if (
        rel?.["@TargetMode"] === "External" ||
        !/^\.\.\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/iu.test(target)
      )
        continue;
      const bytes = zip[`ppt/${target.slice(3)}`];
      if (!bytes) continue;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8_192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8_192));
      const ext = target.split(".").at(-1)?.toLowerCase();
      blocks.push(
        `<div style="${position(picture["p:spPr"])}"><img alt="" style="width:100%;height:100%;object-fit:contain" src="data:image/${ext === "jpg" ? "jpeg" : ext};base64,${btoa(binary)}"></div>`,
      );
    }
    return `<div style="position:relative;width:100%;aspect-ratio:${width}/${height};background:white;border:1px solid #ddd">${blocks.join("")}</div>`;
  });
  if (!slides.length) throw new Error("No readable slides.");
  return { kind: "slides", slides, truncated: ids.length > 100 };
}

self.onmessage = (
  event: MessageEvent<{ data: ArrayBuffer; extension: string }>,
) => {
  void preview(event.data.data, event.data.extension).then(
    (result) => self.postMessage({ result }),
    (error: unknown) =>
      self.postMessage({
        error:
          error instanceof Error
            ? error.message
            : "Unable to preview this document.",
      }),
  );
};
