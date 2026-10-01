// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function extract(bytes: Uint8Array, kind: string) {
  const worker = {
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", worker);
  await import("../../web/ui/src/features/composer/file-text-worker.ts");
  worker.onmessage?.({
    data: { data: Uint8Array.from(bytes).buffer, kind },
  } as MessageEvent);
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
  return worker.postMessage.mock.calls[0]![0].result;
}

describe("optional attachment text extraction", () => {
  it("preserves unreadable text bytes without inventing decoded text", async () => {
    const bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    const result = await extract(bytes, "text");
    expect(result).toEqual({
      data: btoa(String.fromCharCode(...bytes)),
      extraction: "unavailable",
      extractionError: "encoding",
    });
  });

  it("retains a malformed document as an original file with a visible extraction failure", async () => {
    const bytes = new TextEncoder().encode("not a Word archive");
    const result = await extract(bytes, "docx");
    expect(result).toEqual({
      data: btoa(String.fromCharCode(...bytes)),
      extraction: "unavailable",
      extractionError: "document",
    });
  });

  it("keeps opaque original files distinct from failed extraction", async () => {
    const bytes = new Uint8Array([0, 1, 255]);
    expect(await extract(bytes, "binary")).toEqual({
      data: "AAH/",
      extraction: "unavailable",
    });
  });
});
