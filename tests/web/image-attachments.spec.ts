// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  sniffPromptImageMime,
  stagePromptImage,
} from "../../web/ui/src/features/composer/image-attachments.ts";

describe("composer image attachments", () => {
  it("sniffs supported image content instead of trusting the filename", () => {
    expect(
      sniffPromptImageMime(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    expect(sniffPromptImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("stages a bounded image with a data preview", async () => {
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01])],
      "renamed.txt",
      { type: "text/plain" },
    );
    const staged = await stagePromptImage(file);

    expect(staged.mimeType).toBe("image/jpeg");
    expect(staged.previewUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(staged.name).toBe("renamed.txt");
  });

  it("classifies a failed byte read separately from an unsupported format", async () => {
    const file = new File(["unreadable"], "photo.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => {
        throw new DOMException(
          "The file could not be read.",
          "NotReadableError",
        );
      },
    });
    await expect(stagePromptImage(file)).rejects.toThrow("image-read");
  });

  it("keeps invalid image signatures on the unsupported-format path", async () => {
    const file = new File(["not an image"], "photo.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("not an image").buffer,
    });
    await expect(stagePromptImage(file)).rejects.toThrow("image-type");
  });
});
