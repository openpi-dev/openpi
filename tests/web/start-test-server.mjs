import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Seed only this test process. Output cleanup, earlier runs and user settings
// must never determine which OpenPI commands this server loads.
const agentDirectory = mkdtempSync(join(tmpdir(), "openpi-web-e2e-agent-"));
process.once("exit", () => rmSync(agentDirectory, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
writeFileSync(join(agentDirectory, "settings.json"), `${JSON.stringify({ packages: [repositoryRoot] })}\n`, { mode: 0o600 });
execFileSync(process.execPath, [join(repositoryRoot, "scripts/provenance.mjs")], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
process.argv[1] = join(repositoryRoot, "bin/openpi.js");
await import("../../bin/openpi.js");
