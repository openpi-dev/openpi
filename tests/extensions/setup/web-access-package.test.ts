import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { configureWebAccessPackage } from "../../../extensions/setup/web-access-package.ts";
import {
  EXA_WEB_ACCESS_PROFILE,
  WEB_ACCESS_PACKAGE,
} from "../../../extensions/shared/web-access.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const settingsPath = join(agentDir, "settings.json");
  const preferencesPath = join(agentDir, "web-search.json");
  const original = {
    defaultModel: "user-choice",
    packages: [{ source: "/unrelated", extensions: ["one.ts"], skills: [] }],
  };
  await writeFile(settingsPath, JSON.stringify(original));
  const installedPath = join(
    agentDir,
    "npm",
    "node_modules",
    WEB_ACCESS_PACKAGE.name,
  );
  const install = t.mock.method(
    DefaultPackageManager.prototype,
    "install",
    async (source: string) => {
      assert.equal(source, WEB_ACCESS_PACKAGE.source);
      assert.ok(await stat(preferencesPath));
      await mkdir(installedPath, { recursive: true });
      await writeFile(
        join(installedPath, "package.json"),
        JSON.stringify(WEB_ACCESS_PACKAGE),
      );
    },
  );
  return {
    root,
    cwd,
    agentDir,
    settingsPath,
    preferencesPath,
    original,
    installedPath,
    install,
    confirm: async () => true,
  };
}

test("native confirmation cancellation makes no settings or preference changes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    configureWebAccessPackage({
      ...f,
      action: "install-exa",
      confirm: async (title, detail) => {
        assert.match(title, /Enable/u);
        assert.match(detail, /npm:pi-web-access@0\.38\.0/u);
        assert.match(detail, /queries go to Exa/u);
        return false;
      },
    }),
    /cancelled/u,
  );
  assert.equal(f.install.mock.callCount(), 0);
  assert.deepEqual(
    JSON.parse(await readFile(f.settingsPath, "utf8")),
    f.original,
  );
  await assert.rejects(stat(f.preferencesPath), { code: "ENOENT" });
});

test("Exa setup creates a private profile before native installation and preserves Pi preferences", async (t) => {
  const f = await fixture(t);
  const install = f.install;
  const receipt = await configureWebAccessPackage({
    ...f,
    action: "install-exa",
  });
  assert.equal(install.mock.callCount(), 1);
  assert.deepEqual(
    JSON.parse(await readFile(f.preferencesPath, "utf8")),
    EXA_WEB_ACCESS_PROFILE,
  );
  if (process.platform !== "win32")
    assert.equal((await stat(f.preferencesPath)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
  assert.equal(saved.defaultModel, f.original.defaultModel);
  assert.deepEqual(saved.packages[0], f.original.packages[0]);
  assert.equal(saved.packages[1].source, WEB_ACCESS_PACKAGE.source);
  assert.deepEqual(saved.packages[1].extensions, ["**/*"]);
  assert.match(receipt, /Current Session loading is unchanged/u);
});

test("existing preferences are never replaced, and require the explicit existing-profile choice", async (t) => {
  const f = await fixture(t);
  const bytes =
    '{ "provider": "brave", "braveApiKey": "private-fixture", "custom": 7 }\n';
  await writeFile(f.preferencesPath, bytes);
  await assert.rejects(
    configureWebAccessPackage({ ...f, action: "install-exa" }),
    /preserved/u,
  );
  assert.equal(f.install.mock.callCount(), 0);
  await configureWebAccessPackage({ ...f, action: "install-existing" });
  assert.equal(await readFile(f.preferencesPath, "utf8"), bytes);
});

test("failed installation leaves no enabled native package, with a safe retryable profile", async (t) => {
  const f = await fixture(t);
  f.install.mock.mockImplementation(async () => {
    throw new Error("offline");
  });
  await assert.rejects(
    configureWebAccessPackage({ ...f, action: "install-exa" }),
    /offline/u,
  );
  assert.deepEqual(
    JSON.parse(await readFile(f.settingsPath, "utf8")),
    f.original,
  );
  assert.deepEqual(
    JSON.parse(await readFile(f.preferencesPath, "utf8")),
    EXA_WEB_ACCESS_PROFILE,
  );
});

test("a local copy with the same package identity cannot be silently duplicated", async (t) => {
  const f = await fixture(t);
  const localPackage = join(f.root, "custom-web-package");
  await mkdir(localPackage);
  await writeFile(
    join(localPackage, "package.json"),
    JSON.stringify({ name: WEB_ACCESS_PACKAGE.name, version: "0.37.0" }),
  );
  const settings = {
    ...f.original,
    packages: [...f.original.packages, localPackage],
  };
  await writeFile(f.settingsPath, JSON.stringify(settings));
  await assert.rejects(
    configureWebAccessPackage({ ...f, action: "install-exa" }),
    /source or version/u,
  );
  assert.equal(f.install.mock.callCount(), 0);
  assert.deepEqual(
    JSON.parse(await readFile(f.settingsPath, "utf8")),
    settings,
  );
  await assert.rejects(stat(f.preferencesPath), { code: "ENOENT" });
});

test("package identity mismatch and unreadable native settings fail closed", async (t) => {
  const f = await fixture(t);
  f.install.mock.mockImplementation(async () => {
    await mkdir(f.installedPath, { recursive: true });
    await writeFile(
      join(f.installedPath, "package.json"),
      JSON.stringify({ name: "wrong", version: WEB_ACCESS_PACKAGE.version }),
    );
  });
  await assert.rejects(
    configureWebAccessPackage({ ...f, action: "install-exa" }),
    /identity/u,
  );
  assert.deepEqual(
    JSON.parse(await readFile(f.settingsPath, "utf8")),
    f.original,
  );
  await writeFile(f.settingsPath, "{unreadable");
  await assert.rejects(
    configureWebAccessPackage({ ...f, action: "install-existing" }),
    /settings could not be read/u,
  );
  assert.equal(await readFile(f.settingsPath, "utf8"), "{unreadable");
});

test("disable uses native resource filters without executing, deleting, or rewriting the plugin", async (t) => {
  const f = await fixture(t);
  const bytes = '{"provider":"exa"}\n';
  await writeFile(f.preferencesPath, bytes);
  await writeFile(
    f.settingsPath,
    JSON.stringify({
      ...f.original,
      packages: [...f.original.packages, WEB_ACCESS_PACKAGE.source],
    }),
  );
  const receipt = await configureWebAccessPackage({ ...f, action: "disable" });
  const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
  assert.deepEqual(saved.packages[0], f.original.packages[0]);
  assert.deepEqual(saved.packages[1], {
    source: WEB_ACCESS_PACKAGE.source,
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  assert.equal(await readFile(f.preferencesPath, "utf8"), bytes);
  assert.equal(f.install.mock.callCount(), 0);
  assert.match(receipt, /disabled in native configuration/u);
});
