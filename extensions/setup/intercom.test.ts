import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  formatPiIntercomStatus,
  inspectPiIntercom,
  installPiIntercomSafely,
  isPiIntercomPackageSource,
  PI_INTERCOM_SOURCE,
  preparePiIntercomSafeDefaults,
} from "./intercom.ts";

const tempAgentDir = () => mkdtempSync(join(tmpdir(), "openpi-intercom-"));
const configPath = (agentDir: string) =>
  join(agentDir, "intercom", "config.json");

async function withAgentDir(run: (agentDir: string) => Promise<void> | void) {
  const agentDir = tempAgentDir();
  try {
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("recognizes only the pi-intercom npm package identity", () => {
  assert.equal(isPiIntercomPackageSource("npm:pi-intercom"), true);
  assert.equal(isPiIntercomPackageSource(" npm:pi-intercom@0.10.0 "), true);
  assert.equal(isPiIntercomPackageSource("npm:pi-intercom-next"), false);
  assert.equal(isPiIntercomPackageSource("git:pi-intercom"), false);
});

test("new installs receive private safe defaults before package activation", async () => {
  await withAgentDir(async (agentDir) => {
    const installed: string[] = [];
    await installPiIntercomSafely({
      agentDir,
      install: async (source) => {
        installed.push(source);
        assert.throws(
          () => readFileSync(configPath(agentDir), "utf8"),
          /ENOENT/,
        );
      },
      persist: async () => {
        assert.deepEqual(
          JSON.parse(readFileSync(configPath(agentDir), "utf8")),
          {
            confirmSend: true,
            inboundTrigger: "replies",
          },
        );
      },
    });

    assert.deepEqual(installed, [PI_INTERCOM_SOURCE]);
    assert.equal(statSync(configPath(agentDir)).mode & 0o777, 0o600);
  });
});

test("existing preferences and unknown fields are preserved", async () => {
  await withAgentDir(async (agentDir) => {
    await mkdir(join(agentDir, "intercom"), { recursive: true });
    const existing =
      '{\n  "confirmSend": false,\n  "inboundTrigger": "never",\n  "custom": 42\n}\n';
    writeFileSync(configPath(agentDir), existing);

    const prepared = await preparePiIntercomSafeDefaults(agentDir);
    assert.equal(prepared.changed, false);
    await installPiIntercomSafely({
      agentDir,
      install: async () => undefined,
    });
    assert.equal(readFileSync(configPath(agentDir), "utf8"), existing);
  });
});

test("an existing config missing safe fields is preserved and blocks installation", async () => {
  await withAgentDir(async (agentDir) => {
    await mkdir(join(agentDir, "intercom"), { recursive: true });
    const existing = `${JSON.stringify({ replyHint: false, confirmSend: false })}\n`;
    writeFileSync(configPath(agentDir), existing);
    let installCalls = 0;

    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => {
          installCalls += 1;
        },
      }),
      /will not rewrite an existing preference file/,
    );
    assert.equal(installCalls, 0);
    assert.equal(readFileSync(configPath(agentDir), "utf8"), existing);
  });
});

test("malformed or unsafe typed config blocks installation without overwriting", async () => {
  await withAgentDir(async (agentDir) => {
    await mkdir(join(agentDir, "intercom"), { recursive: true });
    for (const invalid of [
      "{ oops\n",
      `${JSON.stringify({ confirmSend: "yes" })}\n`,
      `${JSON.stringify({ inboundTrigger: "sometimes" })}\n`,
    ]) {
      writeFileSync(configPath(agentDir), invalid);
      let installCalls = 0;
      await assert.rejects(
        installPiIntercomSafely({
          agentDir,
          install: async () => {
            installCalls += 1;
          },
        }),
        /Refusing to overwrite/,
      );
      assert.equal(installCalls, 0);
      assert.equal(readFileSync(configPath(agentDir), "utf8"), invalid);
    }
  });
});

test("a symlinked intercom directory is rejected before writing outside agentDir", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }
  await withAgentDir(async (agentDir) => {
    const outside = join(agentDir, "outside");
    await mkdir(outside);
    await symlink(outside, join(agentDir, "intercom"));

    assert.match(
      inspectPiIntercom({ cwd: agentDir, active: false, agentDir })
        .diagnostic ?? "",
      /symlinked pi-intercom config directory/,
    );
    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => undefined,
      }),
      /Refusing non-directory or symlinked pi-intercom path/,
    );
    assert.throws(
      () => readFileSync(join(outside, "config.json"), "utf8"),
      /ENOENT/,
    );
  });
});

test("a symlinked config is rejected instead of overwriting its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }
  await withAgentDir(async (agentDir) => {
    await mkdir(join(agentDir, "intercom"), { recursive: true });
    const target = join(agentDir, "outside.json");
    const original = `${JSON.stringify({ protected: true })}\n`;
    writeFileSync(target, original);
    await symlink(target, configPath(agentDir));

    assert.match(
      inspectPiIntercom({ cwd: agentDir, active: false, agentDir })
        .diagnostic ?? "",
      /non-regular pi-intercom config file/,
    );
    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => undefined,
      }),
      /Refusing non-regular pi-intercom config path/,
    );
    assert.equal(readFileSync(target, "utf8"), original);
  });
});

test("a directory swap during package download aborts before config or activation", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }
  await withAgentDir(async (agentDir) => {
    const directory = join(agentDir, "intercom");
    const moved = join(agentDir, "intercom-moved");
    const outside = join(agentDir, "outside");
    let persisted = false;
    await mkdir(outside);

    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => {
          await rename(directory, moved);
          await symlink(outside, directory);
        },
        persist: async () => {
          persisted = true;
        },
      }),
      /directory identity changed during installation/,
    );
    assert.equal(persisted, false);
    assert.throws(
      () => readFileSync(join(outside, "config.json"), "utf8"),
      /ENOENT/,
    );
  });
});

