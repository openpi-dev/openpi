import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("Pi discovers the bundled semantic skill and its executable client", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-semantic-skill-"));
  try {
    // Import the selected Pi host only after isolating its home and agent dir.
    // The subprocess uses this checkout for Node module resolution, while the
    // resource loader's project directory is an empty temporary directory.
    const program = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import { spawnSync } from "node:child_process";
      import { join } from "node:path";
      import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
      const [checkout, root] = process.argv.slice(1);
      const settingsManager = SettingsManager.inMemory(
        { packages: [checkout] }, { projectTrusted: false },
      );
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noPromptTemplates: true,
      });
      await loader.reload();
      const result = loader.getSkills();
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["semantic-navigation", "subagents", "workflows"]);
      const skill = result.skills.find((entry) => entry.name === "semantic-navigation");
      assert.ok(skill);
      const body = await readFile(skill.filePath, "utf8");
      assert.match(body, /scripts\\/semantic\\.mjs/);
      const script = join(skill.baseDir, "scripts", "semantic.mjs");
      const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", cwd: root });
      assert.equal(help.status, 0, help.stderr);
      assert.ok(JSON.parse(help.stdout).usage);
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", program, resolve("."), root],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          PI_CODING_AGENT_DIR: root,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr || result.error?.message || "Pi loader process failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
