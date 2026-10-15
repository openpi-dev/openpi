import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_FAMILY = [
  "agent-core",
  "ai",
  "codemode",
  "coding-agent",
  "mcp",
  "telemetry",
  "tui",
].map((name) => `@earendil-works/pi-${name}`);

export function supportFloor(manifest) {
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) =>
    name.startsWith("@earendil-works/pi-"),
  );
  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(
    manifest.peerDependencies["@earendil-works/pi-coding-agent"],
  )?.[1];
  assert.ok(floor, "Pi peers must declare an explicit stable minimum");
  for (const [name, range] of peers) assert.equal(range, `>=${floor}`, name);
  return floor;
}

export function assertStableAtLeast(version, floor) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "Pi host must be a stable release");
  const minimum = floor.split(".").map(Number);
  const selected = version.split(".").map(Number);
  const difference = selected.findIndex(
    (value, index) => value !== minimum[index],
  );
  assert.ok(
    difference < 0 || selected[difference] > minimum[difference],
    `Pi ${version} is below supported minimum ${floor}`,
  );
}

export function verifyInstalledHost(root, version, listing) {
  const installed = [
    ...listing.matchAll(/(@earendil-works\/pi-[\w-]+)@([^\s]+)/g),
  ];
  for (const name of PI_FAMILY) {
    assert.ok(
      installed.some((match) => match[1] === name),
      `Missing ${name}`,
    );
    const path = realpathSync(
      resolve(root, "node_modules", name, "package.json"),
    );
    const loaded = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(loaded.name, name, `Installed identity: ${name}`);
    assert.equal(loaded.version, version, `Installed Pi host: ${name}`);
  }
  for (const [, name, actual] of installed) {
    assert.ok(PI_FAMILY.includes(name), `Unexpected Pi family: ${name}`);
    assert.equal(actual, version, `Mixed Pi host: ${name}`);
  }
  const entry = realpathSync(
    resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  );
  console.log(JSON.stringify({ version, family: PI_FAMILY, entry }));
}

export function selectPiHost({
  root = process.cwd(),
  endpoint = process.env.PI_HOST,
  run = execFileSync,
} = {}) {
  assert.ok(
    endpoint === "minimum" || endpoint === "latest",
    "Unknown PI_HOST endpoint",
  );
  const manifestPath = resolve(root, "package.json");
  const lockPath = resolve(root, "bun.lock");
  const originalManifest = readFileSync(manifestPath);
  const originalLock = readFileSync(lockPath);
  const manifest = JSON.parse(originalManifest.toString());
  const floor = supportFloor(manifest);
  const version =
    endpoint === "minimum"
      ? floor
      : run(
          "npm",
          ["view", "@earendil-works/pi-coding-agent@latest", "version"],
          { cwd: root, encoding: "utf8", timeout: 60_000 },
        ).trim();
  assertStableAtLeast(version, floor);
  const lockedFamily = [
    ...originalLock.toString().matchAll(/"(@earendil-works\/pi-[^"/]+)": \[/g),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    lockedFamily,
    [...PI_FAMILY].sort(),
    "Locked Pi family changed",
  );
  for (const name of PI_FAMILY) manifest.devDependencies[name] = version;
  manifest.overrides = {
    ...manifest.overrides,
    ...Object.fromEntries(PI_FAMILY.map((name) => [name, version])),
  };
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("bun", ["install"], { cwd: root, stdio: "inherit", timeout: 300_000 });
    const listing = run("bun", ["pm", "ls", "--all"], {
      cwd: root,
      encoding: "utf8",
    });
    verifyInstalledHost(root, version, listing);
    console.log(
      `Pi ${endpoint} host verified: ${version} (${PI_FAMILY.length} packages)`,
    );
    return version;
  } finally {
    writeFileSync(manifestPath, originalManifest);
    writeFileSync(lockPath, originalLock);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  selectPiHost();
}
