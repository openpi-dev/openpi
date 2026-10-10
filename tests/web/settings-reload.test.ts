import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";

test("native resource changes remain pending until explicit idle, exact-Session reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-resource-reload-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(first), mkdir(second)]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let runtime: PiWebRuntime | undefined;
  t.after(async () => {
    await runtime?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  for (const [source, name] of [
    [first, "fixture_one"],
    [second, "fixture_two"],
  ]) {
    await writeFile(
      join(source!, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(
      join(source!, "index.ts"),
      `export default function(pi) { pi.registerCommand(${JSON.stringify(name)}, { description: "fixture", handler: async () => {} }); }`,
    );
  }
  const settings = SettingsManager.create(cwd, agentDir);
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });
  await manager.installAndPersist(first);
  await settings.flush();
  runtime = await PiWebRuntime.create(cwd);
  const sessionId = runtime.sessionManager.getSessionId();
  const sessionPath = runtime.sessionManager.getSessionFile()!;
  assert.ok(
    runtime
      .listCommands()
      .commands.some((command) => command.name === "fixture_one"),
  );
  await manager.installAndPersist(second);
  await settings.flush();
  const pending = runtime
    .listSettingsResources()
    .plugins.find((plugin) => plugin.baseDir === second);
  assert.equal(pending?.installed, true);
  assert.equal(pending?.extensions.length, 0);
  assert.equal(
    runtime
      .listCommands()
      .commands.some((command) => command.name === "fixture_two"),
    false,
  );
  await assert.rejects(
    runtime.reloadSettingsResources("stale", sessionPath),
    /idle/u,
  );
  await assert.rejects(
    runtime.reloadSettingsResources(sessionId, `${sessionPath}.copied`),
    /Session changed/u,
  );
  const originalIdle = runtime.isIdle;
  runtime.isIdle = () => false;
  await assert.rejects(
    runtime.reloadSettingsResources(sessionId, sessionPath),
    /idle/u,
  );
  runtime.isIdle = originalIdle;
  await runtime.reloadSettingsResources(sessionId, sessionPath);
  assert.ok(
    runtime
      .listCommands()
      .commands.some((command) => command.name === "fixture_two"),
  );
  const rangePackage = join(
    agentDir,
    "npm",
    "node_modules",
    "openpi-local-range-fixture",
  );
  await mkdir(rangePackage, { recursive: true });
  await writeFile(
    join(rangePackage, "package.json"),
    JSON.stringify({ name: "openpi-local-range-fixture", version: "1.2.3" }),
  );
  settings.setPackages([
    first,
    second,
    "npm:openpi-local-range-fixture@^1.0.0",
  ]);
  await settings.flush();
  await runtime.reloadSettingsResources(sessionId, sessionPath);
  settings.setPackages([
    first,
    second,
    "npm:openpi-local-range-fixture@^2.0.0",
  ]);
  await settings.flush();
  await assert.rejects(
    runtime.reloadSettingsResources(sessionId, sessionPath),
    /version-mismatched/u,
  );
  assert.equal(
    runtime
      .listSettingsResources()
      .plugins.find((plugin) => plugin.baseDir === second)?.extensions.length,
    1,
  );
  settings.setPackages([
    first,
    second,
    {
      source: "npm:openpi-deliberately-missing-fixture@1.0.0",
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
  ]);
  await settings.flush();
  await assert.rejects(
    runtime.reloadSettingsResources(sessionId, sessionPath),
    /missing or version-mismatched/u,
  );
  assert.ok(
    runtime
      .listCommands()
      .commands.some((command) => command.name === "fixture_two"),
  );
});
