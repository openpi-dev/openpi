import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import multiSignalSync from "./index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Message = {
  role: string;
  content: string | Array<{ type: string; text: string }>;
};

function harness() {
  const handlers = new Map<string, Handler[]>();
  const statuses: Array<string | undefined> = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus(_key: string, value?: string) {
        statuses.push(value);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  multiSignalSync(pi);

  const emit = async (event: string, value: unknown = {}) => {
    let current = value;
    for (const handler of handlers.get(event) ?? []) {
      const result = await handler(current, ctx);
      if (
        event === "context" &&
        result &&
        typeof result === "object" &&
        "messages" in result
      ) {
        current = {
          ...(current as object),
          messages: (result as { messages: unknown }).messages,
        };
      }
    }
    return current as { messages?: Message[] };
  };
  return { emit, statuses };
}

function injectedText(messages: Message[] | undefined): string {
  const content = messages?.at(-1)?.content;
  return Array.isArray(content)
    ? content.map((block) => block.text).join("\n")
    : String(content ?? "");
}

test("authorization is consumed once for one user message", async () => {
  const h = harness();
  const messages: Message[] = [{ role: "user", content: "我同意这个变更" }];
  const first = await h.emit("context", { messages });
  assert.match(injectedText(first.messages), /业主授权/);

  const second = await h.emit("context", { messages });
  assert.equal(second.messages, messages);
});

test("negated authorization does not trigger", async () => {
  for (const content of [
    "我不同意这个变更",
    "我未同意这个变更",
    "这个操作未经授权",
    "not approved",
    "文档示例是“我同意这个变更”",
  ]) {
    const h = harness();
    const messages: Message[] = [{ role: "user", content }];
    const result = await h.emit("context", { messages });
    assert.equal(result.messages, messages);
  }
});

test("a new authorization message can trigger after the previous one", async () => {
  const h = harness();
  const first: Message[] = [{ role: "user", content: "我同意方案 A" }];
  await h.emit("context", { messages: first });

  const second: Message[] = [
    ...first,
    { role: "user", content: "我批准方案 B" },
  ];
  const result = await h.emit("context", { messages: second });
  assert.match(injectedText(result.messages), /业主授权/);
});

test("command detection ignores quoted examples and dry runs", async () => {
  for (const command of [
    'echo "git commit -m test"',
    'echo "example; git commit -m test"',
    "git commit --dry-run",
    'echo "tsc --noEmit"',
    'printf -- "--test"',
  ]) {
    const h = harness();
    await h.emit("tool_result", {
      toolName: "bash",
      isError: false,
      input: { command },
    });
    await h.emit("agent_settled");
    assert.equal(h.statuses.length, 0, command);
  }
});

test("failed verification does not trigger", async () => {
  const h = harness();
  await h.emit("tool_result", {
    toolName: "bash",
    isError: true,
    input: { command: "bun run test" },
  });
  await h.emit("agent_settled");
  assert.equal(h.statuses.length, 0);
});

test("session shutdown clears a persistent footer status", async () => {
  const h = harness();
  await h.emit("tool_result", {
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m test" },
  });
  await h.emit("agent_settled");
  assert.match(h.statuses.at(-1) ?? "", /commit/);

  await h.emit("session_shutdown");
  assert.equal(h.statuses.at(-1), undefined);
});
