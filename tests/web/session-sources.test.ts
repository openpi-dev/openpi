import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectSessionSources } from "../../web/adapter/session-sources.ts";
import { WebHost } from "../../web/host/web-host.ts";
import {
  formatSourceReference,
  sourceReferenceTokens,
  sourceReferences,
  type WebSessionSources,
} from "../../web/protocol/session-sources.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import { WEB_PROMPT_IMAGE_MAX_BYTES } from "../../web/protocol/types.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "aGk=",
  name: "diagram.png",
};

test("source tokens preserve exact spans and optional raw path labels without changing source shape", () => {
  const path = `/private/${"x".repeat(270)}/中文 100% [1].txt`;
  const reference = formatSourceReference(path, path);
  const content = `前言\n${reference}\n尾声`;
  const tokens = sourceReferenceTokens(content);
  assert.deepEqual(tokens, [
    {
      name: path,
      reference: encodeURI(path),
      start: 3,
      end: 3 + reference.length,
    },
  ]);
  assert.equal(content.slice(tokens[0]!.start, tokens[0]!.end), reference);
  assert.deepEqual(sourceReferences(content), [
    { name: path.slice(0, 255), reference: encodeURI(path) },
  ]);
  assert.deepEqual(
    sourceReferenceTokens(
      "[remote](<https://example.com/a.txt>) ![image](<a.txt>) [unsafe](<javascript:x>)",
    ),
    [],
  );
  assert.deepEqual(
    sourceReferenceTokens("[newline\nlabel](<a.txt>) [broken](<a.txt>"),
    [],
  );
  assert.equal(
    sourceReferenceTokens(
      Array.from({ length: 101 }, (_, i) =>
        formatSourceReference(`${i}.txt`),
      ).join("\n"),
    ).length,
    100,
  );
});

test("Windows source references retain encoded native paths without treating remote targets as drives", () => {
  const path = String.raw`C:\Users\operator\workspace\中文 100% [1].txt`;
  const reference = formatSourceReference(path);
  assert.deepEqual(sourceReferences(reference), [
    { name: "中文 100% [1].txt", reference: encodeURI(path) },
  ]);
  assert.equal(
    reference.slice(
      sourceReferenceTokens(reference)[0]!.start,
      sourceReferenceTokens(reference)[0]!.end,
    ),
    reference,
  );
  assert.deepEqual(sourceReferences("[notes](<%23notes.md>)"), [
    { name: "notes", reference: "%23notes.md" },
  ]);
  assert.deepEqual(
    sourceReferences(
      [
        "https://example.com/file.txt",
        String.raw`https:\example.com\file.txt`,
        "javascript:alert(1)",
        "//server/share/file.txt",
        "C:drive-relative.txt",
      ]
        .map((target) => formatSourceReference(target, "remote"))
        .join("\n"),
    ),
    [],
  );
});

test("sources use native saved user attachments and explicit links, respecting branches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-native-sources-"));
  try {
    const manager = SessionManager.create(directory, directory);
    const target = "src/100% 文档 [1].txt";
    const reference = formatSourceReference(target);
    assert.deepEqual(sourceReferences(reference), [
      { name: "100% 文档 [1].txt", reference: encodeURI(target) },
    ]);
    assert.deepEqual(
      sourceReferences(
        "`hi.txt` plain.txt [remote](<https://example.com>) [unsafe](<javascript:alert(1)>)",
      ),
      [],
    );
    const first = manager.appendMessage({
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: reference }, image],
    });
    manager.appendMessage({
      role: "assistant",
      timestamp: 2,
      content: [{ type: "text", text: "[Generated](<generated.txt>)" }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "user",
      timestamp: 3,
      content: "[Off branch](<off-branch.txt>)",
    });
    manager.branch(first);
    manager.appendMessage({ role: "user", timestamp: 4, content: reference });
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const result = collectSessionSources(reopened.getBranch());
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.sources.map(({ kind, name }) => ({ kind, name })),
      [
        { kind: "file", name: "100% 文档 [1].txt" },
        { kind: "image", name: "diagram.png" },
      ],
    );
    assert.ok(!JSON.stringify(result).includes(image.data));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved source names shorten only complete raw path labels before the display cap", () => {
  const manager = SessionManager.inMemory("/ws");
  const path = `/private/${"x".repeat(300)}/中文 100% [1].txt`;
  const custom = "custom " + "x".repeat(300);
  manager.appendMessage({
    role: "user",
    timestamp: 1,
    content: [
      {
        type: "text",
        text: `${formatSourceReference(path, path)}\n${formatSourceReference("custom.txt", custom)}\n[bad % path](<bad%path.txt>)`,
      },
    ],
  });
  const sources = collectSessionSources(manager.getBranch()).sources;
  assert.deepEqual(
    sources.map(({ name, reference }) => ({ name, reference })),
    [
      { name: "中文 100% [1].txt", reference: encodeURI(path) },
      { name: custom.slice(0, 255), reference: "custom.txt" },
      { name: "bad % path", reference: "bad%path.txt" },
    ],
  );
  assert.equal(Object.hasOwn(sources[0]!, "start"), false);
});

