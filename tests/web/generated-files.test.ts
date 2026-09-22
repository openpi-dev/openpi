import assert from "node:assert/strict";
import test from "node:test";
import type { WebLiveMessage } from "../../web/protocol/types.ts";
import { generatedFiles } from "../../web/ui/src/features/workbar/generated-files.ts";

function call(
  id: string,
  name: "write" | "edit",
  path: string,
  resolvedPath?: string,
): WebLiveMessage {
  return {
    role: "assistant",
    content: "",
    parts: [
      {
        type: "toolCall",
        id,
        name,
        arguments: JSON.stringify({ path }),
        evidenceArguments: {
          path,
          ...(resolvedPath ? { resolvedPath } : {}),
        },
      },
    ],
  };
}

function result(
  id: string,
  isError: boolean,
  change?: "created" | "overwritten" | "unchanged",
): WebLiveMessage {
  return {
    role: "toolResult",
    toolName: "write",
    toolCallId: id,
    content: "",
    isError,
    ...(change ? { details: { change } } : {}),
  };
}

test("generated files require paired successful write or edit evidence", () => {
  const files = generatedFiles([
    call("write-ok", "write", "docs/report.md", "/repo/docs/report.md"),
    result("write-ok", false, "created"),
    call("edit-failed", "edit", "src/app.ts", "/repo/src/app.ts"),
    result("edit-failed", true),
    result("missing-call", false, "created"),
  ]);
  assert.deepEqual(files, [
    {
      id: "write-ok",
      path: "docs/report.md",
      reference: "/repo/docs/report.md",
      tool: "write",
      change: "created",
    },
  ]);
});

test("generated files deduplicate by resolved path and keep the latest result", () => {
  const files = generatedFiles([
    call("write", "write", "report.md", "/repo/report.md"),
    result("write", false, "created"),
    call("edit", "edit", "report.md", "/repo/report.md"),
    result("edit", false, "overwritten"),
  ]);
  assert.deepEqual(files, [
    {
      id: "edit",
      path: "report.md",
      reference: "/repo/report.md",
      tool: "edit",
      change: "overwritten",
    },
  ]);
});
