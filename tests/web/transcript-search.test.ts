import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  searchWebTranscripts,
  type WebTranscriptSearchSession,
} from "../../web/search/transcript-search.ts";

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function header(id: string, cwd: string) {
  return {
    type: "session",
    version: 3,
    id,
    cwd,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  timestamp: number,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp, ...extra },
  };
}

function session(
  id: string,
  path: string,
  cwd: string,
  overrides: Partial<WebTranscriptSearchSession> = {},
): WebTranscriptSearchSession {
  return {
    id,
    path,
    cwd,
    modified: "2026-01-01T00:00:00.000Z",
    source: "web",
    ...overrides,
  };
}

test("searches a Session file written by Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-pi-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, sessionDirectory);
    manager.appendMessage({
      role: "user",
      content: "Pi persisted a quasar marker",
      timestamp: 1,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "confirmed quasar" }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const path = manager.getSessionFile();
    assert.ok(path);

    const result = await searchWebTranscripts({
      query: "quasar",
      sessions: [
        session(manager.getSessionId(), path, root, { source: "terminal" }),
      ],
      allowedSessionRoots: [sessionDirectory],
      allowedWorkspaces: [root],
    });

    assert.equal(result.partial, false);
    assert.deepEqual(
      result.matches.map((match) => [match.source, match.sessionSource]),
      [
        ["assistant", "terminal"],
        ["user", "terminal"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searches user, assistant, and bounded tool evidence with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-search-"));
  const path = join(root, "session.jsonl");
  try {
    await writeFile(
      path,
      [
        header("session-1", root),
        message("user-1", null, "user", "Find NEEDLE in the haystack", 1),
        {
          type: "model_change",
          id: "model-1",
          parentId: "user-1",
          timestamp: new Date(1).toISOString(),
          provider: "fixture",
          modelId: "fixture",
        },
        message(
          "assistant-1",
          "model-1",
          "assistant",
          [
            { type: "text", text: "I found the needle." },
            {
              type: "toolCall",
              id: "call-1",
              name: "rg",
              arguments: { pattern: "needle", path: "src" },
            },
          ],
          2,
        ),
        message(
          "result-1",
          "assistant-1",
          "toolResult",
          [{ type: "text", text: "src/a.ts: needle\u001b[31m\u202e" }],
          3,
          { toolName: "rg", toolCallId: "call-1" },
        ),
      ]
        .map(line)
        .join(""),
    );

    const result = await searchWebTranscripts({
      query: "needle",
      sessions: [session("session-1", path, root)],
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
    });

    assert.equal(result.partial, false);
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.matches.length, 4);
    assert.deepEqual(
      new Set(result.matches.map((match) => match.source)),
      new Set(["user", "assistant", "tool_call", "tool_result"]),
    );
    assert.ok(result.matches.every((match) => match.turnId === "user-1"));
    assert.ok(
      result.matches.every((match) => match.snippetFormat === "plain-text"),
    );
    assert.equal(result.matches[0]?.messageId, "result-1");
    assert.equal(result.matches[0]?.toolName, "rg");
    assert.doesNotMatch(result.matches[0]?.snippet ?? "", /[\u001b\u202e]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps snippets UTF-8 bounded and centered near a late match", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-snippet-"));
  const path = join(root, "session.jsonl");
  try {
    await writeFile(
      path,
      `${line(header("session-1", root))}${line(
        message(
          "user-1",
          null,
          "user",
          `${"前".repeat(100)} needle ${"后".repeat(100)}`,
          1,
        ),
      )}`,
    );
    const result = await searchWebTranscripts({
      query: "needle",
      sessions: [session("session-1", path, root)],
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
      limits: { maxSnippetBytes: 48 },
    });

    const match = result.matches[0];
    assert.ok(match);
    assert.equal(match.snippetTruncated, true);
    assert.match(match.snippet, /needle/u);
    assert.ok(Buffer.byteLength(match.snippet, "utf8") <= 48);
    assert.equal(match.snippet.includes("�"), false);

    const tiny = await searchWebTranscripts({
      query: "needle",
      sessions: [session("session-1", path, root)],
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
      limits: { maxSnippetBytes: 1 },
    });
    assert.ok(Buffer.byteLength(tiny.matches[0]?.snippet ?? "", "utf8") <= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails soft for malformed, unavailable, archived, and unauthorized sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-boundary-"));
  const workspace = join(root, "workspace");
  const outside = await mkdtemp(join(tmpdir(), "openpi-transcript-outside-"));
  const malformed = join(root, "malformed.jsonl");
  const archived = join(root, "archived.jsonl");
  const symlinkPath = join(root, "linked.jsonl");
  try {
    await writeFile(
      malformed,
      `{not-json}\n${line(header("malformed", workspace))}${line(
        message("good", null, "user", "needle survives", 1),
      )}`,
    );
    await writeFile(
      archived,
      `${line(header("archived", workspace))}${line(
        message("archived", null, "user", "needle", 2),
      )}`,
    );
    await symlink(malformed, symlinkPath);

    const result = await searchWebTranscripts({
      query: "needle",
      sessions: [
        session("malformed", malformed, workspace),
        session("archived", archived, workspace, { archived: true }),
        session("missing", join(root, "missing.jsonl"), workspace),
        session("outside", join(outside, "outside.jsonl"), workspace),
        session("wrong-workspace", archived, outside),
        session("symlink", symlinkPath, workspace),
      ],
      allowedSessionRoots: [root],
      allowedWorkspaces: [workspace],
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.messageId, "good");
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.skippedFiles, 4);
    assert.equal(result.malformedLines, 1);
    assert.deepEqual(
      new Set(result.partialReasons),
      new Set([
        "malformed-session",
        "unavailable-session",
        "unauthorized-session",
      ]),
    );

    const withArchive = await searchWebTranscripts({
      query: "needle",
      sessions: [session("archived", archived, workspace, { archived: true })],
      allowedSessionRoots: [root],
      allowedWorkspaces: [workspace],
      includeArchived: true,
    });
    assert.equal(withArchive.matches[0]?.messageId, "archived");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("rejects transcript provenance when the Session header identity differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-identity-"));
  const path = join(root, "session.jsonl");
  try {
    await writeFile(
      path,
      `${line(header("different-session", root))}${line(
        message("user-1", null, "user", "needle", 1),
      )}`,
    );
    const result = await searchWebTranscripts({
      query: "needle",
      sessions: [session("expected-session", path, root)],
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
    });

    assert.deepEqual(result.matches, []);
    assert.equal(result.malformedLines, 1);
    assert.deepEqual(result.partialReasons, ["malformed-session"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports file, byte, per-file, and result limits deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-limits-"));
  try {
    const paths = [0, 1, 2].map((index) => join(root, `${index}.jsonl`));
    await Promise.all(
      paths.map((path, index) =>
        writeFile(
          path,
          `${line(header(`session-${index}`, root))}${line(
            message(
              `user-${index}`,
              null,
              "user",
              `needle ${"x".repeat(200)}`,
              index + 1,
            ),
          )}${line(
            message(
              `user-${index}-b`,
              `user-${index}`,
              "user",
              "needle again",
              index + 10,
            ),
          )}`,
        ),
      ),
    );
    const sessions = paths.map((path, index) =>
      session(`session-${index}`, path, root, {
        modified: new Date(index).toISOString(),
      }),
    );

    const base = {
      query: "needle",
      sessions,
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
    } as const;
    const fileLimited = await searchWebTranscripts({
      ...base,
      limits: { maxFiles: 1 },
    });
    const byteLimited = await searchWebTranscripts({
      ...base,
      limits: { maxTotalBytes: 100 },
    });
    const perFileLimited = await searchWebTranscripts({
      ...base,
      sessions: [sessions[0]!],
      limits: { maxFileBytes: 100 },
    });
    const resultLimited = await searchWebTranscripts({
      ...base,
      limits: { maxResults: 1 },
    });

    assert.ok(fileLimited.partialReasons.includes("file-limit"));
    assert.ok(byteLimited.partialReasons.includes("byte-limit"));
    assert.ok(byteLimited.scannedBytes <= 100);
    assert.ok(perFileLimited.partialReasons.includes("per-file-byte-limit"));
    assert.equal(resultLimited.matches.length, 1);
    assert.ok(resultLimited.partialReasons.includes("result-limit"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops on the wall-time budget and responds to AbortSignal", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-transcript-cancel-"));
  const path = join(root, "session.jsonl");
  try {
    await writeFile(
      path,
      `${line(header("session-1", root))}${line(
        message("user-1", null, "user", "needle", 1),
      )}`,
    );
    let tick = 0;
    const timed = await searchWebTranscripts({
      query: "needle",
      sessions: [session("session-1", path, root)],
      allowedSessionRoots: [root],
      allowedWorkspaces: [root],
      limits: { maxDurationMs: 2 },
      now: () => tick++,
    });
    assert.equal(timed.matches.length, 0);
    assert.deepEqual(timed.partialReasons, ["time-limit"]);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchWebTranscripts({
        query: "needle",
        sessions: [session("session-1", path, root)],
        allowedSessionRoots: [root],
        allowedWorkspaces: [root],
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects empty, oversized, and unbounded requests", async () => {
  await assert.rejects(
    searchWebTranscripts({
      query: " ",
      sessions: [],
      allowedSessionRoots: [],
      allowedWorkspaces: [],
    }),
    /must not be empty/u,
  );
  await assert.rejects(
    searchWebTranscripts({
      query: "x".repeat(201),
      sessions: [],
      allowedSessionRoots: [],
      allowedWorkspaces: [],
    }),
    /must not exceed 200/u,
  );
  await assert.rejects(
    searchWebTranscripts({
      query: "needle",
      sessions: [],
      allowedSessionRoots: [],
      allowedWorkspaces: [],
      limits: { maxFiles: Number.POSITIVE_INFINITY },
    }),
    /positive integers/u,
  );
});
