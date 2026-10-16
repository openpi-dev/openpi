import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPerformanceSessionIdentity,
  performanceFixturePath,
  performanceSessionId,
} from "./web-performance-session.ts";

const consistent = {
  currentSessionId: performanceSessionId,
  currentSessionPath: performanceFixturePath,
  sessions: [
    {
      id: performanceSessionId,
      path: performanceFixturePath,
    },
  ],
  selectedSession: {
    id: performanceSessionId,
    path: performanceFixturePath,
  },
};

test("a consistent synthetic session identity is accepted", () => {
  assert.doesNotThrow(() => assertPerformanceSessionIdentity(consistent));
});

test("a host path with the synthetic id is rejected before the UI waits", () => {
  assert.throws(
    () =>
      assertPerformanceSessionIdentity({
        ...consistent,
        currentSessionPath: "/tmp/host/session.jsonl",
      }),
    /synthetic session identity mismatch/,
  );
});

test("a missing current path is rejected", () => {
  assert.throws(
    () =>
      assertPerformanceSessionIdentity({
        currentSessionId: consistent.currentSessionId,
        sessions: consistent.sessions,
        selectedSession: consistent.selectedSession,
      }),
    /synthetic session identity mismatch/,
  );
});

test("a selected session on a different path is rejected", () => {
  assert.throws(
    () =>
      assertPerformanceSessionIdentity({
        ...consistent,
        selectedSession: {
          id: performanceSessionId,
          path: "/m12-fixture/other.jsonl",
        },
      }),
    /synthetic session identity mismatch/,
  );
});
