import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";

const source = resolve(".");
const dependencies = realpathSync(resolve("node_modules"));
// Vite intentionally rejects Windows 8.3 aliases (e.g. RUNNER~1). Windows
// TEMP can contain one even after realpathSync.native; use the checkout
// parent for disposable fixtures rather than weakening Vite's access policy.
const fixtureParent = process.platform === "win32" ? source : tmpdir();

test("HTTP denies sensitive symlink targets but serves ordinary files and modules", {
  timeout: 30_000,
}, async (context) => {
  const directory = realpathSync(
    mkdtempSync(join(fixtureParent, "openpi-http-")),
  );
  const root = join(directory, ".git/pi-worktrees/inside");
  const modules = join(directory, "modules");
  const metadata = join(directory, "private/.git");
  mkdirSync(root, { recursive: true });
  mkdirSync(modules, { recursive: true });
  mkdirSync(metadata, { recursive: true });
  const marker = "OPENPI_SYNTHETIC_PRIVATE_MARKER";
  writeFileSync(join(directory, ".env"), marker);
  writeFileSync(join(metadata, "config"), marker);
  writeFileSync(join(root, "ordinary.txt"), "ordinary fixture");
  writeFileSync(join(root, "value.js"), "export const value = 42;\n");
  writeFileSync(join(modules, "ordinary.txt"), "ordinary linked fixture");
  writeFileSync(join(modules, "value.js"), "export const linkedValue = 43;\n");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(metadata, join(root, "metadata"), linkType);
  symlinkSync(modules, join(root, "modules"), linkType);
  if (process.platform !== "win32") {
    symlinkSync(join(directory, ".env"), join(root, "alias.txt"));
  } else {
    context.diagnostic(
      "Windows: directory junction privacy/compatibility tested; file-symlink .env case requires privileges and is not exercised.",
    );
  }
  const baseline = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, fs: { strict: true, allow: [root] } },
  });
  const originalAllow = [...baseline.config.server.fs.allow];
  await baseline.close();
  const server = await createServer({
    root,
    configFile: join(source, "vitest.config.mjs"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, fs: { strict: true, allow: [root] } },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      return { status: response.status, body: await response.text() };
    };
    for (const path of [
      "/metadata/config",
      ...(process.platform === "win32" ? [] : ["/alias.txt"]),
    ]) {
      const response = await get(path);
      assert.equal(response.status, 403, path);
      assert.equal(response.body.includes(marker), false, path);
    }
    for (const [path, content] of [
      ["/ordinary.txt", "ordinary fixture"],
      ["/value.js", "42"],
      ["/modules/ordinary.txt", "ordinary linked fixture"],
      ["/modules/value.js", "43"],
    ]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.ok(response.body.includes(content), path);
    }
    assert.equal((await get("/missing.txt")).status, 404);
    assert.equal(server.config.server.fs.strict, true);
    assert.deepEqual(server.config.server.fs.allow, originalAllow);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Exercise real Git worktrees, real tool discovery and sibling module imports;
// a config-shape assertion alone misses the absolute-path deny failure (#663).
test("validation works inside and outside Git metadata without exposing private files", {
  timeout: 90_000,
}, () => {
  const directory = realpathSync(
    mkdtempSync(join(fixtureParent, "openpi-validation-")),
  );
  const repository = join(directory, "repository");
  const run = (cwd: string, command: string, args: string[]) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  try {
    mkdirSync(repository);
    run(repository, "git", ["init", "--quiet"]);
    for (const folder of ["tests/web", "web/ui/src"]) {
      mkdirSync(join(repository, folder), { recursive: true });
    }
    for (const config of ["biome.json", "vitest.config.mjs"]) {
      copyFileSync(join(source, config), join(repository, config));
    }
    writeFileSync(
      join(repository, "package.json"),
      JSON.stringify({ type: "module", devDependencies: { react: "19.2.8" } }),
    );
    writeFileSync(
      join(repository, "web/ui/src/value.ts"),
      "export const value = 42;\n",
    );
    writeFileSync(
      join(repository, "web/ui/src/component.tsx"),
      `export const Component = ({ items }: { items: string[] }) => items.map((item, index) => (\n  // biome-ignore lint/suspicious/noArrayIndexKey: immutable fixture coordinates\n  <span key={index}>{item}</span>\n));\n`,
    );
    writeFileSync(
      join(repository, "tests/web/value.spec.ts"),
      `// @vitest-environment jsdom\nimport { expect, it } from "vitest";\nimport { value } from "../../web/ui/src/value";\nimport { createElement } from "react";\nit("loads a sibling source module and symlinked dependency", () => { expect(value).toBe(42); expect(typeof createElement).toBe("function"); });\n`,
    );
    run(repository, "git", ["add", "."]);
    run(repository, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    for (const root of [
      join(repository, ".git/pi-worktrees/inside"),
      join(directory, "outside"),
    ]) {
      run(repository, "git", [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        root,
        "HEAD",
      ]);
      symlinkSync(
        dependencies,
        join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      run(root, process.execPath, [
        join(dependencies, "@biomejs/biome/bin/biome"),
        "lint",
        ".",
        "--error-on-warnings",
      ]);
      run(root, process.execPath, [
        join(dependencies, "vitest/vitest.mjs"),
        "run",
        "tests/web/value.spec.ts",
      ]);
      run(root, process.execPath, [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { createServer } from "vite";
        import { resolve } from "node:path";
        const server = await createServer({ configFile: "vitest.config.mjs", server: { middlewareMode: true } });
        try {
          assert.equal(server.config.server.fs.strict, true);
          assert.equal(server.config.fsDenyGlob(resolve("web/ui/src/value.ts")), false);
          for (const file of [".git", ".GIT", ".git/config", "web/.git/config", "web/.GIT/config", ".env", "web/.env.local", ".npmrc", ".yarnrc.yml", "web/private.pem", "web/private.key", "web/private.crt", "web/private.p12", "web/private.pfx", "web/private.cer", "web/private.der"]) {
            assert.equal(server.config.fsDenyGlob(resolve(file)), true, file);
          }
          assert.equal(server.config.fsDenyGlob(${JSON.stringify(join(repository, ".git/config"))}), true);
        } finally { await server.close(); }
      `,
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
