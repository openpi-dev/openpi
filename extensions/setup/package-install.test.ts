import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const piCli = join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

function npm(cwd: string, args: string[]) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? execFileSync(process.execPath, [npmExecPath, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
      })
    : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
      });
}

test("the packed extensions start when optional ioredis is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-package-install-"));
  const app = join(root, "app");
  const agentDir = join(root, "agent");
  mkdirSync(app);
  mkdirSync(agentDir);

  try {
    const packed = JSON.parse(
      npm(packageRoot, [
        "pack",
        packageRoot,
        "--pack-destination",
        root,
        "--json",
        "--ignore-scripts",
      ]),
    ) as Array<{ filename: string }>;
    const tarball = join(root, packed[0]!.filename);

    writeFileSync(join(app, "package.json"), '{"private":true}\n');
    npm(app, [
      "install",
      tarball,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
      "--no-audit",
      "--no-fund",
    ]);

    const installedPackage = join(app, "node_modules", "@tt-a1i", "openpi");
    assert.equal(existsSync(join(app, "node_modules", "ioredis")), false);
    assert.equal(existsSync(join(installedPackage, "package.json")), true);

    const result = spawnSync(
      process.execPath,
      [
        piCli,
        "--offline",
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        join(installedPackage, "extensions", "file-search", "index.ts"),
        "--extension",
        join(installedPackage, "extensions", "git-info", "index.ts"),
      ],
      {
        cwd: app,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        input: "",
        timeout: 30_000,
      },
    );

    assert.equal(
      result.status,
      0,
      `Pi failed to load the packed extensions:\n${result.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
