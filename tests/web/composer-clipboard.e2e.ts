import { expect, test } from "@playwright/test";
import { installThinkingFixture } from "./thinking-e2e-support.ts";

test("native Chromium image paste preserves accompanying text, caret, undo and image payloads", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installThinkingFixture(page);
  let admission:
    | { content: string; images?: { mimeType: string; data: string }[] }
    | undefined;
  await page.route("**/api/prompt", async (route) => {
    admission = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      json: { id: "clipboard-prompt", accepted: true },
    });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "描述任务" });
  await expect(input).toBeEnabled();
  await input.fill("before  after");
  await input.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement) element.setSelectionRange(7, 7);
  });
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#123abc";
    drawing.fillRect(0, 0, 64, 32);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("No PNG"))),
        "image/png",
      ),
    );
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": png,
        "text/plain": new Blob(["caption"], { type: "text/plain" }),
      }),
    ]);
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await input.press(`${modifier}+V`);
  await expect(input).toHaveValue("before caption after");
  await expect(page.locator(".composer-attachment")).toHaveCount(1);
  await input.press(`${modifier}+Z`);
  await expect(input).toHaveValue("before  after");
  await input.press(`${modifier}+Shift+Z`);
  await expect(input).toHaveValue("before caption after");
  await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const png = await items[0]!.getType("image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  await input.press(`${modifier}+V`);
  await expect(page.locator(".composer-attachment")).toHaveCount(2);
  await expect(input).toHaveValue("before caption after");
  await expect
    .poll(() =>
      page
        .locator(".composer-attachment img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement && image.naturalWidth === 64,
          ),
        ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => admission).toBeTruthy();
  expect(admission?.content).toBe("before caption after");
  expect(admission?.images).toHaveLength(2);
  expect(
    admission?.images?.every(
      (image) =>
        image.mimeType === "image/png" && image.data.startsWith("iVBOR"),
    ),
  ).toBe(true);
});
