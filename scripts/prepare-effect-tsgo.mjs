import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let cli;
try {
  cli = fileURLToPath(import.meta.resolve("@effect/tsgo/dist/effect-tsgo.js"));
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND") process.exit(0);
  throw error;
}

const result = spawnSync(process.execPath, [cli, "patch"], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
