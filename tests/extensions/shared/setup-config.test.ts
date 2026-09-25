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
  rmSync,
  rmdirSync,
  statSync,
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
  FOOTER_PRESET_DEFINITIONS,
  formatSetupConfig,
  loadSetupConfig,
  inspectSetupConfig,
  formatSetupDiagnostics,
  parseSetupConfig,
  POST_EDIT_COMMAND_MAX_CHARS,
  processStartedAtQuery,
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

test("workspace cleanup guard modes are configurable and default to enforce", () => {
  assert.equal(DEFAULT_SETUP_CONFIG.workspaceCleanupGuard, "enforce");
  for (const mode of ["enforce", "ask", "off"] as const) {
    assert.equal(
      parseSetupConfig({ workspaceCleanupGuard: mode }).workspaceCleanupGuard,
      mode,
    );
  }
  assert.equal(
    parseSetupConfig({ workspaceCleanupGuard: "invalid" })
      .workspaceCleanupGuard,
    "enforce",
  );
  assert.match(
    formatSetupConfig(DEFAULT_SETUP_CONFIG),
    /Workspace cleanup guard: enforce/,
  );
});

test("process start-time queries are platform-specific and conservative", () => {
  const windowsQuery = processStartedAtQuery(123, "win32");
  assert.equal(windowsQuery.command, "powershell.exe");
  assert.deepEqual(windowsQuery.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(windowsQuery.args.at(-1) ?? "", /Get-Process -Id 123/);
  assert.equal(windowsQuery.parseOutput("1700000000000"), 1_700_000_000_000);
  assert.equal(windowsQuery.parseOutput("not a timestamp"), undefined);

  const posixQuery = processStartedAtQuery(123, "linux");
  assert.equal(posixQuery.command, "ps");
  assert.deepEqual(posixQuery.args, ["-o", "lstart=", "-p", "123"]);
  assert.deepEqual(posixQuery.env, { LC_ALL: "C" });
  assert.equal(
    posixQuery.parseOutput("Mon Jan  1 00:00:00 2024\n"),
    Date.parse("Mon Jan  1 00:00:00 2024"),
  );
  assert.equal(posixQuery.parseOutput("not a timestamp"), undefined);
});

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

test("a killed setup writer releases ownership for the next process", async () => {
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

    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;

    const { config } = await updateSetupConfig((current) => ({
      ...current,
      ui: { ...current.ui, showHeader: true },
    }));
    assert.equal(config.ui.showHeader, true);
    assert.equal(loadSetupConfig().ui.showHeader, true);
    assert.equal(existsSync(setupConfigLockPath), false);
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
    return { child, waitFor, output: () => ({ stdout, stderr }) };
  };

  const holder = start(holderSource);
  let waiter: ReturnType<typeof start> | undefined;
  try {
    await holder.waitFor("holding\n");
    waiter = start(waiterSource);
    await waiter.waitFor("watching\n");
    const exited = once(holder.child, "exit");
    holder.child.kill("SIGKILL");
    await exited;

    await once(waiter.child, "exit");
    const { stdout, stderr } = waiter.output();
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.split("\n").at(-2) ?? "");
    assert.equal(result.result, "success");
    assert.ok(
      result.ms < 5_000,
      "waiter used the full deadline: " + result.ms + "ms",
    );
  } finally {
    for (const process of [holder, waiter]) {
      if (!process) continue;
      const { child } = process;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    removeLockArtifacts();
  }
});

test("a reused PID does not impersonate the dead lock owner", async () => {
  removeLockArtifacts();
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  const owner = {
    version: 1,
    pid: process.pid,
    processStartedAt: 1,
    processStartedAtVerified: true,
    createdAt: Date.now(),
    token: "33333333-3333-4333-8333-333333333333",
  };
  const claimPath = `${setupConfigLockPath}.owner.${owner.pid}.${owner.processStartedAt}.${owner.token}`;
  writeFileSync(claimPath, `${JSON.stringify(owner)}\n`);
  linkSync(claimPath, setupConfigLockPath);

  try {
    const { config } = await updateSetupConfig((current) => ({
      ...current,
      ui: { ...current.ui, showHeader: true },
    }));
    assert.equal(config.ui.showHeader, true);
  } finally {
    removeLockArtifacts();
  }
});

