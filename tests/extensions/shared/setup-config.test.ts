import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

// getAgentDir() reads this at import time, so it must be set before the module
// under test is loaded.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  DEFAULT_SETUP_CONFIG,
  DEFAULT_WEB_APPEARANCE,
  FOOTER_PRESET_DEFINITIONS,
  formatSetupConfig,
  loadSetupConfig,
  inspectSetupConfig,
  formatSetupDiagnostics,
  parseSetupConfig,
  POST_EDIT_COMMAND_MAX_CHARS,
  saveSetupConfig,
  SETUP_CONFIG_PATH,
  updateSetupConfig,
} = await import("../../../extensions/shared/setup-config.ts");

const setupConfigModuleUrl = new URL(
  "../../../extensions/shared/setup-config.ts",
  import.meta.url,
).href;
const setupConfigLockPath = `${SETUP_CONFIG_PATH}.lock`;

const removeLockArtifacts = () => {
  const prefix = `${basename(SETUP_CONFIG_PATH)}.lock`;
  for (const name of readdirSync(agentDir)) {
    if (name.startsWith(prefix)) {
      rmSync(join(agentDir, name), { recursive: true, force: true });
    }
  }
};

async function runSetupConfigChildScenario({
  source,
  tempPrefix,
  env = {},
  failureLabel,
}: {
  source: string;
  tempPrefix: string;
  env?: NodeJS.ProcessEnv;
  failureLabel: string;
}) {
  const scenarioAgentDir = mkdtempSync(join(tmpdir(), tempPrefix));
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: scenarioAgentDir,
        SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      rmSync(scenarioAgentDir, { recursive: true, force: true });
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => {
      finish(new Error(`${failureLabel} failed to spawn`, { cause: error }));
    });
    child.once("exit", (code) => {
      if (code === 0 && stdout === "preserved\n") finish();
      else
        finish(
          new Error(`${failureLabel} exited ${code}: ${stderr || stdout}`),
        );
    });
  });
}

test("Code Mode defaults on for old documents and preserves an explicit opt-out", () => {
  assert.equal(DEFAULT_SETUP_CONFIG.codeMode.enabled, true);
  assert.equal(parseSetupConfig({ configVersion: 1 }).codeMode.enabled, true);
  const config = parseSetupConfig({ codeMode: { enabled: false } });
  assert.equal(config.codeMode.enabled, false);
  assert.match(formatSetupConfig(config), /Code Mode default: off/);
});

test("capability discovery defaults to explicit and accepts adaptive opt-in", () => {
  assert.equal(DEFAULT_SETUP_CONFIG.capabilities.discovery, "explicit");
  assert.equal(
    parseSetupConfig({ capabilities: { discovery: "adaptive" } }).capabilities
      .discovery,
    "adaptive",
  );
  assert.equal(
    parseSetupConfig({ capabilities: { discovery: "unexpected" } }).capabilities
      .discovery,
    "explicit",
  );
  assert.match(
    formatSetupConfig(DEFAULT_SETUP_CONFIG),
    /Capability discovery: explicit/,
  );
});

test("response preferences preserve native defaults and bounded Web thinking filters are canonical", async () => {
  assert.deepEqual(parseSetupConfig({}).response, {
    verbosity: "default",
    reasoningSummary: "default",
  });
  assert.deepEqual(parseSetupConfig({}).ui.webHiddenThinkingLevels, []);
  assert.deepEqual(
    parseSetupConfig({
      response: { verbosity: "invalid", reasoningSummary: "off" },
      ui: { webHiddenThinkingLevels: ["high", "high"] },
    }).response,
    DEFAULT_SETUP_CONFIG.response,
  );
  assert.deepEqual(
    parseSetupConfig({ ui: { webHiddenThinkingLevels: ["unknown"] } }).ui
      .webHiddenThinkingLevels,
    [],
  );
  const before = JSON.stringify({
    configVersion: 1,
    response: {
      verbosity: "medium",
      reasoningSummary: "concise",
      futurePreference: true,
    },
    ui: { webHiddenThinkingLevels: ["minimal"] },
  });
  writeFileSync(SETUP_CONFIG_PATH, before);
  await updateSetupConfig((config) => ({
    ...config,
    response: { ...config.response, verbosity: "high" },
    ui: { ...config.ui, webHiddenThinkingLevels: [] },
  }));
  const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal(saved.response.futurePreference, true);
  assert.deepEqual(loadSetupConfig().response, {
    verbosity: "high",
    reasoningSummary: "concise",
  });
  assert.deepEqual(loadSetupConfig().ui.webHiddenThinkingLevels, []);
  assert.match(
    formatSetupConfig(loadSetupConfig()),
    /verbosity high.*reasoning summary concise/,
  );
  assert.match(
    formatSetupConfig(loadSetupConfig()),
    /Hidden Web thinking levels: none/,
  );
  const canonical = readFileSync(SETUP_CONFIG_PATH, "utf8");
  const controller = new AbortController();
  await assert.rejects(
    updateSetupConfig(
      (config) => ({
        ...config,
        response: { verbosity: "low", reasoningSummary: "none" },
      }),
      async () => controller.abort(),
      controller.signal,
    ),
    /restored/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), canonical);
  for (const invalid of [
    { response: { verbosity: "verbose" } },
    { response: { reasoningSummary: "off" } },
    { ui: { webHiddenThinkingLevels: ["max", "max"] } },
    { ui: { webHiddenThinkingLevels: ["unsupported"] } },
  ]) {
    const raw = JSON.stringify({ configVersion: 1, ...invalid });
    writeFileSync(SETUP_CONFIG_PATH, raw);
    assert.equal(inspectSetupConfig().writable, false);
    await assert.rejects(
      updateSetupConfig((config) => config),
      /Refusing to overwrite/,
    );
    assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
  }
  rmSync(SETUP_CONFIG_PATH, { force: true });
});

