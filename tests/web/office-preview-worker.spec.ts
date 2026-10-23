import ExcelJS from "exceljs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { OfficePreview } from "../../web/ui/src/features/files/preview-data.ts";

type WorkerReply = { result?: OfficePreview; error?: string };
let receive: ((reply: WorkerReply) => void) | undefined;
const worker = {
  onmessage: null as
    | ((event: MessageEvent<{ data: ArrayBuffer; extension: string }>) => void)
    | null,
  postMessage: (reply: WorkerReply) => receive?.(reply),
};
beforeAll(async () => {
  vi.stubGlobal("self", worker);
  await import("../../web/ui/src/features/files/office-worker.ts");
});
afterAll(() => vi.unstubAllGlobals());

async function preview(workbook: ExcelJS.Workbook) {
  const data = Uint8Array.from(
    new Uint8Array(await workbook.xlsx.writeBuffer()),
  ).buffer;
  const response = new Promise<WorkerReply>((resolve) => {
    receive = resolve;
  });
  expect(worker.onmessage).toBeTypeOf("function");
  worker.onmessage?.(
    new MessageEvent("message", { data: { data, extension: "xlsx" } }),
  );
  const reply = await response;
  expect(reply.error).toBeUndefined();
  if (reply.result?.kind !== "sheets")
    throw new Error("Expected worksheet preview");
  return reply.result;
}

it("marks clipped cell text as truncated without losing the bounded preview", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Long cell").getCell("A1").value =
    "x".repeat(10_000) + "omitted tail";
  const result = await preview(workbook);
  expect(result.sheets[0].rows).toEqual([["x".repeat(10_000)]]);
  expect(result.sheets[0].truncated).toBe(true);
});

it("marks a budget cut within the last worksheet row, but not an exactly complete budget", async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("First");
  for (let r = 1; r <= 399; r++)
    for (let c = 1; c <= 50; c++) first.getCell(r, c).value = `${r},${c}`;
  const last = workbook.addWorksheet("Last");
  for (let r = 1; r <= 2; r++)
    for (let c = 1; c <= 25; c++) last.getCell(r, c).value = `${r},${c}`;
  const complete = await preview(workbook);
  expect(complete.truncated).toBe(false);
  expect(complete.sheets.map((sheet) => sheet.truncated)).toEqual([
    false,
    false,
  ]);
  expect(complete.sheets[1].rows.map((row) => row.length)).toEqual([25, 25]);
  expect(complete.sheets[1].rows[1][24]).toBe("2,25");

  for (let r = 1; r <= 2; r++)
    for (let c = 26; c <= 30; c++) last.getCell(r, c).value = `${r},${c}`;
  const clipped = await preview(workbook);
  expect(clipped.sheets[0].truncated).toBe(false);
  expect(clipped.sheets[1].rows.map((row) => row.length)).toEqual([30, 20]);
  expect(clipped.sheets[1].rows[1][19]).toBe("2,20");
  expect(clipped.sheets[1].truncated).toBe(true);
});
