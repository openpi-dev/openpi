import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(
  process.execPath,
  [
    "--watch",
    "--experimental-strip-types",
    fileURLToPath(new URL("../bin/openpi.js", import.meta.url)),
    "web",
    ...(process.argv[2] ? [process.argv[2]] : []),
    "--port",
    process.env.OPENPI_WEB_BACKEND_PORT || "57107",
    "--no-open",
  ],
  {
    env: {
      ...process.env,
      OPENPI_WEB_DEBUG: process.env.OPENPI_WEB_DEBUG || "1",
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