test("FAIL: session child execution admission is opt-in and bounded", () => {
  assert.equal(DEFAULT_SETUP_CONFIG.childExecutions.maxActive, undefined);
  assert.equal(
    parseSetupConfig({ childExecutions: { maxActive: 3 } }).childExecutions
      .maxActive,
    3,
  );
  assert.equal(
    parseSetupConfig({ childExecutions: { maxActive: 0 } }).childExecutions
      .maxActive,
    undefined,
  );
  assert.equal(
    parseSetupConfig({ childExecutions: { maxActive: 65 } }).childExecutions
      .maxActive,
    undefined,
  );
  assert.match(
    formatSetupConfig(parseSetupConfig({ childExecutions: { maxActive: 3 } })),
    /Session child executions: 3 active slots/,
  );
  assert.match(
    formatSetupConfig(DEFAULT_SETUP_CONFIG),
    /Session child executions: unbounded \(disabled\)/,
  );
});

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const expireLock = (path: string) => {
  const expired = new Date(Date.now() - 6_000);
  utimesSync(path, expired, expired);
};

test("every one-line footer preset keeps model context left and cwd right", () => {
  for (const preset of Object.values(FOOTER_PRESET_DEFINITIONS)) {
    assert.deepEqual(preset.lines, [
      ["model", "context", "flex", "git", "pr", "cwd"],
    ]);
  }
});

test("the previous canonical footer default migrates without rewriting custom layouts", () => {
  const migrated = parseSetupConfig({
    ui: {
      footerLines: [["cwd", "git", "pr", "flex", "model", "context"]],
    },
  });
  assert.deepEqual(migrated.ui.footerLines, [
    ["model", "context", "flex", "git", "pr", "cwd"],
  ]);

  const custom = parseSetupConfig({
    ui: {
      footerLines: [["cwd", "flex", "model", "context", "git", "pr"]],
    },
  });
  assert.deepEqual(custom.ui.footerLines, [
    ["cwd", "flex", "model", "context", "git", "pr"],
  ]);
});

test("an unreadable config blocks the write and survives untouched", async () => {
  const corrupt = '{ "summaries": { "enabled": false }, oops\n';
  writeFileSync(SETUP_CONFIG_PATH, corrupt);

  // The loader still degrades to defaults so rendering paths never throw.
  assert.deepEqual(loadSetupConfig(), DEFAULT_SETUP_CONFIG);

  await assert.rejects(
    saveSetupConfig(DEFAULT_SETUP_CONFIG),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(SETUP_CONFIG_PATH) &&
      error.message.includes("delete it"),
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), corrupt);
});

test("a readable or absent config saves normally", async () => {
  const config = {
    ...DEFAULT_SETUP_CONFIG,
    suggestions: { ...DEFAULT_SETUP_CONFIG.suggestions, enabled: false },
  };

  writeFileSync(SETUP_CONFIG_PATH, "{}\n");
  await saveSetupConfig(config);
  assert.deepEqual(loadSetupConfig(), config);

  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  assert.deepEqual(loadSetupConfig(), DEFAULT_SETUP_CONFIG);
});

test("legacy footerItems migrates and writes back canonical footerLines idempotently", async () => {
  const legacyDocument = JSON.stringify({
    ui: {
      footerStyle: "powerline",
      footerItems: ["model", "context", "cache", "git"],
    },
  });
  writeFileSync(SETUP_CONFIG_PATH, legacyDocument);

  const migrated = loadSetupConfig();
  const repeated = loadSetupConfig();
  assert.deepEqual(repeated, migrated);
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), legacyDocument);
  assert.equal("footerItems" in migrated.ui, false);
  assert.equal(migrated.ui.footerStyle, "powerline");
  assert.deepEqual(migrated.ui.footerLines, [
    ["model", "context", "cache", "flex", "git"],
  ]);

  await saveSetupConfig(migrated);
  const firstWrite = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal("footerItems" in firstWrite.ui, false);
  assert.deepEqual(firstWrite.ui.footerLines, migrated.ui.footerLines);

  await saveSetupConfig(loadSetupConfig());
  const secondWrite = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.deepEqual(secondWrite, firstWrite);
});

test("save and update strip runtime footerItems extras at the writer boundary", async () => {
  const withLegacyExtra = {
    ...DEFAULT_SETUP_CONFIG,
    ui: {
      ...DEFAULT_SETUP_CONFIG.ui,
      footerItems: ["cache"] as const,
    },
  };

  await saveSetupConfig(withLegacyExtra);
  const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal("footerItems" in saved.ui, false);

  const { config } = await updateSetupConfig((current) => ({
    ...current,
    ui: { ...current.ui, footerItems: ["cost"] as const },
  }));
  const updated = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal("footerItems" in config.ui, false);
  assert.equal("footerItems" in updated.ui, false);
});

test("an update patches the document as it is on disk, not as it was read", async () => {
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);

  // Another session changes a different field after this one loaded.
  const stale = loadSetupConfig();
  await saveSetupConfig({
    ...stale,
    workflows: { ...stale.workflows, concurrency: 17 },
  });

  const { config, replaced } = await updateSetupConfig((current) => ({
    ...current,
    suggestions: { ...current.suggestions, enabled: false },
  }));
  assert.equal(config.workflows.concurrency, 17);
  assert.equal(config.suggestions.enabled, false);
  assert.deepEqual(replaced, []);
});