test("the filesystem helper rejects a swapped cwd inode before writing", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }
  await withAgentDir(async (agentDir) => {
    const directory = join(agentDir, "intercom");
    const moved = join(agentDir, "intercom-moved");
    const outside = join(agentDir, "outside");
    await mkdir(directory);
    await mkdir(outside);
    const identity = statSync(directory, { bigint: true });
    await rename(directory, moved);
    await symlink(outside, directory);
    const helper = fileURLToPath(
      new URL("./intercom-fs-helper.cjs", import.meta.url),
    );

    const result = spawnSync(
      process.execPath,
      [
        helper,
        "create",
        String(identity.dev),
        String(identity.ino),
        "config.json",
        Buffer.from("safe", "utf8").toString("base64"),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OPENPI:IDENTITY:directory identity mismatch/);
    assert.throws(
      () => readFileSync(join(outside, "config.json"), "utf8"),
      /ENOENT/,
    );
  });
});

test("a manual config created during package download is preserved exactly", async () => {
  await withAgentDir(async (agentDir) => {
    const manual = `${JSON.stringify({
      confirmSend: false,
      inboundTrigger: "never",
      writtenBy: "user",
    })}\n`;
    let persisted = false;
    await installPiIntercomSafely({
      agentDir,
      install: async () => {
        writeFileSync(configPath(agentDir), manual);
      },
      persist: async () => {
        persisted = true;
      },
    });
    assert.equal(persisted, true);
    assert.equal(readFileSync(configPath(agentDir), "utf8"), manual);
  });
});

test("concurrent OpenPI installers fail closed on the package config lock", async () => {
  await withAgentDir(async (agentDir) => {
    let release!: () => void;
    let started!: () => void;
    const installationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const holdInstallation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = installPiIntercomSafely({
      agentDir,
      install: async () => {
        started();
        await holdInstallation;
      },
    });
    await installationStarted;

    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => undefined,
      }),
      /Another OpenPI pi-intercom installation is active/,
    );
    release();
    await first;
  });
});

test("failed package download writes no config", async () => {
  await withAgentDir(async (agentDir) => {
    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => {
          throw new Error("\u001b[31mregistry\n unavailable\u001b[0m");
        },
      }),
      (error: unknown) =>
        error instanceof Error && error.message === "registry unavailable",
    );
    assert.throws(() => readFileSync(configPath(agentDir), "utf8"), /ENOENT/);
  });
});

test("failed package-setting persistence retains newly created safe defaults", async () => {
  await withAgentDir(async (agentDir) => {
    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => undefined,
        persist: async () => {
          throw new Error("settings persistence failed");
        },
      }),
      /Safe defaults were retained/,
    );
    assert.deepEqual(JSON.parse(readFileSync(configPath(agentDir), "utf8")), {
      confirmSend: true,
      inboundTrigger: "replies",
    });
  });
});

test("persistence failure preserves a concurrently replaced safe config", async () => {
  await withAgentDir(async (agentDir) => {
    const replacement = `${JSON.stringify({
      confirmSend: true,
      inboundTrigger: "never",
      changedBy: "another-session",
    })}\n`;
    await assert.rejects(
      installPiIntercomSafely({
        agentDir,
        install: async () => undefined,
        persist: async () => {
          writeFileSync(configPath(agentDir), replacement);
          throw new Error("settings persistence failed");
        },
      }),
      /Safe defaults were retained/,
    );
    assert.equal(readFileSync(configPath(agentDir), "utf8"), replacement);
  });
});

test("inspects configured package version and effective safety defaults", async () => {
  await withAgentDir(async (agentDir) => {
    const packageDir = join(agentDir, "npm", "node_modules", "pi-intercom");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(agentDir, "intercom"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: [PI_INTERCOM_SOURCE] })}\n`,
    );
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "pi-intercom", version: "0.10.0" })}\n`,
    );
    writeFileSync(
      configPath(agentDir),
      `${JSON.stringify({ confirmSend: true, inboundTrigger: "replies" })}\n`,
    );

    assert.deepEqual(
      inspectPiIntercom({ cwd: agentDir, active: false, agentDir }),
      {
        configured: true,
        installed: true,
        active: false,
        version: "0.10.0",
        confirmSend: true,
        inboundTrigger: "replies",
      },
    );

    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "not-pi-intercom", version: "0.10.0" })}\n`,
    );
    const mismatched = inspectPiIntercom({
      cwd: agentDir,
      active: false,
      agentDir,
    });
    assert.equal(mismatched.installed, false);
    assert.match(mismatched.diagnostic ?? "", /identity mismatch/);
  });
});

test("formats absent, installed, and invalid integration states", () => {
  assert.equal(
    formatPiIntercomStatus({
      configured: false,
      installed: false,
      active: false,
    }),
    "Intercom: not installed · optional setup component",
  );
  assert.equal(
    formatPiIntercomStatus({
      configured: true,
      installed: true,
      active: false,
      version: "0.10.0",
      confirmSend: true,
      inboundTrigger: "replies",
      reloadRequired: true,
    }),
    "Intercom: 0.10.0 · installed · /reload required · parent-only · confirmSend on · inboundTrigger replies",
  );
  assert.equal(
    formatPiIntercomStatus({
      configured: false,
      installed: false,
      active: false,
      diagnostic: "\u001b[31mbad\n settings\u001b[0m",
    }),
    "Intercom: unavailable (bad settings)",
  );
});
