import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddedBrowserManager } from "../../web/host/embedded-browser.ts";

test("reports a browser killed during startup instead of waiting for the port timeout", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-startup-"));
  const executable = join(directory, "browser");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  try {
    await writeFile(executable, "#!/bin/sh\nkill -TERM $$\n");
    await chmod(executable, 0o700);
    process.env.OPENPI_CHROME_PATH = executable;
    const started = performance.now();
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      /SIGTERM/,
    );
    assert.ok(
      performance.now() - started < 2_000,
      "process death must not wait for the eight-second startup deadline",
    );
  } finally {
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a non-executable browser without an unhandled child-process error", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-permission-"));
  const executable = join(directory, "browser");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    process.env.OPENPI_CHROME_PATH = executable;
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      /could not start.*EACCES/,
    );
    assert.equal(await manager.state("fixture"), undefined);
  } finally {
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