test("concurrent Pi processes preserve every read-modify-write update", async () => {
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const source = `
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
process.stdout.write("ready\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
const update = Number(process.env.SETUP_CONFIG_UPDATE);
await updateSetupConfig((current) => {
  switch (update) {
    case 0: return { ...current, workflows: { ...current.workflows, concurrency: 17 } };
    case 1: return { ...current, workflows: { ...current.workflows, maxAgentCalls: 777 } };
    case 2: return { ...current, ui: { ...current.ui, showHeader: true } };
    case 3: return { ...current, ui: { ...current.ui, customFooter: false } };
    case 4: return { ...current, ui: { ...current.ui, bashToolDisplay: "full" } };
    case 5: return { ...current, postEdit: { command: "npm run check" } };
    case 6: return { ...current, subagents: { roleModels: { ...current.subagents.roleModels, explorer: { provider: "test", model: "explorer" } } } };
    case 7: return { ...current, subagents: { roleModels: { ...current.subagents.roleModels, reviewer: { provider: "test", model: "reviewer" } } } };
    default: throw new Error("unknown update");
  }
});
`;

  const children = Array.from({ length: 8 }, (_, update) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
          SETUP_CONFIG_UPDATE: String(update),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onData = () => {
        if (!stdout.includes("ready\n")) return;
        child.stdout.off("data", onData);
        resolve();
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!stdout.includes("ready\n")) {
          reject(new Error(`updater ${update} exited ${code}: ${stderr}`));
        }
      });
    });
    const completed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`updater ${update} exited ${code}: ${stderr}`));
      });
    });
    return { child, ready, completed };
  });

  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.stdin.end("update\n");
  await Promise.all(children.map(({ completed }) => completed));

  const config = loadSetupConfig();
  assert.equal(config.workflows.concurrency, 17);
  assert.equal(config.workflows.maxAgentCalls, 777);
  assert.equal(config.ui.showHeader, true);
  assert.equal(config.ui.customFooter, false);
  assert.equal(config.ui.bashToolDisplay, "full");
  assert.equal(config.postEdit.command, "npm run check");
  assert.deepEqual(config.subagents.roleModels.explorer, {
    provider: "test",
    model: "explorer",
  });
  assert.deepEqual(config.subagents.roleModels.reviewer, {
    provider: "test",
    model: "reviewer",
  });
});

test("a killed setup writer is recovered from its last heartbeat", {
  timeout: 15_000,
}, async () => {
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const source = `
const { writeFileSync } = await import("node:fs");
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
await updateSetupConfig((current) => {
  writeFileSync(1, "holding\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return current;
});
`;
  const holder = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  holder.stdout.setEncoding("utf8");
  holder.stderr.setEncoding("utf8");
  let stderr = "";
  holder.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      holder.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("holding\n")) resolve();
      });
      holder.once("error", reject);
      holder.once("exit", (code) =>
        reject(new Error(`lock holder exited ${code}: ${stderr}`)),
      );
    });
    assert.equal(existsSync(setupConfigLockPath), true);
    const frozen = statSync(setupConfigLockPath).mtimeMs;
    const killedAt = Date.now();
    assert.ok(
      killedAt - frozen < 3_000,
      `heartbeat was already stale when the holder was killed (${killedAt - frozen}ms)`,
    );

    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;

    const { config } = await updateSetupConfig((current) => ({
      ...current,
      ui: { ...current.ui, showHeader: true },
    }));
    const recoveredAt = Date.now();
    assert.equal(config.ui.showHeader, true);
    assert.equal(loadSetupConfig().ui.showHeader, true);
    assert.equal(existsSync(setupConfigLockPath), false);
    assert.ok(
      recoveredAt >= frozen + 5_000 - 100,
      `recovered ${recoveredAt - frozen}ms after the last heartbeat`,
    );
    assert.ok(
      recoveredAt - killedAt < 8_000,
      `recovery took ${recoveredAt - killedAt}ms`,
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, "exit");
      holder.kill("SIGKILL");
      await exited;
    }
    removeLockArtifacts();
  }
});

test("a waiting setup writer recovers after the lock owner dies", {
  timeout: 15_000,
}, async () => {
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const holderSource = `
const { writeFileSync } = await import("node:fs");
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
await updateSetupConfig((current) => {
  writeFileSync(1, "holding\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return current;
});
`;
  const waiterSource = `
const fs = await import("node:fs");
const { syncBuiltinESMExports } = await import("node:module");
const originalWatch = fs.default.watch;
fs.default.watch = (...args) => {
  const watcher = originalWatch(...args);
  process.stdout.write("watching\\n");
  return watcher;
};
syncBuiltinESMExports();
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
const started = Date.now();
await updateSetupConfig((current) => current);
process.stdout.write(JSON.stringify({ result: "success", ms: Date.now() - started }) + "\\n");
`;
  const start = (source: string) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Subscribe at spawn time: recovery can finish before the holder's exit
    // is observed, so a later once(waiter, "exit") could miss it entirely.
    const exited = once(child, "exit");
    void exited.catch(() => {});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const waitFor = (marker: string) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!stdout.includes(marker)) return;
          child.stdout.off("data", check);
          resolve();
        };
        check();
        child.stdout.on("data", check);
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!stdout.includes(marker))
            reject(
              new Error("child exited " + code + ": " + (stderr || stdout)),
            );
        });
      });
    return { child, exited, waitFor, output: () => ({ stdout, stderr }) };
  };

  const holder = start(holderSource);
  let waiter: ReturnType<typeof start> | undefined;
  try {
    await holder.waitFor("holding\n");
    waiter = start(waiterSource);
    await waiter.waitFor("watching\n");
    const frozen = statSync(setupConfigLockPath).mtimeMs;
    const killedAt = Date.now();
    assert.ok(killedAt - frozen < 3_000);
    holder.child.kill("SIGKILL");
    await holder.exited;

    await waiter.exited;
    const recoveredAt = Date.now();
    const { stdout, stderr } = waiter.output();
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.split("\n").at(-2) ?? "");
    assert.equal(result.result, "success");
    assert.ok(
      recoveredAt >= frozen + 5_000 - 100,
      `waiter recovered ${recoveredAt - frozen}ms after the last heartbeat`,
    );
    assert.ok(
      result.ms < 12_000,
      "waiter exceeded the lease cap: " + result.ms,
    );
    assert.equal(existsSync(setupConfigLockPath), false);
  } finally {
    for (const process of [holder, waiter]) {
      if (!process) continue;
      const { child } = process;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await process.exited;
      }
    }
    removeLockArtifacts();
  }
});

