// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../../web/protocol/prompt-files.ts";
import { stagePromptFile } from "../../web/ui/src/features/composer/file-attachments.ts";

class StagingWorker {
  static instances: StagingWorker[] = [];
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    StagingWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  StagingWorker.instances = [];
});

describe("composer file staging boundary", () => {
  it("retains original bytes metadata and explicit extraction state from its worker", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    const pending = stagePromptFile(
      new File(["你好"], "notes.txt", { type: "text/plain" }),
    );
    await vi.waitFor(() => expect(StagingWorker.instances).toHaveLength(1));
    const worker = StagingWorker.instances[0]!;
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: "text",
    });
    worker.onmessage?.({
      data: { sourceName: "worker", targetName: "main", action: "ready" },
    } as MessageEvent);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage?.({
      data: { result: { data: "5L2g5aW9", text: "你好", extraction: "text" } },
    } as MessageEvent);
    const result = await pending;
    expect(result).toMatchObject({
      name: "notes.txt",
      mimeType: "text/plain",
      size: 6,
      data: "5L2g5aW9",
      text: "你好",
      extraction: "text",
    });
    expect(result.id).toBeTruthy();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects oversize before reading or allocating a worker", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    const file = new File([], "large.bin");
    Object.defineProperty(file, "size", {
      value: WEB_PROMPT_FILE_MAX_BYTES + 1,
    });
    await expect(stagePromptFile(file)).rejects.toThrow("file-size");
    expect(StagingWorker.instances).toHaveLength(0);
  });

  it("does not read or start a worker when already cancelled", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    const controller = new AbortController();
    controller.abort();
    await expect(
      stagePromptFile(new File(["x"], "x.txt"), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(StagingWorker.instances).toHaveLength(0);
  });

  it("terminates an in-flight parser on cancellation", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    const controller = new AbortController();
    const pending = stagePromptFile(
      new File(["x"], "x.txt"),
      controller.signal,
    );
    const result = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(StagingWorker.instances).toHaveLength(1));
    controller.abort();
    await result;
    expect(StagingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("reports parser rejection instead of creating a misleading attachment", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    const pending = stagePromptFile(new File(["broken"], "report.docx"));
    const result = expect(pending).rejects.toThrow("file-document-invalid");
    await vi.waitFor(() => expect(StagingWorker.instances).toHaveLength(1));
    const worker = StagingWorker.instances[0]!;
    worker.onmessage?.({
      data: { error: "file-document-invalid" },
    } as MessageEvent);
    await result;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a stuck extraction at its wall-clock limit", async () => {
    vi.stubGlobal("Worker", StagingWorker);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = stagePromptFile(new File(["x"], "x.txt"));
    const result = expect(pending).rejects.toThrow("file-timeout");
    await vi.waitFor(() => expect(StagingWorker.instances).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(StagingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
