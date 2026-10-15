import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
const [mode, root] = process.argv.slice(2);
const sessionRoot = join(root, "sessions");
const { acquireWebHostLease } = await import("../../../web/runtime/web-host-lease.ts");
if (mode === "hold-lease") {
  const lease = await acquireWebHostLease(sessionRoot);
  process.on("SIGTERM", async () => { await lease.release(); process.exit(0); });
  process.stdout.write(JSON.stringify({ held: true }) + "\n");
  setInterval(() => {}, 1000);
} else {
  if (mode.startsWith("crash-")) {
    const originalOpen = fs.open;
    fs.open = async (path, ...args) => {
      if (mode === "crash-before-marker" && basename(path) === ".openpi-pending.json") {
        process.stdout.write(JSON.stringify({ pending: join(path, "..") }) + "\n"); process.exit(89);
      }
      if (mode === "crash-partial-marker" && basename(path) === ".openpi-pending.json") {
        const handle = await originalOpen(path, ...args); await handle.writeFile("{"); await handle.sync();
        process.stdout.write(JSON.stringify({ pending: join(path, "..") }) + "\n"); process.exit(89);
      }
      if (mode === "crash-payload" && basename(path).startsWith("2-original-")) {
        process.stdout.write(JSON.stringify({ pending: join(path, "..") }) + "\n"); process.exit(90);
      }
      return originalOpen(path, ...args);
    };
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (mode === "crash-publish" && basename(from).startsWith(".pending-v1-")) {
        process.stdout.write(JSON.stringify({ pending: from, target: to }) + "\n"); process.exit(88);
      }
      return originalRename(from, to);
    };
  }
  if (mode === "recover-unlink-fail") {
    const original = fs.unlink;
    fs.unlink = async (path) => {
      if (basename(path).startsWith("1-original-")) throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
      return original(path);
    };
  }
  if (mode === "recover-marker-gap") {
    const original = fs.rmdir;
    fs.rmdir = async (path) => {
      if (basename(path).startsWith(".pending-v1-")) throw Object.assign(new Error("injected final rmdir failure"), { code: "EACCES" });
      return original(path);
    };
  }
  syncBuiltinESMExports();
  const { persistPromptFiles, recoverPendingPromptFiles } = await import("../../../web/host/prompt-files.ts");
  const lease = await acquireWebHostLease(sessionRoot);
  try {
    if (mode.startsWith("recover")) console.log(JSON.stringify(await recoverPendingPromptFiles(sessionRoot)));
    else {
      const sessionPath = join(sessionRoot, "native.jsonl");
      const manager = { isPersisted: () => true, getSessionId: () => "native", getSessionFile: () => sessionPath };
      const runtime = { workspaceSelected: true, sessionDirectory: sessionRoot, sessionManager: manager };
      console.log(JSON.stringify(await persistPromptFiles(runtime, { sessionId: "native", sessionPath, files: [
        { name: "one.bin", data: Buffer.from("original one").toString("base64"), text: "extracted one" },
        { name: "two.bin", data: Buffer.from("original two").toString("base64") },
      ] })));
    }
  } finally { await lease.release(); }
}
