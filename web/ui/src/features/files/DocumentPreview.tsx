/// <reference types="vite/client" />
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactMetadata } from "../../../../protocol/artifacts.ts";
import type { WebClient } from "../../protocol/client.ts";
import type { OfficePreview, PreviewTable } from "./preview-data.ts";
import { sandboxDocument } from "./preview-data.ts";

export function DataTable({ table }: { table: PreviewTable }) {
  const { t } = useTranslation();
  const columns = Math.max(0, ...table.rows.map((row) => row.length));
  return (
    <>
      {table.truncated && (
        <p className="evidence-warning">{t("filesTableTruncated")}</p>
      )}
      <section
        className="file-table-scroll"
        aria-label={table.name || t("filesTable")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Wide tables need keyboard scrolling.
        tabIndex={0}
      >
        <table className="file-table">
          <thead>
            <tr>
              <th aria-label={t("filesRow")} />
              {Array.from({ length: columns }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: A spreadsheet column is identified by its fixed coordinate.
                <th key={index} scope="col">
                  {index < 26
                    ? String.fromCharCode(65 + index)
                    : `A${String.fromCharCode(65 + index - 26)}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Row coordinates are stable within this immutable file revision.
              <tr key={index}>
                <th scope="row" className="file-row-number">
                  {index + 1}
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: A cell is identified by its fixed row/column coordinates.
                  <td key={column}>{row[column] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export function HtmlFrame({ html, name }: { html: string; name: string }) {
  return (
    <iframe
      className="file-preview-frame"
      title={name}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={sandboxDocument(html)}
    />
  );
}

function OfficeDocument({
  data,
  extension,
  name,
}: {
  data: ArrayBuffer;
  extension: string;
  name: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<OfficePreview | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const worker = new Worker(new URL("./office-worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = window.setTimeout(() => {
      worker.terminate();
      setError(t("filesDocumentLimit"));
    }, 15_000);
    worker.onmessage = (
      event: MessageEvent<{ result?: OfficePreview; error?: string }>,
    ) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.result) setResult(event.data.result);
      else setError(event.data.error || t("filesPreviewFailed"));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      setError(t("filesPreviewFailed"));
    };
    // Keep the caller's bytes intact for a later revision/remount.
    const copy = data.slice(0);
    worker.postMessage({ data: copy, extension }, [copy]);
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [data, extension, t]);
  if (error)
    return (
      <p role="alert" className="evidence-warning">
        {error}
      </p>
    );
  if (!result) return <p role="status">{t("readingFile")}</p>;
  if (result.kind === "document")
    return (
      <>
        <p className="file-preview-note">{t("filesOfficeLayout")}</p>
        <HtmlFrame html={result.html} name={name} />
      </>
    );
  if (result.kind === "sheets")
    return (
      <>
        {result.truncated && <p>{t("filesTableTruncated")}</p>}
        <div
          className="file-sheet-tabs"
          role="toolbar"
          aria-label={t("filesSheets")}
        >
          {result.sheets.map((sheet, index) => (
            <button
              type="button"
              key={sheet.name}
              aria-pressed={page === index}
              onClick={() => setPage(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
        {result.sheets[page] && <DataTable table={result.sheets[page]} />}
      </>
    );
  return (
    <>
      <div className="file-preview-toolbar">
        <button
          type="button"
          disabled={page === 0}
          aria-label={t("filesPreviousPage")}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft />
        </button>
        <span>
          {page + 1} / {result.slides.length}
        </span>
        <button
          type="button"
          disabled={page === result.slides.length - 1}
          aria-label={t("filesNextPage")}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight />
        </button>
      </div>
      <p className="file-preview-note">{t("filesSlidesLayout")}</p>
      {result.truncated && <p>{t("artifactPreviewTruncated")}</p>}
      <HtmlFrame html={result.slides[page]!} name={name} />
    </>
  );
}

function PdfDocument({ data }: { data: ArrayBuffer }) {
  const { t } = useTranslation();
  const [pdf, setPdf] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(
    null,
  );
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stopped = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    void Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ])
      .then(async ([library, worker]) => {
        if (stopped) return;
        library.GlobalWorkerOptions.workerSrc = worker.default;
        task = library.getDocument({
          data: new Uint8Array(data.slice(0)),
          useWasm: false,
          useSystemFonts: true,
          disableAutoFetch: true,
          maxImageSize: 16_000_000,
        });
        const document = await task.promise;
        if (!stopped) setPdf(document);
      })
      .catch((reason: unknown) => {
        if (!stopped) {
          setBusy(false);
          setError(
            reason instanceof Error ? reason.message : t("filesPreviewFailed"),
          );
        }
      });
    return () => {
      stopped = true;
      void task?.destroy();
    };
  }, [data, t]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let stopped = false;
    let render: import("pdfjs-dist").RenderTask | undefined;
    const target = canvas.current;
    setBusy(true);
    void pdf
      .getPage(page)
      .then(async (documentPage) => {
        if (stopped) return;
        const base = documentPage.getViewport({ scale: 1 });
        const factor = Math.min(
          scale * 1.5,
          Math.sqrt(8_000_000 / (base.width * base.height)),
        );
        const viewport = documentPage.getViewport({ scale: factor });
        target.width = viewport.width;
        target.height = viewport.height;
        target.style.width = `${Math.min(base.width, target.parentElement?.clientWidth || base.width) * scale}px`;
        render = documentPage.render({ canvas: target, viewport });
        await render.promise;
        if (!stopped) {
          setError("");
          setBusy(false);
        }
      })
      .catch((reason: unknown) => {
        if (!stopped) {
          setBusy(false);
          setError(
            reason instanceof Error ? reason.message : t("filesPreviewFailed"),
          );
        }
      });
    return () => {
      stopped = true;
      render?.cancel();
    };
  }, [pdf, page, scale, t]);
  return (
    <div className="file-pdf">
      <div className="file-preview-toolbar">
        <button
          type="button"
          aria-label={t("filesPreviousPage")}
          disabled={!pdf || page === 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft />
        </button>
        <span>
          {page} / {pdf?.numPages ?? "…"}
        </span>
        <button
          type="button"
          aria-label={t("filesNextPage")}
          disabled={!pdf || page === pdf.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight />
        </button>
        <button
          type="button"
          aria-label={t("filesZoomOut")}
          disabled={scale <= 0.5}
          onClick={() => setScale((value) => Math.max(0.5, value - 0.25))}
        >
          <Minus />
        </button>
        <button
          type="button"
          aria-label={t("filesZoomReset")}
          onClick={() => setScale(1)}
        >
          <Maximize /> {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          aria-label={t("filesZoomIn")}
          disabled={scale >= 3}
          onClick={() => setScale((value) => Math.min(3, value + 0.25))}
        >
          <Plus />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{t("readingFile")}</p>}
      <section
        className="file-media-viewport"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Large PDF pages need keyboard scrolling.
        tabIndex={0}
        aria-label={t("filePreview")}
      >
        <canvas
          ref={canvas}
          aria-label={t("filesPdfPage", { page })}
          role="img"
        />
      </section>
    </div>
  );
}

export default function DocumentPreview({
  artifact,
  client,
}: {
  artifact: ArtifactMetadata;
  client: WebClient;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void client
      .downloadArtifact(artifact, controller.signal)
      .then((blob) => blob.arrayBuffer())
      .then((bytes) => {
        if (!controller.signal.aborted) setData(bytes);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : t("filesPreviewFailed"),
          );
      });
    return () => controller.abort();
  }, [artifact, client, t]);
  if (error)
    return (
      <p role="alert" className="evidence-warning">
        {error}
      </p>
    );
  if (!data) return <p role="status">{t("readingFile")}</p>;
  const extension = artifact.name.split(".").at(-1)?.toLowerCase() ?? "";
  return extension === "pdf" ? (
    <PdfDocument data={data} />
  ) : (
    <OfficeDocument data={data} extension={extension} name={artifact.name} />
  );
}