test("process start-time query failures do not authorize lock recovery", async () => {
  const source = `
const childProcess = await import("node:child_process");
const { syncBuiltinESMExports } = await import("node:module");
childProcess.default.execFile = (...args) => {
  const callback = args.at(-1);
  if (typeof callback !== "function") {
    throw new Error("expected execFile callback");
  }
  queueMicrotask(() => callback(new Error("mock process start query failure"), ""));
};
syncBuiltinESMExports();

const { existsSync, linkSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const {
  DEFAULT_SETUP_CONFIG,
  SETUP_CONFIG_PATH,
  saveSetupConfig,
  updateSetupConfig,
} = await import(process.env.SETUP_CONFIG_MODULE_URL);

await saveSetupConfig(DEFAULT_SETUP_CONFIG);
const lockPath = SETUP_CONFIG_PATH + ".lock";
const owner = {
  version: 1,
  pid: process.pid,
  processStartedAt: 1,
  processStartedAtVerified: true,
  createdAt: Date.now(),
  token: "44444444-4444-4444-8444-444444444444",
};
const metadata = JSON.stringify(owner) + "\\n";
const claimPath = lockPath + ".owner." + owner.pid + "." + owner.processStartedAt + "." + owner.token;
writeFileSync(claimPath, metadata);
linkSync(claimPath, lockPath);

let mutated = false;
try {
  await updateSetupConfig((current) => {
    mutated = true;
    return { ...current, ui: { ...current.ui, showHeader: true } };
  });
  throw new Error("lock was recovered after an unknown process start-time query");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("Timed out waiting")) throw error;
}
if (mutated) throw new Error("mutator ran under unknown lock ownership");
if (!existsSync(lockPath) || readFileSync(lockPath, "utf8") !== metadata) {
  throw new Error("unknown lock ownership was modified");
}
rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });
process.stdout.write("preserved\\n");
`;

  await runSetupConfigChildScenario({
    source,
    tempPrefix: "my-pi-setup-query-failure-lock-",
    failureLabel: "query failure owner check",
  });
});

test("live and uncertain lock owners are never stolen", async () => {
  const source = `
const { spawn } = await import("node:child_process");
const { once } = await import("node:events");
const { existsSync, linkSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const scenario = process.env.SETUP_LOCK_SCENARIO;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const lockPath = join(agentDir, "my-pi-setup.json.lock");
if (scenario === "live") {
  const owner = {
    version: 1,
    pid: process.pid,
    processStartedAt: Math.max(1, Math.round(Date.now() - process.uptime() * 1000)),
    processStartedAtVerified: false,
    createdAt: Date.now(),
    token: "11111111-1111-4111-8111-111111111111",
  };
  const claimPath = lockPath + ".owner." + owner.pid + "." + owner.processStartedAt + "." + owner.token;
  writeFileSync(claimPath, JSON.stringify(owner) + "\\n");
  linkSync(claimPath, lockPath);
} else if (scenario === "mismatched") {
  const dead = spawn(process.execPath, ["--eval", ""]);
  const deadPid = dead.pid;
  await once(dead, "exit");
  const owner = {
    version: 1,
    pid: deadPid,
    processStartedAt: 1,
    processStartedAtVerified: false,
    createdAt: Date.now(),
    token: "22222222-2222-4222-8222-222222222222",
  };
  const claimPath = lockPath + ".owner." + owner.pid + "." + owner.processStartedAt + "." + owner.token;
  const metadata = JSON.stringify(owner) + "\\n";
  writeFileSync(lockPath, metadata);
  writeFileSync(claimPath, metadata);
} else {
  writeFileSync(lockPath, "not trustworthy\\n");
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

  const runs = ["live", "unknown", "mismatched"].map((scenario) => {
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

test("Web appearance fields accept canonical bounds and remain known on explicit saves", async () => {
  for (const configVersion of [undefined, 1]) {
    for (const ui of [
      { webChatWidth: 820, webChatFontSize: 12, webExpandThinking: false },
      { webChatWidth: 960, webChatFontSize: 16, webExpandThinking: true },
      { webChatWidth: 2000, webChatFontSize: 24, webExpandThinking: true },
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
    webChatWidth: [819, 2001, 960.5, "960", null, true, {}, []],
    webChatFontSize: [11, 25, 16.5, "16", null, false, {}, []],
    webExpandThinking: [0, 1, "true", null, {}, []],
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
