import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EmbeddedBrowserManager } from "../../web/host/embedded-browser.ts";

// A fresh profile/process every time. A failed sample remains a failure;
// subsequent samples collect evidence rather than retrying away the outcome.
const fixture = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>Cold startup</title>Ready");
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
assert.ok(address && typeof address !== "string");
const results = [];
try {
  for (let sample = 1; sample <= 3; sample++) {
    const manager = new EmbeddedBrowserManager();
    const started = performance.now();
    try {
      await manager.open(
        `cold-start-${sample}`,
        `http://127.0.0.1:${address.port}/`,
      );
      results.push({
        sample,
        success: true,
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      results.push({
        sample,
        success: false,
        elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await manager.dispose();
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  fixture.closeAllConnections();
  await new Promise((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
}
assert.ok(
  results.every((result) => result.success),
  "Every cold startup must succeed",
);
