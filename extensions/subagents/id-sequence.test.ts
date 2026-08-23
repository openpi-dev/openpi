import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  restoreSubagentIdCounters,
  SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
  subagentIdWatermark,
} from "./src/id-sequence.ts";

function entry(value: Partial<SessionEntry>) {
  return {
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    ...value,
  } as SessionEntry;
}

test("watermarks survive reload and retain independent model and btw sequences", () => {
  const branch = [
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: subagentIdWatermark("sa-7"),
    }),
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: subagentIdWatermark("btw-3"),
    }),
  ];

  assert.deepEqual(restoreSubagentIdCounters(branch), {
    modelCounter: 7,
    btwCounter: 3,
  });
});

test("restore takes the high water when concurrent completions arrive out of order", () => {
  const branch = ["sa-9", "sa-2", "sa-12"].map((id) =>
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: subagentIdWatermark(id),
    }),
  );

  assert.equal(restoreSubagentIdCounters(branch).modelCounter, 12);
});

test("legacy tool and result entries migrate without a watermark", () => {
  const branch = [
    entry({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "subagent_spawn",
        content: [{ type: "text", text: "Spawned" }],
        details: { id: "sa-4" },
        isError: false,
        timestamp: Date.now(),
      },
    }),
    entry({
      type: "custom",
      customType: "subagent-result",
      data: { details: { id: "sa-6" } },
    }),
    entry({
      type: "custom",
      customType: "btw-result",
      data: { id: "btw-5" },
    }),
  ];

  assert.deepEqual(restoreSubagentIdCounters(branch), {
    modelCounter: 6,
    btwCounter: 5,
  });
});

test("a fork restores only ids visible on its selected branch", () => {
  const beforeFork = entry({
    type: "custom",
    customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
    data: subagentIdWatermark("sa-2"),
  });
  const otherBranch = entry({
    type: "custom",
    customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
    data: subagentIdWatermark("sa-99"),
  });

  assert.equal(restoreSubagentIdCounters([beforeFork]).modelCounter, 2);
  assert.equal(
    restoreSubagentIdCounters([beforeFork, otherBranch]).modelCounter,
    99,
  );
});

test("malformed and unrelated entries cannot advance either sequence", () => {
  const branch = [
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: { version: 2, id: "sa-100" },
    }),
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: { version: 1, id: "sa-0" },
    }),
    entry({
      type: "custom",
      customType: "another-extension",
      data: { id: "sa-50" },
    }),
    entry({
      type: "custom",
      customType: SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
      data: { version: 1, id: "sa-3-extra" },
    }),
  ];

  assert.deepEqual(restoreSubagentIdCounters(branch), {
    modelCounter: 0,
    btwCounter: 0,
  });
});
