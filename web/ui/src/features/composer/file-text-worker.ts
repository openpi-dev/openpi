import { extractPromptFileText } from "./file-text.ts";

self.onmessage = (event: MessageEvent<{ data: ArrayBuffer; kind: string }>) => {
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