test("a stale setup lock is recovered even when its recorded pid is alive", async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const owner = {
    version: 2,
    pid: process.pid,
    createdAt: Date.now(),
    token: "33333333-3333-4333-8333-333333333333",
  };
  const metadata = `${JSON.stringify(owner)}\n`;
  const claimPath = `${setupConfigLockPath}.owner.${owner.pid}.${owner.token}`;
  writeFileSync(claimPath, metadata);
  linkSync(claimPath, setupConfigLockPath);
  expireLock(setupConfigLockPath);

  try {
    const started = Date.now();
    const { config } = await updateSetupConfig((current) => ({
      ...current,
      ui: { ...current.ui, showHeader: true },
    }));
    assert.equal(config.ui.showHeader, true);
    assert.equal(loadSetupConfig().ui.showHeader, true);
    assert.ok(
      Date.now() - started < 2_000,
      "stale recovery waited out a live pid",
    );
    assert.equal(existsSync(setupConfigLockPath), false);
  } finally {
    removeLockArtifacts();
  }
});

test("a fresh setup lock is kept until its timestamp is past the deadline", async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const dead = spawn(process.execPath, ["--eval", ""]);
  const deadPid = dead.pid;
  await once(dead, "exit");
  assert.equal(typeof deadPid, "number");
  const owner = {
    version: 2,
    pid: deadPid,
    createdAt: Date.now(),
    token: "55555555-5555-4555-8555-555555555555",
  };
  const metadata = `${JSON.stringify(owner)}\n`;
  const claimPath = `${setupConfigLockPath}.owner.${owner.pid}.${owner.token}`;
  writeFileSync(claimPath, metadata);
  linkSync(claimPath, setupConfigLockPath);

  let settled = false;
  const pending = updateSetupConfig((current) => ({
    ...current,
    ui: { ...current.ui, showHeader: true },
  })).then((result) => {
    settled = true;
    return result;
  });
  pending.catch(() => undefined);

  try {
    await delay(1_000);
    assert.equal(settled, false);
    assert.equal(readFileSync(setupConfigLockPath, "utf8"), metadata);
    expireLock(setupConfigLockPath);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("stale lock was not recovered")),
          3_000,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(settled, true);
    assert.equal(result.config.ui.showHeader, true);
    assert.equal(existsSync(setupConfigLockPath), false);
  } finally {
    removeLockArtifacts();
    await pending.catch(() => undefined);
  }
});

test("a legacy setup lock is protected while fresh and recovered once stale", async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const owner = {
    version: 1,
    pid: process.pid,
    processStartedAt: 1,
    processStartedAtVerified: true,
    createdAt: Date.now(),
    token: "66666666-6666-4666-8666-666666666666",
  };
  const metadata = `${JSON.stringify(owner)}\n`;
  const claimPath = `${setupConfigLockPath}.owner.${owner.pid}.${owner.processStartedAt}.${owner.token}`;
  writeFileSync(claimPath, metadata);
  linkSync(claimPath, setupConfigLockPath);

  let settled = false;
  const pending = updateSetupConfig((current) => ({
    ...current,
    ui: { ...current.ui, showHeader: true },
  })).then((result) => {
    settled = true;
    return result;
  });
  pending.catch(() => undefined);

  try {
    await delay(1_000);
    assert.equal(settled, false);
    assert.equal(readFileSync(setupConfigLockPath, "utf8"), metadata);
    expireLock(setupConfigLockPath);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("stale legacy lock was not recovered")),
          3_000,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(settled, true);
    assert.equal(result.config.ui.showHeader, true);
  } finally {
    removeLockArtifacts();
    await pending.catch(() => undefined);
  }
});

test("a stale legacy recovery claim is taken over even if its pid is alive", async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const owner = {
    version: 1,
    pid: process.pid,
    processStartedAt: 1,
    processStartedAtVerified: true,
    createdAt: Date.now(),
    token: "77777777-7777-4777-8777-777777777777",
  };
  const metadata = `${JSON.stringify(owner)}\n`;
  const claimPath = `${setupConfigLockPath}.owner.${owner.pid}.${owner.processStartedAt}.${owner.token}`;
  const recoveryPath = `${claimPath}.recovering.${process.pid}.1.1.88888888-8888-4888-8888-888888888888`;
  writeFileSync(claimPath, metadata);
  linkSync(claimPath, setupConfigLockPath);
  renameSync(claimPath, recoveryPath);
  expireLock(setupConfigLockPath);

  try {
    const started = Date.now();
    const { config } = await updateSetupConfig((current) => ({
      ...current,
      ui: { ...current.ui, showHeader: true },
    }));
    assert.equal(config.ui.showHeader, true);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(existsSync(setupConfigLockPath), false);
    assert.equal(existsSync(recoveryPath), false);
  } finally {
    removeLockArtifacts();
  }
});

