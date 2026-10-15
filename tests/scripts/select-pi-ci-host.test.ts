import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PI_FAMILY,
  selectPiHost,
  verifyInstalledHost,
} from "../../scripts/select-pi-ci-host.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openpi-ci-host-test-"));
  const manifest = Buffer.from(
    JSON.stringify({
      peerDependencies: Object.fromEntries(
        ["ai", "coding-agent", "tui"].map((name) => [
          `@earendil-works/pi-${name}`,
          ">=0.99.1",
        ]),
      ),
      devDependencies: { "@earendil-works/pi-ai": "^1.2.0" },
    }) + "\n\n",
  );
  const lock = Buffer.from(
    PI_FAMILY.map((name) => `"${name}": ["${name}@1.2.0"],`).join("\n"),
  );
  writeFileSync(join(root, "package.json"), manifest);
  writeFileSync(join(root, "bun.lock"), lock);
  return { root, manifest, lock };
}
function install(root: string, version: string) {
  for (const name of PI_FAMILY) {
    const dir = join(root, "node_modules", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(dir, "dist/index.js"), "");
  }
  return PI_FAMILY.map((name) => `${name}@${version}`).join("\n");
}
for (const outcome of ["success", "install-failure", "assertion-failure"]) {
  test(`selected family restores exact manifest/lock after ${outcome}`, () => {
    const { root, manifest, lock } = fixture();
    let latestCalls = 0;
    try {
      const action = () =>
        selectPiHost({
          root,
          endpoint: "latest",
          run(command, args) {
            if (command === "npm") {
              latestCalls++;
              return "1.3.0\n";
            }
            if (args[0] === "install") {
              const pinned = JSON.parse(
                readFileSync(join(root, "package.json"), "utf8"),
              );
              for (const name of PI_FAMILY) {
                assert.equal(pinned.devDependencies[name], "1.3.0");
                assert.equal(pinned.overrides[name], "1.3.0");
              }
              writeFileSync(join(root, "bun.lock"), "changed lock");
              if (outcome === "install-failure")
                throw new Error("install failed");
              return "";
            }
            const listing = install(root, "1.3.0");
            return outcome === "assertion-failure"
              ? listing.replace("pi-mcp@1.3.0", "pi-mcp@1.2.0")
              : listing;
          },
        });
      if (outcome === "success") assert.equal(action(), "1.3.0");
      else assert.throws(action);
      assert.equal(latestCalls, 1);
      assert.deepEqual(readFileSync(join(root, "package.json")), manifest);
      assert.deepEqual(readFileSync(join(root, "bun.lock")), lock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test("minimum derives from peers rather than newer development range", () => {
  const { root } = fixture();
  try {
    assert.equal(
      selectPiHost({
        root,
        endpoint: "minimum",
        run(command, args) {
          assert.equal(command, "bun");
          return args[0] === "install" ? "" : install(root, "0.99.1");
        },
      }),
      "0.99.1",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("missing family and mismatched physical installed identity fail closed", () => {
  const { root } = fixture();
  try {
    const listing = install(root, "1.3.0");
    assert.throws(
      () =>
        verifyInstalledHost(
          root,
          "1.3.0",
          listing.replace(/.*pi-mcp@1.3.0/u, ""),
        ),
      /Missing/,
    );
    writeFileSync(
      join(root, "node_modules/@earendil-works/pi-mcp/package.json"),
      JSON.stringify({ name: "wrong", version: "1.3.0" }),
    );
    assert.throws(
      () => verifyInstalledHost(root, "1.3.0", listing),
      /Installed identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
for (const extraVersion of [
  "1.3.0-beta.1",
  "1.3.0+build.7",
  "1.3.0-rc.2+sha.abc",
  "1.3.0unexpected",
  "npm:1.3.0",
]) {
  test(`additional Pi listing entry preserves the complete ${extraVersion} token`, () => {
    const { root } = fixture();
    try {
      const listing = install(root, "1.3.0");
      assert.throws(
        () =>
          verifyInstalledHost(
            root,
            "1.3.0",
            `${listing}\n└── @earendil-works/pi-mcp@${extraVersion}`,
          ),
        /Mixed Pi host/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test("listing equality retains a complete prerelease/build token rather than truncating it", () => {
  const { root } = fixture();
  try {
    const version = "1.3.0-beta.1+build.7";
    const listing = install(root, version);
    assert.doesNotThrow(() =>
      verifyInstalledHost(
        root,
        version,
        `${listing}\n└── @earendil-works/pi-mcp@${version}`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
