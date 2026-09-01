import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  name?: string;
  private?: boolean;
  license?: string;
  keywords?: string[];
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  packageManager?: string;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  scripts?: Record<string, string>;
  pi?: {
    extensions?: string[];
    skills?: string[];
    themes?: string[];
    image?: string;
  };
};

const HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

test("Pi host packages stay peers while local checks keep development copies", () => {
  for (const packageName of HOST_PACKAGES) {
    assert.equal(manifest.peerDependencies?.[packageName], "*");
    assert.ok(manifest.devDependencies?.[packageName]);
    assert.equal(manifest.dependencies?.[packageName], undefined);
  }
});

test("the manifest enforces the documented Node floor", () => {
  assert.equal(manifest.engines?.node, ">=22.19.0");
});

test("the standalone CLI ships its TypeScript module loader", () => {
  assert.equal(manifest.dependencies?.jiti, "2.7.0");
});

test("pi-intercom stays an explicit opt-in instead of a bundled dependency", () => {
  assert.equal(manifest.dependencies?.["pi-intercom"], undefined);
  assert.equal(manifest.devDependencies?.["pi-intercom"], undefined);
});

test("the public OpenPI package has complete gallery and registry metadata", () => {
  assert.equal(manifest.name, "@tt-a1i/openpi");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.packageManager, "bun@1.3.14");
  assert.deepEqual(manifest.bin, { openpi: "./bin/openpi.js" });
  assert.equal(manifest.devDependencies?.["@biomejs/biome"], "2.5.8");
  assert.equal(manifest.devDependencies?.prettier, undefined);
  assert.equal(
    manifest.scripts?.prepublishOnly,
    "bun run check && bun run test",
  );
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/openpi-dev/openpi.git",
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/openpi-dev/openpi#readme",
  );
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/openpi-dev/openpi/issues",
  });
  assert.deepEqual(manifest.pi?.extensions, ["./extensions"]);
  assert.equal(manifest.pi?.skills, undefined);
  assert.deepEqual(manifest.pi?.themes, ["./themes"]);
  assert.equal(
    manifest.pi?.image,
    "https://raw.githubusercontent.com/openpi-dev/openpi/main/assets/openpi-package.png",
  );
  assert.deepEqual(manifest.files, [
    "bin",
    "web",
    "extensions",
    "!extensions/**/*.test.ts",
    "!extensions/**/*.spec.ts",
    "!extensions/**/tsconfig.json",
    "!extensions/**/test-support/**",
    "!extensions/*/docs",
    "!tests/**",
    "skills",
    "themes",
    "assets",
    "scripts/prepare-effect-tsgo.mjs",
    "README.md",
    "SETUP.md",
    "THIRD_PARTY_NOTICES.md",
  ]);
});
