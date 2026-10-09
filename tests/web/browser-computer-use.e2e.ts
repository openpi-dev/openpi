import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";

test("embedded computer-use targets exact same-process and cross-process documents", async ({
  baseURL,
}) => {
  const profile = await mkdtemp(join(tmpdir(), "openpi-frame-control-"));
  const fixture = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Frame-Options", "DENY");
    response.end(
      "<!doctype html><style>html{background:rgb(23,170,68)}</style><title>Frame control</title><h1>Embedded fixture</h1><input aria-label=\"Editor\" value=\"original\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Save</button><button onclick=\"parent.postMessage('openpi-slow-start','*');const until=Date.now()+1400;while(Date.now()<until){}\">Slow</button><output>Waiting</output>",
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  const context = await chromium.launchPersistentContext(profile, {
    baseURL,
    locale: "zh-CN",
    // A native extension controls the real viewport; a second CDP client's
    // device emulation changes layout without matching the native compositor.
    viewport: null,
    channel: "chromium",
    executablePath: process.env.OPENPI_WEB_BROWSER_EXECUTABLE,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--window-size=1440,900"],
  });
  try {
    const cdp = await context.browser()!.newBrowserCDPSession();
    await cdp.send("Extensions.loadUnpacked", {
      path: join(process.cwd(), "web/browser-extension"),
    });
    const page = context.pages()[0]!;
    await page.goto("/");
    await page.getByRole("button", { name: "打开工具", exact: true }).click();
    await page
      .locator(".workbar-panel")
      .getByRole("button", { name: /^浏览器/ })
      .click();
    const active = page.locator(".browser-page:not([hidden])");
    // This test covers the native provider. Host/controller and stale-state authority have separate broker tests.
    const control = (
      id: string,
      document: string,
      request: unknown,
      requestId = randomUUID(),
      cancelOnStart = false,
    ) =>
      page.evaluate(
        ({ id, document, request, requestId, cancelOnStart }) =>
          new Promise<{
            result?: {
              nodes: {
                ref: string;
                role: string;
                name: string;
                value?: string;
              }[];
              text: string;
              image?: string;
            };
            error?: string;
            cancellationSent: boolean;
          }>((resolve, reject) => {
            let cancellationSent = false;
            const timer = setTimeout(() => {
              window.removeEventListener("message", receive);
              reject(new Error("Native browser result timed out"));
            }, 15000);
            const receive = (event: MessageEvent) => {
              const frame = window.document.querySelector<HTMLIFrameElement>(
                `iframe[data-openpi-browser-page=${JSON.stringify(id)}]`,
              );
              if (
                cancelOnStart &&
                event.source === frame?.contentWindow &&
                event.data === "openpi-slow-start"
              ) {
                cancellationSent = true;
                window.postMessage(
                  {
                    source: "openpi-browser-ui",
                    type: "control-cancel",
                    requestId,
                  },
                  location.origin,
                );
                return;
              }
              if (
                event.source !== window ||
                event.origin !== location.origin ||
                event.data?.source !== "openpi-browser-extension" ||
                event.data.requestId !== requestId
              )
                return;
              clearTimeout(timer);
              window.removeEventListener("message", receive);
              resolve({ ...event.data, cancellationSent });
            };
            window.addEventListener("message", receive);
            window.postMessage(
              {
                source: "openpi-browser-ui",
                type: "control",
                id,
                document,
                requestId,
                request,
              },
              location.origin,
            );
          }),
        { id, document, request, requestId, cancelOnStart },
      );
    for (const host of ["127.0.0.1", "localhost"]) {
      await active
        .getByRole("textbox", { name: "浏览器地址" })
        .fill(`http://${host}:${address.port}/`);
      await active.locator("button[type=submit]").click();
      await expect(
        active.frameLocator("iframe").getByRole("textbox", { name: "Editor" }),
      ).toHaveValue("original");
      const frame = active.locator("iframe[data-openpi-browser-document]");
      await expect(frame).toHaveCount(1);
      const id = (await frame.getAttribute("data-openpi-browser-page"))!;
      const documentId = (await frame.getAttribute(
        "data-openpi-browser-document",
      ))!;
      const observed = await control(id, documentId, {
        operation: "observe",
        image: true,
      });
      expect(observed.error).toBeUndefined();
      expect(observed.result!.text).toContain("Embedded fixture");
      const input = observed.result!.nodes.find(
        (node) => node.role === "textbox" && node.name === "Editor",
      )!;
      const save = observed.result!.nodes.find(
        (node) => node.role === "button" && node.name === "Save",
      )!;
      expect(input).toBeTruthy();
      expect(save).toBeTruthy();
      const png = Buffer.from(observed.result!.image!, "base64");
      await test.info().attach(`embedded-${host}.png`, {
        body: png,
        contentType: "image/png",
      });
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      // Independently decode the image: both bottom corners must be the fixture,
      // not the OpenPI notice or surrounding workbench.
      const corners = await page.evaluate(async (data) => {
        const image = await createImageBitmap(
          new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
            type: "image/png",
          }),
        );
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = [20, image.width - 20].map((x) => [
          ...context.getImageData(x, image.height - 20, 1, 1).data,
        ]);
        image.close();
        return pixels;
      }, observed.result!.image!);
      expect(corners).toEqual([
        [23, 170, 68, 255],
        [23, 170, 68, 255],
      ]);
      const acted = await control(id, documentId, {
        operation: "act",
        actions: [
          { action: "setText", ref: input.ref, text: "内置浏览器中文输入" },
          { action: "press", ref: save.ref },
        ],
      });
      expect(acted.error).toBeUndefined();
      await expect(
        active.frameLocator("iframe").getByRole("textbox", { name: "Editor" }),
      ).toHaveValue("内置浏览器中文输入");
      await expect(active.frameLocator("iframe").locator("output")).toHaveText(
        "内置浏览器中文输入",
      );
      const stale = await control(id, crypto.randomUUID(), {
        operation: "act",
        actions: [
          { action: "setText", ref: input.ref, text: "must not write" },
        ],
      });
      expect(stale.error).toContain("stale");
      await expect(
        active.frameLocator("iframe").getByRole("textbox", { name: "Editor" }),
      ).toHaveValue("内置浏览器中文输入");
      if (host === "localhost") {
        const fresh = await control(id, documentId, { operation: "observe" });
        const slow = fresh.result!.nodes.find(
          (node) => node.role === "button" && node.name === "Slow",
        )!;
        const requestId = randomUUID();
        const cancelling = control(
          id,
          documentId,
          {
            operation: "act",
            actions: [
              { action: "press", ref: slow.ref },
              {
                action: "setText",
                ref: input.ref,
                text: "must not write after cancellation",
              },
            ],
          },
          requestId,
          true,
        );
        const cancelled = await cancelling;
        expect(cancelled.cancellationSent).toBe(true);
        expect(cancelled.error).toMatch(/revoked.*uncertain/i);
        await expect(
          active
            .frameLocator("iframe")
            .getByRole("textbox", { name: "Editor" }),
        ).toHaveValue("内置浏览器中文输入");
      }
    }
    expect(context.pages()).toHaveLength(1);
    const worker = context.serviceWorkers()[0]!;
    const detached = await worker.evaluate(
      "(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});try{await chrome.debugger.sendCommand({tabId:tab.id},'Page.getFrameTree');return 'still attached';}catch(error){return String(error.message);}})()",
    );
    expect(detached).toMatch(/not attached/i);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(profile, { force: true, recursive: true });
  }
});
