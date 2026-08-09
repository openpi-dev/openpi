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
