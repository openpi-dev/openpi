import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readConfiguredPackages } from "../../web/runtime/configured-packages.ts";
import { projectWebSettingsResources } from "../../web/runtime/settings-catalog.ts";

const emptyLoader = {
  getExtensions: () => ({ extensions: [], errors: [] }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [] }),
  getThemes: () => ({ themes: [] }),
};

test("native configured packages remain visible before loading and preserve scope and disabled state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-configured-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const source = join(root, "package");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(source)]);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "fixture-package",
      version: "1.2.3",
      pi: { extensions: ["index.ts"] },
    }),
  );
  await writeFile(
    join(source, "index.ts"),
    'throw new Error("catalog reads must never execute extensions");',
  );
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: true,
  });
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });
  await manager.installAndPersist(source);
  settings.setPackages([
    source,
    {
      source: join(root, "missing"),
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
  ]);
  settings.setProjectPackages([source]);
  await settings.flush();
  const before = await readFile(join(agentDir, "settings.json"), "utf8");
  const native = readConfiguredPackages(cwd, agentDir, true);
  assert.equal(native.errors.length, 0);
  const catalog = projectWebSettingsResources(emptyLoader, native);
  assert.equal(catalog.plugins.length, 3);
  const global = catalog.plugins.find(
    (plugin) => plugin.source === source && plugin.scope === "user",
  );
  assert.equal(global?.configured, true);
  assert.equal(global?.installed, true);
  assert.equal(global?.installedVersion, "1.2.3");
  assert.equal(global?.name, "fixture-package");
  assert.equal(global?.extensions.length, 0);
  const disabled = catalog.plugins.find(
    (plugin) => plugin.source === join(root, "missing"),
  );
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.installed, false);
  assert.match(disabled?.diagnostics?.[0] ?? "", /not found/u);
  assert.equal(catalog.totals.extensions, 0);
  assert.equal(
    readConfiguredPackages(cwd, agentDir, false).packages.some(
      (plugin) => plugin.scope === "project",
    ),
    false,
  );
  assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), before);
});

test("corrupt native settings are diagnostic evidence, rather than a healthy empty catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-settings-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.json"), "{broken");
  const native = readConfiguredPackages(root, root, false);
  assert.equal(native.errors.length, 1);
  const catalog = projectWebSettingsResources(emptyLoader, native);
  assert.equal(catalog.diagnostics.settingsErrors, 1);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "{broken");
});

test("catalog keeps current Session resources distinct from later native configuration", () => {
  const sourceInfo = {
    source: "/fixture/package",
    scope: "user" as const,
    origin: "package" as const,
    baseDir: "/fixture/package",
  };
  const catalog = projectWebSettingsResources(
    {
      ...emptyLoader,
      getExtensions: () => ({
        extensions: [
          {
            path: "/fixture/package/index.ts",
            sourceInfo,
            tools: new Map(),
            commands: new Map(),
          },
        ],
        errors: [
          {
            path: "/fixture/package/broken.ts",
            error: "token=private-value load failure",
          },
        ],
      }),
    },
    {
      packages: [
        {
          ...sourceInfo,
          configured: true,
          installed: true,
          enabled: false,
          diagnostics: [],
        },
      ],
      errors: [],
    },
  );
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0]?.enabled, false);
  assert.equal(catalog.plugins[0]?.extensions.length, 1);
  assert.equal(
    catalog.plugins[0]?.diagnostics?.[0]?.includes("private-value"),
    false,
  );
});

test("bounded source labels retain distinct identities and do not advertise inexact operation targets", () => {
  const prefix = `/fixture/${"a".repeat(500)}`;
  const packages = ["one", "two"].map((suffix) => ({
    source: `${prefix}/${suffix}`,
    baseDir: undefined,
    scope: "user" as const,
    configured: true,
    enabled: true,
    installed: true,
    diagnostics: [],
  }));
  const catalog = projectWebSettingsResources(
    {
      ...emptyLoader,
      getSkills: () => ({
        skills: ["one", "two"].map((name) => ({
          name,
          description: "A native skill with a long path.",
          filePath: `${prefix}/${name}/SKILL.md`,
          sourceInfo: {
            source: "auto",
            scope: "user" as const,
            origin: "top-level" as const,
          },
          disableModelInvocation: false,
        })),
        diagnostics: [],
      }),
    },
    { packages, errors: [] },
  );
  const configuredPlugins = catalog.plugins.filter(
    (plugin) => plugin.configured,
  );
  assert.equal(configuredPlugins.length, 2);
  assert.notEqual(configuredPlugins[0]?.id, configuredPlugins[1]?.id);
  assert.ok(
    configuredPlugins.every(
      (plugin) =>
        plugin.configured &&
        plugin.canManage === false &&
        plugin.source.length <= 500,
    ),
  );
  assert.notEqual(catalog.skills[0]?.id, catalog.skills[1]?.id);
  assert.ok(
    catalog.skills.every(
      (skill) => skill.canManage === false && skill.filePath.length <= 500,
    ),
  );
});
