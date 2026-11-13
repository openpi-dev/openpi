import { extractPromptFileText } from "../composer/file-text.ts";
import { previewOfficeDocument } from "./office-preview.ts";

type DocumentRequest =
  | { operation: "extract"; data: ArrayBuffer; kind: string }
  | { operation: "preview"; data: ArrayBuffer; extension: string };

// Each caller creates its own Worker, so cancellation and time limits remain
// independent while Vite emits the document libraries only once.
self.onmessage = (event: MessageEvent<DocumentRequest>) => {
  if (event.data.operation === "preview") {
    void previewOfficeDocument(event.data.data, event.data.extension).then(
      (result) => self.postMessage({ result }),
      (error: unknown) =>
        self.postMessage({
          error:
            error instanceof Error
              ? error.message
              : "Unable to preview this document.",
        }),
    );
    return;
  }
  // Keep encoding off the UI thread too: a permitted upload can be 50 MiB.
  const bytes = new Uint8Array(event.data.data);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  const data = btoa(binary);
  void extractPromptFileText(event.data.data, event.data.kind).then(
    (result) => self.postMessage({ result: { data, ...result } }),
    (error: unknown) =>
      self.postMessage({
        result: {
          data,
          extraction: "unavailable",
          extractionError:
            error instanceof Error && error.message === "file-text-encoding"
              ? "encoding"
              : "document",
        },
      }),
  );
};
