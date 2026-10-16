import { parentPort } from "node:worker_threads";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

parentPort?.on("message", (message: { id: number; bytes: Uint8Array }) => {
  try {
    const text = Buffer.from(message.bytes).toString("utf8");
    parentPort?.postMessage({ id: message.id, entries: parseSessionEntries(text) });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