test("a live holder keeps the setup lock across a blocked main thread", {
  timeout: 20_000,
}, async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const source = `
const { writeFileSync } = await import("node:fs");
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
await updateSetupConfig((current) => {
  writeFileSync(1, "holding\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  return { ...current, ui: { ...current.ui, showHeader: true } };
});
writeFileSync(1, "released\\n");
`;
  const holder = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  holder.stdout.setEncoding("utf8");
  holder.stderr.setEncoding("utf8");
  let stderr = "";
  holder.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(holder, "exit");
  void exited.catch(() => {});

  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      holder.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("holding\n")) resolve();
      });
      holder.once("error", reject);
      holder.once("exit", (code) =>
        reject(new Error(`lock holder exited ${code}: ${stderr}`)),
      );
    });
    const before = statSync(setupConfigLockPath).mtimeMs;
    const held = readFileSync(setupConfigLockPath, "utf8");
    await delay(2_200);
    const after = statSync(setupConfigLockPath).mtimeMs;
    assert.ok(
      after >= before + 500,
      `lock timestamp did not refresh during a blocked hold (${after - before}ms)`,
    );

    const waiterStarted = Date.now();
    await assert.rejects(
      updateSetupConfig((current) => ({
        ...current,
        ui: { ...current.ui, customFooter: false },
      })),
      /Timed out waiting/,
    );
    const waiterMs = Date.now() - waiterStarted;
    assert.ok(waiterMs < 9_000, `live lock wait took ${waiterMs}ms`);
    assert.equal(readFileSync(setupConfigLockPath, "utf8"), held);
    assert.equal(loadSetupConfig().ui.customFooter, true);
    assert.equal(holder.exitCode, null);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await exited;
    }
    removeLockArtifacts();
  }
});

test("unreadable, mismatched, and newer setup locks are never stolen", async () => {
  const source = `
const { existsSync, linkSync, readFileSync, rmSync, utimesSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const scenario = process.env.SETUP_LOCK_SCENARIO;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const lockPath = join(agentDir, "my-pi-setup.json.lock");
const expire = () => {
  const expired = new Date(Date.now() - 10_000);
  utimesSync(lockPath, expired, expired);
};
if (scenario === "future") {
  const owner = {
    version: 99,
    pid: process.pid,
    createdAt: Date.now(),
    token: "99999999-9999-4999-8999-999999999999",
  };
  const metadata = JSON.stringify(owner) + "\\n";
  const claimPath = lockPath + ".owner." + owner.pid + "." + owner.token;
  writeFileSync(claimPath, metadata);
  linkSync(claimPath, lockPath);
  expire();
} else if (scenario === "mismatched") {
  const owner = {
    version: 2,
    pid: process.pid,
    createdAt: Date.now(),
    token: "22222222-2222-4222-8222-222222222222",
  };
  const metadata = JSON.stringify(owner) + "\\n";
  const claimPath = lockPath + ".owner." + owner.pid + "." + owner.token;
  writeFileSync(lockPath, metadata);
  writeFileSync(claimPath, metadata);
  expire();
} else {
  writeFileSync(lockPath, "not trustworthy\\n");
  expire();
}
const before = readFileSync(lockPath, "utf8");
const { updateSetupConfig } = await import(process.env.SETUP_CONFIG_MODULE_URL);
let mutated = false;
try {
  await updateSetupConfig((current) => {
    mutated = true;
    return current;
  });
  throw new Error("uncertain lock was stolen");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("Timed out waiting")) throw error;
}
if (mutated) throw new Error("mutator ran under uncertain ownership");
if (!existsSync(lockPath) || readFileSync(lockPath, "utf8") !== before) {
  throw new Error("uncertain lock changed");
}
rmSync(agentDir, { recursive: true, force: true });
process.stdout.write("preserved\\n");
`;

  const runs = ["unknown", "mismatched", "future"].map((scenario) => {
    return runSetupConfigChildScenario({
      source,
      tempPrefix: `my-pi-setup-${scenario}-lock-`,
      env: { SETUP_LOCK_SCENARIO: scenario },
      failureLabel: `${scenario} owner check`,
    });
  });

  await Promise.all(runs);
});

test("a stored value that had to be normalized is reported, not hidden", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ workflows: { concurrency: "12" }, ui: { showHeader: 3 } }),
  );

  const before = readFileSync(SETUP_CONFIG_PATH, "utf8");
  await assert.rejects(
    updateSetupConfig((current) => current),
    /workflows.concurrency/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), before);
});

test("legacy footerItems migration remains visible in update reports", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({
      ui: {
        footerItems: ["model", "context", "cache", "git"],
      },
    }),
  );

  const { replaced } = await updateSetupConfig((current) => current);
  assert.deepEqual(replaced, ["ui.footerItems"]);
});

test("legacy model-free recaps are explicitly migrated to disabled suggestions", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ summaries: { enabled: true } }),
  );

  const { config, replaced } = await updateSetupConfig((current) => current);

  assert.deepEqual(config.suggestions, { enabled: false });
  assert.deepEqual(replaced, ["summaries → suggestions"]);
  const stored = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal("summaries" in stored, false);
  assert.deepEqual(stored.suggestions, { enabled: false });
});

test("the post-edit command is off by default, trimmed, and fails closed when oversized", () => {
  // Off by default: nothing executes until the user configures a command.
  assert.equal(DEFAULT_SETUP_CONFIG.postEdit.command, "");

  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: "  npm run format  " } }),
  );
  assert.equal(loadSetupConfig().postEdit.command, "npm run format");

  // A malformed block degrades to off rather than to something executable.
  writeFileSync(SETUP_CONFIG_PATH, JSON.stringify({ postEdit: 42 }));
  assert.equal(loadSetupConfig().postEdit.command, "");

  const maximumLengthCommand = "x".repeat(POST_EDIT_COMMAND_MAX_CHARS);
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: maximumLengthCommand } }),
  );
  assert.equal(loadSetupConfig().postEdit.command, maximumLengthCommand);

  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({
      postEdit: { command: "x".repeat(POST_EDIT_COMMAND_MAX_CHARS + 1) },
    }),
  );
  assert.equal(loadSetupConfig().postEdit.command, "");
});

test("an oversized stored post-edit command is rejected and reported", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: "x".repeat(900) } }),
  );

  const before = readFileSync(SETUP_CONFIG_PATH, "utf8");
  await assert.rejects(
    updateSetupConfig((current) => current),
    /postEdit.command/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), before);
});

