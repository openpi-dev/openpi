import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test as base } from "@playwright/test";

// The shared setup path is frozen on import. A dedicated worker prevents an
// unrelated spec's config import from choosing this fixture's agent directory.
const test = base.extend<
  Record<never, never>,
  { browserAgentDirectory: string }
>({
  browserAgentDirectory: [
    async ({ browserName }, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), `openpi-native-${browserName}-`),
      );
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = directory;
      try {
        await use(directory);
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

for (const portable of [false, true])
  test(`native ${portable ? "portable WebExtension" : "CDP"} selection uses its live profile, Chinese input, exact document and real screenshot`, async ({
    browserAgentDirectory: directory,
  }) => {
    test.setTimeout(60_000);
    const config = join(directory, "my-pi-setup.json");
    await writeFile(
      config,
      JSON.stringify({
        browser: {
          control: true,
          externalBrowsers: ["chrome", "edge", "chromium"],
          defaultBrowser: "chrome",
        },
      }),
    );
    const { WebBrowserBroker, validBrowserPages } = await import(
      "../../web/host/browser-control.ts"
    );
    const { SETUP_CONFIG_PATH } = await import(
      "../../extensions/shared/setup-config.ts"
    );
    expect(SETUP_CONFIG_PATH).toBe(config);
    const owner = {
      sessionId: "native-fixture",
      workspace: directory,
      commandId: "native-turn",
      epoch: 1,
      controllerId: "795239cc-8ff9-49cb-9894-e16b3ba86af7",
    };
    const broker = new WebBrowserBroker(() => owner);
    const fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><title>Native fixture</title><style>html{background:rgb(23,170,68)}</style><h1>Native browser fixture</h1><input aria-label=\"Editor\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Save</button><output>Waiting</output>",
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, "127.0.0.1", resolve),
    );
    const fixtureAddress = fixture.address();
    if (!fixtureAddress || typeof fixtureAddress === "string")
      throw new Error("Fixture not listening");
    const target = `http://127.0.0.1:${fixtureAddress.port}/`;
    const host = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><title>OpenPI</title><meta name="openpi-web-token" content="${"a".repeat(64)}"><h1>Native transport fixture</h1><script>
      let paired;addEventListener('message',async(event)=>{const m=event.data;if(event.source!==window||m?.source!=='openpi-browser-extension'||m.type!=='connector-hello'||paired===m.bridgeId)return;paired=m.bridgeId;const result=await fetch('/pair',{method:'POST',body:JSON.stringify(m)}).then(r=>r.json());window.postMessage({source:'openpi-browser-ui',type:'connector-authorize',...result},location.origin);});
      </script>`);
        return;
      }
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        response.setHeader("Content-Type", "application/json");
        if (url.pathname === "/pair") {
          response.end(
            JSON.stringify(broker.connect(owner.controllerId, body)),
          );
          return;
        }
        const id = url.searchParams.get("connectionId")!;
        if (
          !broker.authenticate(
            id,
            request.headers.authorization,
            request.headers.origin,
          )
        ) {
          response.writeHead(401).end();
          return;
        }
        if (body.closed === true) {
          broker.disconnect(id);
          response.end(JSON.stringify({ closed: true }));
          return;
        }
        if (!validBrowserPages(body.pages, 64)) {
          response
            .writeHead(400)
            .end(JSON.stringify({ error: "Invalid native pages" }));
          return;
        }
        const state = broker.pollNative(id, body.pages);
        if (body.requestId) {
          const accepted = broker.resultNative(
            id,
            body.requestId,
            body.result,
            body.error,
          );
          response.statusCode = accepted ? 200 : 409;
          response.end(JSON.stringify({ accepted, enabled: state.enabled }));
        } else response.end(JSON.stringify(state));
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const hostAddress = host.address();
    if (!hostAddress || typeof hostAddress === "string")
      throw new Error("Host not listening");
    const context = await chromium.launchPersistentContext(
      join(directory, "profile"),
      {
        channel: "chromium",
        viewport: null,
        executablePath: process.env.OPENPI_WEB_BROWSER_EXECUTABLE,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: ["--enable-unsafe-extension-debugging", "--window-size=1440,900"],
      },
    );
    try {
      const cdp = await context.browser()!.newBrowserCDPSession();
      let extension = join(process.cwd(), "web/browser-extension");
      if (portable) {
        extension = join(directory, "portable-extension");
        await cp(
          join(process.cwd(), "web/browser-extension-portable"),
          extension,
          { recursive: true },
        );
        const manifest = JSON.parse(
          await readFile(join(extension, "manifest.json"), "utf8"),
        );
        // Portable control is exercised in an isolated Chromium profile here;
        // actual Safari acceptance remains a separate, real-browser smoke.
        manifest.manifest_version = 3;
        manifest.background = { service_worker: "background.js" };
        manifest.host_permissions = ["<all_urls>"];
        manifest.permissions = manifest.permissions.filter(
          (permission: string) => permission !== "<all_urls>",
        );
        delete manifest.browser_specific_settings;
        await writeFile(
          join(extension, "manifest.json"),
          JSON.stringify(manifest),
        );
      }
      await cdp.send("Extensions.loadUnpacked", {
        path: extension,
      });
      const workbench = context.pages()[0]!;
      await workbench.goto(`http://127.0.0.1:${hostAddress.port}/`);
      await expect
        .poll(() => broker.profiles().some((profile) => profile.connected))
        .toBe(true);
      const profile = broker.profiles()[0]!;
      if (portable)
        expect(
          await context
            .serviceWorkers()[0]!
            .evaluate(() =>
              Boolean(
                (globalThis as { chrome?: { debugger?: unknown } }).chrome
                  ?.debugger,
              ),
            ),
        ).toBe(false);
      // The fixture can run in Chrome or Chromium; select the actual reported browser explicitly.
      const opened = await broker.execute({
        operation: "open",
        browser: profile.browser,
        url: target,
      });
      const root = (opened.details as { root: string }).root;
      const observation = await broker.execute({
        operation: "observe",
        root,
        image: true,
      });
      const details = observation.details as {
        stateId: string;
        nodes: { ref: string; role: string; name: string }[];
        text: string;
      };
      expect(details.text).toContain("Native browser fixture");
      const input = details.nodes.find(
        (node) => node.role === "textbox" && node.name === "Editor",
      )!;
      const save = details.nodes.find(
        (node) => node.role === "button" && node.name === "Save",
      )!;
      const enteredText = `${profile.browser} 原生浏览器中文验收`;
      const written = await broker.execute({
        operation: "act",
        root,
        stateId: details.stateId,
        actions: [
          { action: "setText", ref: input.ref, text: enteredText },
          { action: "press", ref: save.ref },
        ],
        image: true,
      });
      expect((written.details as { text: string }).text).toContain(enteredText);
      const image = written.content.find((item) => item.type === "image");
      expect(image?.type).toBe("image");
      if (image?.type === "image") {
        await writeFile(
          test.info().outputPath("native-browser.png"),
          Buffer.from(image.data, "base64"),
        );
        const pixel = await workbench.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return {
            width: image.width,
            height: image.height,
            rgba: [...context.getImageData(1, 1, 1, 1).data],
          };
        }, image.data);
        expect(pixel.rgba).toEqual([23, 170, 68, 255]);
        expect(pixel.width).toBeGreaterThan(400);
        await test.info().attach("native-browser-screenshot", {
          body: Buffer.from(image.data, "base64"),
          contentType: "image/png",
        });
        expect(
          Buffer.from(image.data, "base64").subarray(1, 4).toString(),
        ).toBe("PNG");
      }
      await expect(
        broker.execute({
          operation: "act",
          root,
          stateId: details.stateId,
          actions: [{ action: "press", ref: save.ref }],
        }),
      ).rejects.toThrow(/state is stale/);
      await expect(
        broker.execute({ operation: "tabs", browser: "brave" }),
      ).rejects.toThrow(/not allowed/);
      await writeFile(config, JSON.stringify({ browser: { control: false } }));
      broker.reconcile();
      await expect(
        broker.execute({ operation: "tabs", browser: profile.browser }),
      ).rejects.toThrow(/enabled/);
      await workbench.close();
      await expect.poll(() => broker.profiles().length).toBe(0);
      const native = context.pages().find((page) => page.url() === target)!;
      await native.reload();
      await expect(
        native.getByRole("heading", { name: "Native browser fixture" }),
      ).toBeVisible();
    } finally {
      broker.dispose();
      await context.close();
      await Promise.all([
        new Promise<void>((resolve) => host.close(() => resolve())),
        new Promise<void>((resolve) => fixture.close(() => resolve())),
      ]);
    }
  });
