import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function openBrowser(url: string, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    await execFileAsync(command, args, {
      timeout: 3000,
      killSignal: "SIGKILL",
      signal,
    });
    return true;
  } catch {
    return false;
  }
}
