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
const npmConfig = readFileSync(
  new URL("../../../.npmrc", import.meta.url),
  "utf8",
);
const bunLock = readFileSync(
  new URL("../../../bun.lock", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../../../README.md", import.meta.url),
  "utf8",
);
const setupGuide = readFileSync(
  new URL("../../../SETUP.md", import.meta.url),
  "utf8",
);

const PI_HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

const HOST_PACKAGES = [...PI_HOST_PACKAGES, "typebox"] as const;

const PI_MINIMUM_VERSION =
  /^\^(\d+\.\d+\.\d+)$/.exec(
    manifest.devDependencies?.[PI_HOST_PACKAGES[0]] ?? "",
  )?.[1] ?? "";

test("Pi host packages stay peers while local checks keep development copies", () => {
  for (const packageName of HOST_PACKAGES) {
    assert.equal(
      manifest.peerDependencies?.[packageName],
      packageName === "typebox" ? "*" : `>=${PI_MINIMUM_VERSION}`,
    );
    assert.ok(manifest.devDependencies?.[packageName]);
    assert.equal(manifest.dependencies?.[packageName], undefined);
  }
});

test("Pi package ranges, docs, and Bun lock share one support minimum", () => {
  const importerMatch = bunLock.match(
    /"workspaces"\s*:\s*\{\s*""\s*:\s*\{([\s\S]*?)\n\s*\}\s*,\s*\}\s*,\s*"packages"\s*:/u,
  );
  assert.ok(importerMatch, "bun.lock root workspace importer is missing");
  const devSection = importerMatch[1].match(
    /"devDependencies"\s*:\s*\{([\s\S]*?)\n\s*\},/u,
  );
  const peerSection = importerMatch[1].match(
    /"peerDependencies"\s*:\s*\{([\s\S]*?)\n\s*\},/u,
  );
  assert.ok(devSection, "bun.lock devDependencies importer is missing");
  assert.ok(peerSection, "bun.lock peerDependencies importer is missing");

  assert.ok(
    PI_MINIMUM_VERSION,
    "Pi manifest must declare a stable minimum version",
  );
  const minimumVersion = PI_MINIMUM_VERSION;
  assert.ok(readme.includes(`Pi \`${minimumVersion}\` 或更新版本`));
  assert.ok(setupGuide.includes(`Pi ${minimumVersion} or newer`));

  const resolvedVersions: string[] = [];
  for (const packageName of PI_HOST_PACKAGES) {
    const devMatch: RegExpMatchArray | null = devSection[1].match(
      new RegExp(`"${packageName}"\\s*:\\s*"([^"]+)"`, "u"),
    );
    const peerMatch: RegExpMatchArray | null = peerSection[1].match(
      new RegExp(`"${packageName}"\\s*:\\s*"([^"]+)"`, "u"),
    );
    assert.ok(devMatch, `bun.lock devDependencies is missing ${packageName}`);
    assert.ok(peerMatch, `bun.lock peerDependencies is missing ${packageName}`);
    assert.equal(manifest.devDependencies?.[packageName], devMatch[1]);
    assert.equal(manifest.peerDependencies?.[packageName], peerMatch[1]);
    assert.equal(devMatch[1], `^${minimumVersion}`);
    assert.equal(peerMatch[1], `>=${minimumVersion}`);

    const resolvedMatch = bunLock.match(
      new RegExp(
        `^\\s*"${packageName}":\\s*\\[\\s*"${packageName}@(\\d+\\.\\d+\\.\\d+)"`,
        "mu",
      ),
    );
    assert.ok(
      resolvedMatch,
      `bun.lock resolved package is missing ${packageName}`,
    );
    resolvedVersions.push(resolvedMatch[1]);
  }
  assert.equal(new Set(resolvedVersions).size, 1);
  const [resolvedMajor, resolvedMinor, resolvedPatch] = resolvedVersions[0]
    .split(".")
    .map(Number);
  const [minimumMajor, minimumMinor, minimumPatch] = minimumVersion
    .split(".")
    .map(Number);
  assert.ok(
    resolvedMajor > minimumMajor ||
      (resolvedMajor === minimumMajor &&
        (resolvedMinor > minimumMinor ||
          (resolvedMinor === minimumMinor && resolvedPatch >= minimumPatch))),
    `resolved Pi hosts must be at least ${minimumVersion}`,
  );
});

test("Git source installs do not resolve host-provided peer dependencies", () => {
  const directives = npmConfig
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(directives, ["legacy-peer-deps=true"]);
});

test("the manifest enforces the documented Node floor", () => {
  assert.equal(manifest.engines?.node, ">=22.19.0");
});

test("the standalone CLI ships its TypeScript module loader", () => {
  assert.equal(manifest.dependencies?.jiti, "2.7.0");
});

test("experimental Pi server stays outside OpenPI runtime dependencies", () => {
  assert.equal(manifest.dependencies?.["@earendil-works/pi-server"], undefined);
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
