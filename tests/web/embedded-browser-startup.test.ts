import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddedBrowserManager } from "../../web/host/embedded-browser.ts";

function startupDiagnostics(error: unknown) {
  assert.ok(error instanceof Error);
  assert.ok(error.cause && typeof error.cause === "object");
  return error.cause as Record<string, unknown>;
}

test("preserves the startup failure and profile cleanup even when host logging throws", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "openpi-browser-log-failure-"),
  );
  const executable = join(directory, "browser");
  const profileRecord = join(directory, "profile");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  let attempts = 0;
  context.mock.method(console, "error", () => {
    attempts++;
    throw new Error("fixture logging failed");
  });
  try {
    await writeFile(
      executable,
      `#!/bin/sh
for argument do
  case "$argument" in --user-data-dir=*) printf '%s' "${"${argument#*=}"}" > '${profileRecord}' ;; esac
done
printf 'fixture browser exit reason\\n' >&2
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
        assert.equal(startupDiagnostics(error).failure, "exit");
        return true;
      },
    );
    assert.equal(attempts, 1);
    await assert.rejects(access(await readFile(profileRecord, "utf8")), {
      code: "ENOENT",
    });
    assert.equal(await manager.state("fixture"), undefined);
  } finally {
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a browser killed during startup instead of waiting for the port timeout", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async (context) => {
  const logged: unknown[] = [];
  context.mock.method(console, "error", (_message: unknown, cause: unknown) => {
    logged.push(cause);
  });
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-startup-"));
  const executable = join(directory, "browser");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  try {
    await writeFile(
      executable,
      "#!/bin/sh\nprintf 'fixture browser terminated during initialization\\n' >&2\nkill -TERM $$\n",
    );
    await chmod(executable, 0o700);
    process.env.OPENPI_CHROME_PATH = executable;
    const started = performance.now();
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      (error: unknown) => {
        const cause = startupDiagnostics(error);
        assert.equal(cause.stage, "debug-port");
        assert.equal(cause.failure, "exit");
        assert.equal(cause.signal, "SIGTERM");
        assert.ok(typeof cause.stderr === "string");
        assert.match(
          cause.stderr,
          /fixture browser terminated during initialization/,
        );
        assert.ok(error instanceof Error);
        assert.match(error.message, /SIGTERM/);
        assert.doesNotMatch(error.message, /fixture browser terminated/);
        assert.deepEqual(logged, [cause]);
        return true;
      },
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
}, async (context) => {
  const logged: unknown[] = [];
  context.mock.method(console, "error", (_message: unknown, cause: unknown) => {
    logged.push(cause);
  });
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-permission-"));
  const executable = join(directory, "browser");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    process.env.OPENPI_CHROME_PATH = executable;
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      (error: unknown) => {
        const cause = startupDiagnostics(error);
        assert.equal(cause.failure, "spawn");
        assert.equal(cause.spawnErrorCode, "EACCES");
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not start.*EACCES/);
        assert.deepEqual(logged, [cause]);
        return true;
      },
    );
    assert.equal(await manager.state("fixture"), undefined);
  } finally {
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains a bounded startup stderr tail and port errno without exposing them in the timeout message", {
  skip: process.platform === "win32",
  timeout: 12_000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-browser-timeout-"));
  const executable = join(directory, "browser");
  const configured = process.env.OPENPI_CHROME_PATH;
  const manager = new EmbeddedBrowserManager();
  const logged: unknown[] = [];
  context.mock.method(console, "error", (_message: unknown, cause: unknown) => {
    logged.push(cause);
  });
  try {
    await writeFile(
      executable,
      `#!/bin/sh
for argument do
  case "$argument" in --user-data-dir=*) fixture_profile="${"${argument#*=}"}" ;; esac
done
mkdir "$fixture_profile/DevToolsActivePort"
printf '%s' 'discarded-prefix:${"界".repeat(2_000)}:retained-tail' >&2
printf ' fixture_profile=%s\\n' "$fixture_profile" >&2
exec /bin/sleep 30
`,
    );
    await chmod(executable, 0o700);
    process.env.OPENPI_CHROME_PATH = executable;
    await assert.rejects(
      manager.open("fixture", "http://127.0.0.1/"),
      (error: unknown) => {
        const cause = startupDiagnostics(error);
        assert.equal(cause.stage, "debug-port");
        assert.equal(cause.failure, "timeout");
        assert.equal(cause.portReadErrorCode, "EISDIR");
        assert.equal(cause.exitCode, null);
        assert.equal(cause.signal, null);
        assert.ok(
          typeof cause.elapsedMs === "number" &&
            cause.elapsedMs >= 8_000 &&
            cause.elapsedMs < 10_000,
        );
        assert.ok(typeof cause.stderr === "string");
        assert.ok(Buffer.byteLength(cause.stderr, "utf8") <= 4 * 1024);
        assert.match(cause.stderr, /:retained-tail/);
        assert.doesNotMatch(cause.stderr, /discarded-prefix/);
        assert.match(cause.stderr, /fixture_profile=/);
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Embedded browser startup timed out");
        assert.deepEqual(logged, [cause]);
        return true;
      },
    );
  } finally {
    if (configured === undefined) delete process.env.OPENPI_CHROME_PATH;
    else process.env.OPENPI_CHROME_PATH = configured;
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