test("setup status reports post-edit configuration without exposing the command", () => {
  const command = "PRIVATE_TOKEN=secret npm run format";
  const status = formatSetupConfig(parseSetupConfig({ postEdit: { command } }));

  assert.match(status, /Post-edit command: configured/);
  assert.doesNotMatch(status, new RegExp(command));
});

test("missing config is side-effect-free while unsupported and invalid documents block writes", async () => {
  rmSync(SETUP_CONFIG_PATH, { force: true });
  assert.deepEqual(inspectSetupConfig().diagnostics, []);
  assert.equal(inspectSetupConfig().source, "missing");
  assert.equal(existsSync(SETUP_CONFIG_PATH), false);
  for (const raw of [
    "{broken",
    "null",
    "[]",
    '{"configVersion":99}',
    '{"ui":{"showHeader":3}}',
    '{"suggestions":{"model":{}}}',
  ]) {
    writeFileSync(SETUP_CONFIG_PATH, raw);
    assert.equal(inspectSetupConfig().writable, false);
    await assert.rejects(
      updateSetupConfig((config) => config),
      /Refusing to overwrite/,
    );
    assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
  }
});

test("explicit saves version legacy documents and preserve nested unknown fields without exposing values", async () => {
  const raw = JSON.stringify({
    future: { token: "PRIVATE_VALUE" },
    ui: { future: [1, 2] },
    subagents: { roleModels: { futureRole: { model: "secret" } } },
  });
  writeFileSync(SETUP_CONFIG_PATH, raw);
  assert.equal(inspectSetupConfig().writable, true);
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
  assert.doesNotMatch(formatSetupDiagnostics(), /PRIVATE_VALUE|secret/);
  await updateSetupConfig((config) => ({
    ...config,
    ui: { ...config.ui, showHeader: true },
  }));
  const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal(saved.configVersion, 1);
  assert.deepEqual(saved.future, { token: "PRIVATE_VALUE" });
  assert.deepEqual(saved.ui.future, [1, 2]);
  assert.deepEqual(saved.subagents.roleModels.futureRole, { model: "secret" });
  assert.equal(saved.ui.showHeader, true);
});

test("an invalid stored footer style is diagnosed with its legal range and never normalized on save", async () => {
  const raw = '{"configVersion":1,"ui":{"footerStyle":"compact"}}';
  writeFileSync(SETUP_CONFIG_PATH, raw);
  const status = formatSetupDiagnostics();
  assert.match(status, /ui.footerStyle/);
  assert.match(status, /Allowed values: plain, powerline, powerline-mono/);
  assert.equal(inspectSetupConfig().writable, false);
  await assert.rejects(
    updateSetupConfig((config) => config),
    /Refusing to overwrite/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
});

test("complete Web appearance defaults and color/font choices round-trip without changing the legacy theme", async () => {
  assert.deepEqual(parseSetupConfig({}).ui.webAppearance, {
    palette: "default",
    accent: "",
    background: "",
    foreground: "",
    font: "codex",
  });
  assert.match(
    formatSetupConfig(parseSetupConfig({})),
    /palette default · accent theme default \/ background theme default \/ foreground theme default · font codex/u,
  );
  for (const webTheme of ["system", "light", "dark", "mist", "rose", "pine"]) {
    const original = JSON.stringify({
      configVersion: 1,
      ui: { webTheme },
      future: { retained: true },
    });
    writeFileSync(SETUP_CONFIG_PATH, original);
    const appearance = {
      palette: "rose" as const,
      accent: "#aBc123",
      background: "#FFFFFF",
      foreground: "",
      font: "serif" as const,
    };
    const receipt = await updateSetupConfig((config) => ({
      ...config,
      ui: { ...config.ui, webAppearance: appearance },
    }));
    assert.deepEqual(receipt.config.ui.webAppearance, appearance);
    assert.equal(receipt.config.ui.webTheme, webTheme);
    assert.deepEqual(loadSetupConfig().ui.webAppearance, appearance);
    assert.equal(inspectSetupConfig().writable, true);
    assert.deepEqual(
      JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8")).future,
      { retained: true },
    );
    const saved = readFileSync(SETUP_CONFIG_PATH, "utf8");
    await assert.rejects(
      updateSetupConfig(
        (config) => ({
          ...config,
          ui: { ...config.ui, webAppearance: DEFAULT_WEB_APPEARANCE },
        }),
        async (config) => {
          if (config.ui.webAppearance.palette === "default")
            throw new Error("Consumer failed");
        },
      ),
      /previous file and configuration restored/u,
    );
    assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), saved);
  }
});

test("legacy system fonts resolve to Codex without rewriting preferences on read", async () => {
  const appearance = {
    ...DEFAULT_WEB_APPEARANCE,
    palette: "rose" as const,
    accent: "#123456",
    font: "system" as const,
  };
  const raw = JSON.stringify({
    configVersion: 1,
    ui: { webAppearance: appearance },
  });
  writeFileSync(SETUP_CONFIG_PATH, raw);
  assert.equal(inspectSetupConfig().writable, true);
  assert.deepEqual(loadSetupConfig().ui.webAppearance, {
    ...appearance,
    font: "codex",
  });
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
  for (const font of ["codex", "sans", "serif", "mono"] as const) {
    const receipt = await updateSetupConfig((config) => ({
      ...config,
      ui: { ...config.ui, webAppearance: { ...appearance, font } },
    }));
    assert.equal(receipt.config.ui.webAppearance.font, font);
    assert.equal(loadSetupConfig().ui.webAppearance.font, font);
  }
});

