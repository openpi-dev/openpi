import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddedBrowserManager } from "../../web/host/embedded-browser.ts";

test("waits for browser close and its last profile write before removing the profile", {
  timeout: 10_000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-cleanup-"));
  const profile = join(directory, "profile");
  const release = join(directory, "release");
  const marker = join(directory, "writer-result");
  await mkdir(profile);
  const renderer = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [profile, release, marker] = process.argv.slice(1);
    process.stderr.write('renderer-ready');
    const timer = setInterval(() => {
      if (!fs.existsSync(release)) return;
      clearInterval(timer);
      try {
        fs.writeFileSync(path.join(profile, 'late-write'), 'renderer final write');
        fs.writeFileSync(marker, 'profile retained until renderer closed');
      } catch {
        fs.writeFileSync(marker, 'profile removed too early');
      }
      process.exit(0);
    }, 5);
    setTimeout(() => process.exit(2), 5_000).unref();
  `;
  const browser = spawn(
    process.execPath,
    [
      "-e",
      `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(renderer)}, ...process.argv.slice(1)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  `,
      profile,
      release,
      marker,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let hasClosed = false;
  const closed = new Promise<void>((resolve) =>
    browser.once("close", () => {
      hasClosed = true;
      resolve();
    }),
  );
  const exited = once(browser, "exit");
  assert.ok(browser.stderr);
  const ready = once(browser.stderr, "data");
  browser.stderr.resume();
  const manager = new EmbeddedBrowserManager();
  // The public disposal path needs a live native process, not a running CDP
  // server. Its renderer keeps stderr open after the browser process exits.
  Object.assign(manager, {
    session: {
      sessionId: "fixture",
      process: browser,
      closed,
      profile,
      frameListeners: new Set(),
      stopListening() {},
      cdp: { close() {} },
    },
  });
  const remove = fs.promises.rm;
  const removal = context.mock.method(
    fs.promises,
    "rm",
    async (
      path: Parameters<typeof remove>[0],
      options: Parameters<typeof remove>[1],
    ) => {
      if (path === profile)
        assert.equal(
          hasClosed,
          true,
          "profile removal must wait for the browser close event",
        );
      return remove(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    await ready;
    const disposed = manager.dispose().then(
      () => undefined,
      (error: unknown) => error,
    );
    await exited;
    assert.equal(
      hasClosed,
      false,
      "exit alone does not confirm inherited stderr has closed",
    );
    await writeFile(release, "release renderer");
    await closed;
    assert.equal(await disposed, undefined);
    assert.equal(
      await readFile(marker, "utf8"),
      "profile retained until renderer closed",
    );
    await assert.rejects(access(profile), { code: "ENOENT" });
  } finally {
    removal.mock.restore();
    syncBuiltinESMExports();
    await writeFile(release, "release renderer");
    if (browser.exitCode === null && browser.signalCode === null)
      browser.kill("SIGKILL");
    await closed;
    await manager.dispose();
    await remove(directory, { recursive: true, force: true });
  }
});

test("preserves the original startup failure when profile cleanup also fails", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "openpi-browser-cleanup-error-"),
  );
  const executable = join(directory, "browser");
  const profileRecord = join(directory, "profile");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  const remove = fs.promises.rm;
  let profile: string | undefined;
  context.mock.method(console, "error", () => {});
  const removal = context.mock.method(
    fs.promises,
    "rm",
    async (
      path: Parameters<typeof remove>[0],
      options: Parameters<typeof remove>[1],
    ) => {
      profile ??= await readFile(profileRecord, "utf8").catch(() => undefined);
      if (path === profile)
        throw Object.assign(new Error("fixture cleanup denied"), {
          code: "EACCES",
        });
      return remove(path, options);
    },
  );
  syncBuiltinESMExports();
  try {
    await writeFile(
      executable,
      `#!/bin/sh
for argument do
  case "$argument" in --user-data-dir=*) printf '%s' "${"${argument#*=}"}" > '${profileRecord}' ;; esac
done
exit 7
`,
    );
    await chmod(executable, 0o700);
    process.env.OPENPI_CHROME_PATH = executable;
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Embedded browser exited during startup (exit 7)",
        );
        assert.ok(error.cause && typeof error.cause === "object");
        const cause = error.cause as Record<string, unknown>;
        assert.equal(cause.failure, "exit");
        assert.equal(cause.exitCode, 7);
        assert.ok(
          cause.cleanupError,
          "the secondary cleanup failure must remain available to operators",
        );
        return true;
      },
    );
  } finally {
    removal.mock.restore();
    syncBuiltinESMExports();
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    if (profile) await remove(profile, { recursive: true, force: true });
    await remove(directory, { recursive: true, force: true });
  }
});
