import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../../web/host/browser-launcher.ts";
import { formatWebReadyScreen } from "../../web/host/terminal-status.ts";

const status = (url: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    get(
      url,
      {
        headers: {
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on("error", reject);
  });

const unix = process.platform !== "win32";

test("ready screen can expose the address before browser launch completes", () => {
  const output = formatWebReadyScreen({
    origin: "http://127.0.0.1:1234",
    url: "http://127.0.0.1:1234/#token=secret",
    opened: "pending",
    color: false,
  });
  assert.match(output, /ready/u);
  assert.match(output, /http:\/\/127.0.0.1:1234/u);
  assert.match(output, /opening/u);
  assert.doesNotMatch(output, /secret|open requested/u);
});

test("browser launch accepts cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await openBrowser("http://127.0.0.1:1", controller.signal),
    false,
  );
});

for (const outcome of ["timeout", "cancel"] as const) {
  test(`CLI serves before a stalled browser opener finishes: ${outcome}`, {
    skip: !unix,
    timeout: 60000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "openpi-startup-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    // exec keeps the stalled process owned by execFile, with no descendant to leak.
    await writeFile(
      join(bin, process.platform === "darwin" ? "open" : "xdg-open"),
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'\n`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../bin/openpi.js", import.meta.url)),
        "web",
        "--no-workspace",
        "--port",
        "0",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PI_CODING_AGENT_DIR: join(root, "agent"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const waitFor = async (pattern: RegExp, timeout: number) => {
      const start = Date.now();
      while (!pattern.test(output)) {
        assert.equal(
          child.exitCode,
          null,
          "CLI exited before expected startup state",
        );
        assert.ok(
          Date.now() - start < timeout,
          "startup state deadline exceeded",
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await waitFor(/Starting OpenPI Web Workbench/u, 5000);
      await waitFor(/Local\s+(http:\/\/127.0.0.1:\d+)/u, 45000);
      assert.doesNotMatch(output, /Browser did not open/u);
      const origin = /Local\s+(http:\/\/127.0.0.1:\d+)/u.exec(output)?.[1];
      assert.ok(origin);
      assert.equal(await status(origin), 200);
      if (outcome === "cancel") {
        child.kill("SIGTERM");
        const [code] = await closed;
        assert.equal(code, 0);
        assert.doesNotMatch(output, /Browser did not open/u);
        return;
      }
      await waitFor(/Browser did not open/u, 7000);
      assert.equal(await status(origin), 200);
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await closed;
      clearTimeout(kill);
      await rm(root, { recursive: true, force: true });
    }
  });
}
