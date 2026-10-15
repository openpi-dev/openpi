import {
  WEB_PROMPT_FILE_MAX_BYTES,
  type WebPromptFileUpload,
} from "../../../../protocol/prompt-files.ts";
import { type PromptFileText, promptFileKind } from "./file-text.ts";

export interface StagedPromptFile extends WebPromptFileUpload {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  extraction: "text" | "unavailable" | "truncated";
  extractionError?: PromptFileText["extractionError"];
}

const extractionLimitMs = 15_000;

function readFile(file: File, signal?: AbortSignal) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("file-read"));
    };
    const abort = () => {
      reader.abort();
      finish(new DOMException("File staging cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      reader.abort();
      finish(new Error("file-timeout"));
    }, extractionLimitMs);
    reader.onload = () => finish();
    reader.onerror = () => finish(new Error("file-read"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else reader.readAsArrayBuffer(file);
  });
}

function extractDocument(
  data: ArrayBuffer,
  kind: string,
  signal?: AbortSignal,
) {
  return new Promise<PromptFileText & { data: string }>((resolve, reject) => {
    const worker = new Worker(
      new URL("./file-text-worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    const finish = (
      result?: PromptFileText & { data: string },
      error?: Error,
    ) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("file-document-invalid"));
    };
    const abort = () =>
      finish(
        undefined,
        new DOMException("File staging cancelled.", "AbortError"),
      );
    const timer = setTimeout(
      () => finish(undefined, new Error("file-timeout")),
      extractionLimitMs,
    );
    worker.onmessage = (
      event: MessageEvent<{
        result?: PromptFileText & { data: string };
        error?: string;
      }>,
    ) => {
      // PDF.js also emits its internal worker handshake. Only our staging
      // response terminates the extraction worker.
      if (!event.data || !("result" in event.data || "error" in event.data))
        return;
      if (event.data.error) finish(undefined, new Error(event.data.error));
      else finish(event.data.result);
    };
    worker.onerror = () =>
      finish(undefined, new Error("file-document-invalid"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else {
      worker.postMessage({ data, kind }, [data]);
    }
  });
}

export async function stagePromptFile(file: File, signal?: AbortSignal) {
  if (file.size > WEB_PROMPT_FILE_MAX_BYTES) throw new Error("file-size");
  const data = await readFile(file, signal);
  const bytes = new Uint8Array(data);
  const kind = promptFileKind(file.name, file.type, bytes);
  const size = bytes.length;
  const extraction = await extractDocument(data, kind, signal);
  signal?.throwIfAborted();
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${file.name}`,
    name: file.name || "file",
    size,
    mimeType: file.type || "application/octet-stream",
    ...extraction,
  } satisfies StagedPromptFile;
}
