import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import suggestionsExtension from "../../../extensions/suggestions/index.ts";

test("registers only bounded suggestion lifecycle hooks and no history renderer", () => {
  const events: string[] = [];
  const channels: string[] = [];
  const renderers: string[] = [];
  const api = {
    on: (event: string) => events.push(event),
    events: { on: (channel: string) => channels.push(channel) },
    registerMessageRenderer: (type: string) => renderers.push(type),
  } as unknown as ExtensionAPI;

  suggestionsExtension(api);

  assert.deepEqual(
    events.sort(),
    [
      "agent_settled",
      "before_agent_start",
      "input",
      "session_shutdown",
      "session_start",
    ].sort(),
  );
  assert.deepEqual(channels, ["my-pi-setup:config-changed"]);
  assert.deepEqual(renderers, []);
});
