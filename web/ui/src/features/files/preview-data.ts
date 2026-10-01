export interface PreviewTable {
  name: string;
  rows: string[][];
  truncated: boolean;
}
export type OfficePreview =
  | { kind: "document"; html: string }
  | { kind: "sheets"; sheets: PreviewTable[]; truncated: boolean }
  | { kind: "slides"; slides: string[]; truncated: boolean };

/** Quoted CSV/TSV, including escaped quotes and embedded newlines; bounded display. */
export function parseDelimited(text: string, delimiter: string): PreviewTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && (quoted || cell === "")) {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (
      !quoted &&
      (char === delimiter || char === "\n" || char === "\r")
    ) {
      if (row.length < 50) row.push(cell);
      else truncated = true;
      cell = "";
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
        if (rows.length === 500) {
          truncated ||= index < text.length - 1;
          break;
        }
      }
    } else cell += char;
  }
  if (rows.length < 500 && (cell || row.length)) {
    if (row.length < 50) row.push(cell);
    else truncated = true;
    rows.push(row);
  }
  return { name: "", rows, truncated };
}

export function sandboxDocument(html: string) {
  // Both opaque-origin sandbox and restrictive CSP are required. Previewed
  // content never executes scripts, submits forms, or fetches remote assets.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:24px;color:#242424;background:#fff;font:15px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:6px 10px}pre{white-space:pre-wrap}a{color:#2766a5}</style></head><body>${html}</body></html>`;
}