test("Web appearance fields accept canonical bounds and remain known on explicit saves", async () => {
  for (const configVersion of [undefined, 1]) {
    for (const ui of [
      { webChatWidth: 820, webChatFontSize: 12, webExpandThinking: false },
      { webChatWidth: 960, webChatFontSize: 16, webExpandThinking: true },
      { webChatWidth: 2000, webChatFontSize: 24, webExpandThinking: true },
      { webSidebarWidth: 220, webAuxiliaryWidth: 360 },
      { webSidebarWidth: 520, webAuxiliaryWidth: 720 },
      {
        webSidebarGrouping: "project",
        webChatsSort: "updated",
        webProjectsInRecents: true,
      },
      {
        webSidebarGrouping: "list",
        webChatsSort: "manual",
        webProjectsInRecents: false,
      },
    ]) {
      const raw = JSON.stringify({ configVersion, ui });
      writeFileSync(SETUP_CONFIG_PATH, raw);
      const inspected = inspectSetupConfig();
      assert.equal(inspected.writable, true);
      assert.deepEqual(
        inspected.diagnostics.filter((item) => item.path.startsWith("ui.")),
        [],
      );
      for (const [key, value] of Object.entries(ui))
        assert.equal(Reflect.get(inspected.config.ui, key), value);
      assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
      await updateSetupConfig((config) => ({
        ...config,
        ui: { ...config.ui, showHeader: true },
      }));
      const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
      assert.equal(saved.configVersion, 1);
      for (const [key, value] of Object.entries(ui))
        assert.equal(saved.ui[key], value);
    }
  }
});

test("invalid Web appearance values are diagnosed and block both stored and candidate writes", async () => {
  const invalidValues = {
    webAppearance: [
      null,
      [],
      "default",
      {},
      { ...DEFAULT_WEB_APPEARANCE, palette: "unknown" },
      { ...DEFAULT_WEB_APPEARANCE, font: "unknown" },
      { ...DEFAULT_WEB_APPEARANCE, accent: "#123" },
      { ...DEFAULT_WEB_APPEARANCE, background: "rgb(0,0,0)" },
      { ...DEFAULT_WEB_APPEARANCE, foreground: "#12345678" },
      { ...DEFAULT_WEB_APPEARANCE, accent: "#zzzzzz" },
      { ...DEFAULT_WEB_APPEARANCE, background: " #123456" },
      { ...DEFAULT_WEB_APPEARANCE, foreground: 0 },
      { ...DEFAULT_WEB_APPEARANCE, font: undefined },
      { ...DEFAULT_WEB_APPEARANCE, unknown: true },
    ],
    webChatWidth: [819, 2001, 960.5, "960", null, true, {}, []],
    webChatFontSize: [11, 25, 16.5, "16", null, false, {}, []],
    webSidebarWidth: [219, 521, 320.5, "320", null, false],
    webAuxiliaryWidth: [359, 721, 520.5, "520", null, false],
    webExpandThinking: [0, 1, "true", null, {}, []],
    webSidebarGrouping: ["connection", "unknown", false, null, {}, []],
    webChatsSort: ["updated_at", "unknown", false, null, {}, []],
    webProjectsInRecents: [0, 1, "true", null, {}, []],
  };
  for (const [key, values] of Object.entries(invalidValues)) {
    for (const value of values) {
      const ui = { [key]: value };
      for (const configVersion of [undefined, 1]) {
        const raw = JSON.stringify({ configVersion, ui });
        writeFileSync(SETUP_CONFIG_PATH, raw);
        const inspected = inspectSetupConfig();
        assert.equal(
          inspected.writable,
          false,
          `${key}=${JSON.stringify(value)}`,
        );
        assert.ok(
          inspected.diagnostics.some(
            (item) => item.path === `ui.${key}` && item.severity === "error",
          ),
        );
        await assert.rejects(
          updateSetupConfig((config) => config),
          /Refusing to overwrite/,
        );
        assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
      }
      const raw = JSON.stringify({
        configVersion: 1,
        ui: { webChatWidth: 960 },
      });
      writeFileSync(SETUP_CONFIG_PATH, raw);
      let applied = false;
      await assert.rejects(
        updateSetupConfig(
          (config) => ({ ...config, ui: { ...config.ui, ...ui } }),
          async () => {
            applied = true;
          },
        ),
        new RegExp(`Invalid configuration fields: ui\\.${key}`),
      );
      assert.equal(applied, false);
      assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
    }
  }
});

test("Web appearance changes persist instead of restoring old unknown values and survive rollback", async () => {
  const raw = JSON.stringify({
    configVersion: 1,
    future: { retained: true },
    ui: {
      webTheme: "pine",
      webChatWidth: 960,
      webChatFontSize: 16,
      webExpandThinking: true,
      future: ["preserve"],
    },
  });
  writeFileSync(SETUP_CONFIG_PATH, raw);
  const patch = (config: typeof DEFAULT_SETUP_CONFIG) => ({
    ...config,
    ui: {
      ...config.ui,
      webChatWidth: 1200,
      webChatFontSize: 18,
      webExpandThinking: false,
    },
  });
  const receipt = await updateSetupConfig(patch);
  const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal(saved.ui.webChatWidth, 1200);
  assert.equal(saved.ui.webChatFontSize, 18);
  assert.equal(saved.ui.webExpandThinking, false);
  assert.equal(saved.ui.webTheme, "pine");
  assert.deepEqual(saved.future, { retained: true });
  assert.deepEqual(saved.ui.future, ["preserve"]);
  assert.equal(receipt.config.ui.webChatWidth, saved.ui.webChatWidth);
  assert.deepEqual(receipt.changed.sort(), [
    "ui.webChatFontSize",
    "ui.webChatWidth",
    "ui.webExpandThinking",
  ]);
  writeFileSync(SETUP_CONFIG_PATH, raw);
  const applied: number[] = [];
  await assert.rejects(
    updateSetupConfig(patch, async (config) => {
      applied.push(config.ui.webChatWidth);
      if (config.ui.webChatWidth === 1200) throw new Error("Consumer failed");
    }),
    /previous file and configuration restored/,
  );
  assert.deepEqual(applied, [1200, 960]);
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
});

