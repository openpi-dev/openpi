import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  name?: string;
  private?: boolean;
  license?: string;
  keywords?: string[];
  files?: string[];
  publishConfig?: { access?: string };
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

test("the public OpenPI package has complete gallery and registry metadata", () => {
  assert.equal(manifest.name, "@tt-a1i/openpi");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "UNLICENSED");
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(
    manifest.scripts?.prepublishOnly,
    "npm run format:check && npm run check && npm test",
  );
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/tt-a1i/my-pi-setup.git",
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/tt-a1i/my-pi-setup#readme",
  );
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/tt-a1i/my-pi-setup/issues",
  });
  assert.deepEqual(manifest.pi?.extensions, ["./extensions"]);
  assert.deepEqual(manifest.pi?.skills, ["./skills"]);
  assert.deepEqual(manifest.pi?.themes, ["./themes"]);
  assert.equal(
    manifest.pi?.image,
    "https://raw.githubusercontent.com/tt-a1i/my-pi-setup/main/assets/openpi-package.png",
  );
  assert.deepEqual(manifest.files, [
    "extensions",
    "!extensions/**/*.test.ts",
    "!extensions/**/*.spec.ts",
    "!extensions/**/tsconfig.json",
    "!extensions/*/docs",
    "skills",
    "themes",
    "assets",
    "scripts/prepare-effect-tsgo.mjs",
    "README.md",
    "SETUP.md",
    "THIRD_PARTY_NOTICES.md",
  ]);
});