test("source HTTP reads authenticate, bind exact session/branch, and freeze pagination", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-sources-http-"));
  const manager = SessionManager.inMemory(cwd);
  const first = manager.appendMessage({
    role: "user",
    timestamp: 1,
    content: [image],
  });
  for (let index = 0; index < 51; index++)
    manager.appendMessage({
      role: "user",
      timestamp: index + 2,
      content: formatSourceReference(`file-${index}.txt`),
    });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionManager: manager,
    sessionDirectory: cwd,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    subscribe: () => () => undefined,
    dispose: async () => undefined,
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    setModel: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const headers = {
      Authorization: `Bearer ${new URL(host.url).hash.slice("#token=".length)}`,
    };
    const sessions = (await (
      await fetch(`${host.origin}/api/sessions`, { headers })
    ).json()) as { sessions: { id: string; path: string }[] };
    const session = sessions.sessions.find(
      (entry) => entry.id === manager.getSessionId(),
    )!;
    const query = new URLSearchParams({
      sessionId: session.id,
      path: session.path,
    });
    const endpoint = `${host.origin}/api/session-sources`;
    assert.equal((await fetch(`${endpoint}?${query}`)).status, 401);
    assert.equal(
      (await fetch(`${endpoint}?${query}&offset=50`, { headers })).status,
      400,
    );
    assert.equal(
      (await fetch(`${endpoint}?${query}&path=duplicate`, { headers })).status,
      400,
    );
    const bad = new URLSearchParams({ sessionId: "wrong", path: session.path });
    assert.equal((await fetch(`${endpoint}?${bad}`, { headers })).status, 404);
    const page = (await (
      await fetch(`${endpoint}?${query}`, { headers })
    ).json()) as WebSessionSources;
    assert.equal(page.sources.length, 50);
    assert.equal(page.nextOffset, 50);
    const second = (await (
      await fetch(`${endpoint}?${query}&offset=50&revision=${page.revision}`, {
        headers,
      })
    ).json()) as WebSessionSources;
    assert.equal(second.sources.length, 2);
    assert.equal(second.sources[1]?.name, "diagram.png");
    assert.equal(
      (
        await fetch(`${endpoint}/image?${query}&entryId=${first}&part=1`, {
          headers,
        })
      ).status,
      404,
    );
    assert.deepEqual(
      await (
        await fetch(`${endpoint}/image?${query}&entryId=${first}&part=0`, {
          headers,
        })
      ).json(),
      { mimeType: image.mimeType, data: image.data },
    );
    const maximum = Buffer.alloc(WEB_PROMPT_IMAGE_MAX_BYTES, 127).toString(
      "base64",
    );
    const large = manager.appendMessage({
      role: "user",
      timestamp: 98,
      content: [
        { type: "text", text: "large source" },
        { ...image, data: maximum },
      ],
    });
    const largeResponse = await fetch(
      `${endpoint}/image?${query}&entryId=${large}&part=1`,
      { headers },
    );
    assert.equal(
      largeResponse.status,
      200,
      largeResponse.status === 200 ? "HTTP 200" : await largeResponse.text(),
    );
    assert.deepEqual(await largeResponse.json(), {
      mimeType: image.mimeType,
      data: maximum,
    });
    for (const target of [
      new URLSearchParams({ sessionId: "wrong", path: session.path }),
      new URLSearchParams({
        sessionId: session.id,
        path: `${session.path}.wrong`,
      }),
    ]) {
      const denied = await fetch(
        `${endpoint}/image?${target}&entryId=${large}&part=1`,
        { headers },
      );
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), {
        error: "Session source unavailable",
      });
    }
    assert.equal(
      (await fetch(`${endpoint}/image?${query}&entryId=${large}&part=1`))
        .status,
      401,
    );
    for (const data of [
      Buffer.alloc(WEB_PROMPT_IMAGE_MAX_BYTES + 1).toString("base64"),
      "aGk",
      "aGk=\n",
      "!!!!",
      "aGl=",
    ]) {
      const invalid = manager.appendMessage({
        role: "user",
        timestamp: 98,
        content: [{ ...image, data }],
      });
      assert.equal(
        (
          await fetch(`${endpoint}/image?${query}&entryId=${invalid}&part=0`, {
            headers,
          })
        ).status,
        404,
      );
    }
    manager.appendMessage({ role: "user", timestamp: 99, content: "next" });
    assert.equal(
      (
        await fetch(
          `${endpoint}?${query}&offset=50&revision=${page.revision}`,
          { headers },
        )
      ).status,
      409,
    );
    manager.resetLeaf();
    manager.appendMessage({
      role: "user",
      timestamp: 100,
      content: "different branch",
    });
    assert.equal(
      (
        await fetch(`${endpoint}/image?${query}&entryId=${first}&part=0`, {
          headers,
        })
      ).status,
      404,
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
