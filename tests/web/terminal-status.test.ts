import assert from "node:assert/strict";
import test from "node:test";
import { formatWebReadyScreen } from "../../web/host/terminal-status.ts";

const origin = "http://127.0.0.1:43210";
const url = `${origin}/#token=${"a".repeat(64)}`;

test("ready screen explains the independent Web boundary without binding to terminal cwd", () => {
  const output = formatWebReadyScreen({
    origin,
    url,
    opened: true,
    color: false,
  });

  assert.match(output, /OpenPI Web Workbench/u);
  assert.match(output, /ready/u);
  assert.match(output, new RegExp(origin.replaceAll(".", "\\."), "u"));
  assert.match(output, /choose and switch in the browser/u);
  assert.match(output, /separate from terminal Pi/u);
  assert.match(output, /Ctrl\+C\s+stop/u);
  assert.doesNotMatch(output, /token=/u);
  assert.doesNotMatch(output, /workspace\/current/u);
  assert.doesNotMatch(output, /\u001b\[/u);
});

test("ready screen exposes the authenticated URL only when browser opening fails", () => {
  const output = formatWebReadyScreen({
    origin,
    url,
    opened: false,
    color: false,
  });

  assert.match(output, new RegExp(url.replaceAll(".", "\\."), "u"));
  assert.match(output, /Browser\s+not opened/u);
});
