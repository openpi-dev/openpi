import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

test("pi-intercom stays an explicit opt-in instead of a bundled dependency", () => {
  assert.equal(manifest.dependencies?.["pi-intercom"], undefined);
  assert.equal(manifest.devDependencies?.["pi-intercom"], undefined);
});

test("runtime modules avoid the platform-node root barrel", () => {
  const extensionsRoot = new URL("../", import.meta.url);
  const sourceFiles = readdirSync(extensionsRoot, {
    recursive: true,
    withFileTypes: true,
  }).filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts"),
  );

  for (const sourceFile of sourceFiles) {
    const source = readFileSync(
      new URL(`${sourceFile.parentPath}/${sourceFile.name}`, extensionsRoot),
      "utf8",
    );
    assert.doesNotMatch(source, /from ["']@effect\/platform-node["']/);
  }
});

test("the public OpenPI package has complete gallery and registry metadata", () => {
  assert.equal(manifest.name, "@tt-a1i/openpi");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(
    manifest.scripts?.prepublishOnly,
    "npm run format:check && npm run check && npm test",
  );
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/tt-a1i/openpi.git",
  });
  assert.equal(manifest.homepage, "https://github.com/tt-a1i/openpi#readme");
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/tt-a1i/openpi/issues",
  });
  assert.deepEqual(manifest.pi?.extensions, ["./extensions"]);
  assert.deepEqual(manifest.pi?.skills, ["./skills"]);
  assert.deepEqual(manifest.pi?.themes, ["./themes"]);
  assert.equal(
    manifest.pi?.image,
    "https://raw.githubusercontent.com/tt-a1i/openpi/main/assets/openpi-package.png",
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
