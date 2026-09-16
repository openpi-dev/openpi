import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";

/**
 * Shared identity for the hermetic provider round-trip end-to-end test.
 *
 * The Playwright config seeds `models.json` with `PROVIDER_BASE_URL` before the
 * backend starts, and this module starts the matching fake OpenAI-compatible
 * server inside the Playwright test process.
 */
export const PROVIDER_PORT = 57_110;
export const WEB_PORT = 57_111;
export const WEB_TOKEN =
  "6f70656e70692d7765622d70726f76696465722d6532652d746f6b656e212121";
export const PROVIDER_ID = "fake-provider";
export const MODEL_ID = "fake-reasoner";
export const MODEL_NAME = "Fake Reasoner";
export const PROVIDER_BASE_URL = `http://127.0.0.1:${PROVIDER_PORT}/v1`;

export type RecordedProviderRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

/** Write the deterministic agent-dir configuration for the fake provider. */
export function seedAgentDirectory(agentDirectory: string) {
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    join(agentDirectory, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: PROVIDER_BASE_URL,
            apiKey: "test-provider-key",
            api: "openai-completions",
            models: [
              {
                id: MODEL_ID,
                name: MODEL_NAME,
                reasoning: true,
                thinkingLevelMap: {
                  minimal: null,
                  medium: null,
                  xhigh: null,
                },
                compat: { supportsReasoningEffort: true },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  // Start below `high` so selecting `high` in the UI is a real change that must
  // reach the provider, rather than a no-op against the initial clamped level.
  writeFileSync(
    join(agentDirectory, "settings.json"),
    `${JSON.stringify({ defaultThinkingLevel: "off" }, null, 2)}\n`,
  );
}

export type FakeProvider = {
  readonly requests: RecordedProviderRequest[];
  /** Hold the next response until {@link release} settles it. */
  holdNextResponse(): void;
  /** Release a held response so the turn can settle. */
  release(): void;
  close(): Promise<void>;
};

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function chatCompletionStreamResponse(modelId: string) {
  const envelope = (choices: unknown[]) => ({
    id: "chatcmpl-openpi-provider-e2e",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: modelId,
    choices,
  });
  const chunks = [
    envelope([
      {
        index: 0,
        delta: { role: "assistant", content: "Thinking level acknowledged." },
        finish_reason: null,
      },
    ]),
    envelope([{ index: 0, delta: {}, finish_reason: "stop" }]),
  ];
  return `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

/**
 * Start a loopback OpenAI-compatible chat-completions server that records every
 * request and answers with a minimal valid streamed completion.
 */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedProviderRequest[] = [];
  let pendingRelease: (() => void) | undefined;
  let holdRequested = false;

  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body: unknown;
    try {
      const raw = await readBody(request);
      body = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    requests.push({
      method: request.method,
      path,
      headers: request.headers,
      body,
    });
    if (holdRequested) {
      holdRequested = false;
      await new Promise<void>((resolve) => {
        pendingRelease = resolve;
      });
    }
    const modelId =
      typeof (body as { model?: unknown } | undefined)?.model === "string"
        ? (body as { model: string }).model
        : MODEL_ID;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.end(chatCompletionStreamResponse(modelId));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROVIDER_PORT, "127.0.0.1", resolve);
  });

  return {
    requests,
    holdNextResponse() {
      holdRequested = true;
    },
    release() {
      const release = pendingRelease;
      pendingRelease = undefined;
      release?.();
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        // Never let a held response (from a failed assertion) block teardown.
        pendingRelease?.();
        pendingRelease = undefined;
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