test("apply failure restores exact file bytes and runtime configuration", async () => {
  const raw = '{ "ui": { "showHeader": false }, "future": true }\n';
  writeFileSync(SETUP_CONFIG_PATH, raw);
  let runtimeHeader = false;
  await assert.rejects(
    updateSetupConfig(
      (config) => ({ ...config, ui: { ...config.ui, showHeader: true } }),
      async (config) => {
        runtimeHeader = config.ui.showHeader;
        if (runtimeHeader) throw new Error("UI failed after partial apply");
      },
    ),
    /previous file and configuration restored/,
  );
  assert.equal(runtimeHeader, false);
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
});

test("first-save failure restores absence and rollback never overwrites an external replacement", async () => {
  rmSync(SETUP_CONFIG_PATH, { force: true });
  let calls = 0;
  await assert.rejects(
    updateSetupConfig(
      (config) => config,
      async () => {
        if (++calls === 1) throw new Error("apply failure");
      },
    ),
    /restored/,
  );
  assert.equal(existsSync(SETUP_CONFIG_PATH), false);
  writeFileSync(SETUP_CONFIG_PATH, "{}");
  const external = '{"ui":{"showHeader":true}}';
  await assert.rejects(
    updateSetupConfig(
      (config) => config,
      async () => {
        writeFileSync(SETUP_CONFIG_PATH, external);
        throw new Error("apply failure");
      },
    ),
    /recovery incomplete/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), external);
});

test("cancellation after apply restores configuration and rollback failure is explicit", async () => {
  writeFileSync(SETUP_CONFIG_PATH, "{}");
  const controller = new AbortController();
  await assert.rejects(
    updateSetupConfig(
      (config) => config,
      async () => {
        controller.abort();
      },
      controller.signal,
    ),
    /restored/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), "{}");
  await assert.rejects(
    updateSetupConfig(
      (config) => config,
      async () => {
        throw new Error("consumer permanently unavailable");
      },
    ),
    /recovery incomplete/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), "{}");
});

test("IO errors remain visible and unknown model fields cannot disappear on role removal", async () => {
  rmSync(SETUP_CONFIG_PATH, { force: true });
  mkdirSync(SETUP_CONFIG_PATH);
  try {
    assert.match(formatSetupDiagnostics(), /Unable to read configuration/);
    await assert.rejects(
      saveSetupConfig(DEFAULT_SETUP_CONFIG),
      /Refusing to overwrite/,
    );
    assert.equal(statSync(SETUP_CONFIG_PATH).isDirectory(), true);
  } finally {
    rmdirSync(SETUP_CONFIG_PATH);
  }
  const raw = JSON.stringify({
    subagents: {
      roleModels: {
        explorer: { provider: "test", model: "test", future: true },
      },
    },
  });
  writeFileSync(SETUP_CONFIG_PATH, raw);
  await assert.rejects(
    updateSetupConfig((config) => ({
      ...config,
      subagents: { roleModels: {} },
    })),
    /would remove unknown fields/,
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
  await updateSetupConfig((config) => config);
  if (process.platform !== "win32")
    assert.equal(statSync(SETUP_CONFIG_PATH).mode & 0o777, 0o600);
});

for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82]]) {
  test(`malformed UTF-8 ${Buffer.from(invalid).toString("hex")} blocks setup writes without losing original bytes`, async () => {
    const original = Buffer.concat([
      Buffer.from('{"configVersion":1,"future":{"note":"'),
      Buffer.from(invalid),
      Buffer.from('"}}\n'),
    ]);
    writeFileSync(SETUP_CONFIG_PATH, original);
    const inspected = inspectSetupConfig();
    let mutations = 0;
    let applies = 0;
    const error = await updateSetupConfig(
      (config) => {
        mutations += 1;
        return { ...config, ui: { ...config.ui, showHeader: true } };
      },
      async () => {
        applies += 1;
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.deepEqual(
      {
        writable: inspected.writable,
        rejected: error instanceof Error,
        mutations,
        applies,
        unchanged: readFileSync(SETUP_CONFIG_PATH).equals(original),
      },
      {
        writable: false,
        rejected: true,
        mutations: 0,
        applies: 0,
        unchanged: true,
      },
    );
  });
}

for (const note of ["ASCII", "中文", "😀", "�"]) {
  test(`valid UTF-8 ${note} survives unrelated setup updates and rollback`, async () => {
    const future = { nested: { note }, list: [note] };
    const original = Buffer.from(
      ` ${JSON.stringify({ configVersion: 1, future })}\n`,
    );
    writeFileSync(SETUP_CONFIG_PATH, original);
    assert.equal(inspectSetupConfig().writable, true);
    await updateSetupConfig((config) => ({
      ...config,
      ui: { ...config.ui, showHeader: true },
    }));
    const saved = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
    assert.deepEqual(saved.future, future);
    assert.equal(saved.ui.showHeader, true);
    writeFileSync(SETUP_CONFIG_PATH, original);
    const applied: boolean[] = [];
    await assert.rejects(
      updateSetupConfig(
        (config) => ({ ...config, ui: { ...config.ui, showHeader: true } }),
        async (config) => {
          applied.push(config.ui.showHeader);
          if (config.ui.showHeader) throw new Error("synthetic apply failure");
        },
      ),
      /previous file and configuration restored/,
    );
    assert.deepEqual(applied, [true, false]);
    assert.deepEqual(readFileSync(SETUP_CONFIG_PATH), original);
  });
}

test("UTF-8 BOM retains the existing malformed JSON rejection", async () => {
  const original = Buffer.from('\ufeff{"configVersion":1}');
  writeFileSync(SETUP_CONFIG_PATH, original);
  assert.equal(inspectSetupConfig().writable, false);
  await assert.rejects(
    updateSetupConfig((config) => config),
    /Refusing to overwrite/,
  );
  assert.deepEqual(readFileSync(SETUP_CONFIG_PATH), original);
});
