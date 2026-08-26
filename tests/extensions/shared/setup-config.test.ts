import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
  SETUP_CONFIG_PATH,
  loadSetupConfig,
  parseSetupConfig,
  saveSetupConfig,
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

test("a reused PID does not impersonate the dead lock owner", async () => {
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
    const scenarioAgentDir = mkdtempSync(
      join(tmpdir(), `my-pi-setup-${scenario}-lock-`),
    );
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", source],
      {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: scenarioAgentDir,
          SETUP_CONFIG_MODULE_URL: setupConfigModuleUrl,
          SETUP_LOCK_SCENARIO: scenario,
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
    return new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        rmSync(scenarioAgentDir, { recursive: true, force: true });
        if (code === 0 && stdout === "preserved\n") resolve();
        else
          reject(
            new Error(
              `${scenario} owner check exited ${code}: ${stderr || stdout}`,
            ),
          );
      });
    });
  });

  await Promise.all(runs);
});

test("a stored value that had to be normalized is reported, not hidden", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ workflows: { concurrency: "12" }, ui: { showHeader: 3 } }),
  );

  const { config, replaced } = await updateSetupConfig((current) => current);
  assert.equal(
    config.workflows.concurrency,
    DEFAULT_SETUP_CONFIG.workflows.concurrency,
  );
  assert.deepEqual(replaced.sort(), ["ui.showHeader", "workflows.concurrency"]);
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

test("the post-edit command is off by default, trimmed, and length-bounded", () => {
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

  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: "x".repeat(900) } }),
  );
  assert.equal(loadSetupConfig().postEdit.command.length, 500);
});
