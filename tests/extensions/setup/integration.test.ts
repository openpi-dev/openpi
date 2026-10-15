import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("real Pi provider snapshots setup writer across closed and successfully applied episodes", {
  timeout: 30_000,
}, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-setup-integration-"));
  const agentDir = path.join(cwd, "agent");
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const extensionPaths = [
    fileURLToPath(
      new URL("../../../extensions/ask-user/index.ts", import.meta.url),
    ),
    fileURLToPath(
      new URL("../../../extensions/setup/index.ts", import.meta.url),
    ),
  ];
  const script = `
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";

const cwd = process.env.OPENPI_TEST_CWD;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const extensionPaths = JSON.parse(process.env.OPENPI_TEST_EXTENSION_PATHS);
const snapshots = [];
const capture = (context) => ({
  tools: getCurrentTools(context.messages).map(({ name }) => ({ name })),
  messages: context.messages.map(({ role, content, toolName, isError }) => ({
    role,
    content,
    toolName,
    isError,
  })),
});
const faux = fauxProvider({
  api: "openpi-setup-integration",
  provider: "openpi-setup-fixture",
  models: [{ id: "fixture", name: "Fixture", reasoning: false }],
});
faux.setResponses([
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage("Keep the current settings.");
  },
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage("Acknowledged.");
  },
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage(
      [
        fauxToolCall("configure_my_pi_setup", { suggestions_enabled: false }, { id: "apply-first" }),
        fauxToolCall("configure_my_pi_setup", { suggestions_enabled: true }, { id: "apply-first" }),
      ],
      { stopReason: "toolUse" },
    );
  },
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage("Setup finished.");
  },
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage(
      [fauxToolCall("configure_my_pi_setup", { ui_web_theme: "dark" }, { id: "apply-next" })],
      { stopReason: "toolUse" },
    );
  },
  (context) => {
    snapshots.push(capture(context));
    return fauxAssistantMessage("Next setup finished.");
  },
]);
const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
const modelRuntime = await ModelRuntime.create({
  authPath: agentDir + "/auth.json",
  modelsPath: agentDir + "/models.json",
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey("openpi-setup-fixture", "fixture-key");
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: extensionPaths });
await loader.reload();
// Both configuration and persisted sessions belong to the test-owned cwd.
const sessionDir = cwd + "/sessions";
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model: faux.getModel(),
  modelRuntime,
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.create(cwd, sessionDir),
});
try {
  await session.bindExtensions({ mode: "print" });
  await session.prompt("/openpi-setup keep everything unchanged");
  await session.waitForIdle();
  await session.prompt("What happened in setup?");
  await session.waitForIdle();
  await session.prompt("/openpi-setup disable suggestions");
  await session.waitForIdle();
  await session.prompt("/openpi-setup use dark theme");
  await session.waitForIdle();
  const config = JSON.parse(await readFile(agentDir + "/my-pi-setup.json", "utf8"));
  const requests = (messages) => messages.filter((message) => message.role === "custom" && message.customType === "openpi-setup-request");
  const runtimeRequests = requests(session.messages);
  const sessionFile = session.sessionManager.getSessionFile();
  const reopened = SessionManager.open(sessionFile);
  const restoredRequests = requests(reopened.buildSessionContext().messages);
  const htmlPath = await session.exportToHtml(cwd + "/session.html");
  const html = await readFile(htmlPath, "utf8");
  const encoded = html.match(/<script id="session-data" type="application\\/json">([^<]+)<\\/script>/)[1];
  const exported = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const exportedRequests = exported.entries.filter((entry) => entry.type === "custom_message" && entry.customType === "openpi-setup-request");
  process.stdout.write(JSON.stringify({ snapshots, active: session.getActiveToolNames(), config, sessionFile, runtimeRequests, restoredRequests, exportedRequests }) + "\\n");
  // Exercise the supported RPC host with the real setup renderer registered.
  // get_messages must return full content, never the collapsed TUI projection.
  const runtime = new AgentSessionRuntime(
    session,
    { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] },
    async () => { throw new Error("Unexpected session replacement in export fixture"); },
  );
  await runRpcMode(runtime);
} finally {
  session.dispose();
}
`;

  try {
    const subprocess = execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        timeout: 15_000,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          OPENPI_TEST_CWD: cwd,
          OPENPI_TEST_EXTENSION_PATHS: JSON.stringify(extensionPaths),
        },
      },
    );
    assert.ok(subprocess.child.stdin);
    subprocess.child.stdin.end(
      `${JSON.stringify({ id: "setup-messages", type: "get_messages" })}\n`,
    );
    const { stdout } = await subprocess;
    const [fixtureLine, ...rpcLines] = stdout.trim().split("\n");
    const result = JSON.parse(fixtureLine) as {
      snapshots: Array<{
        messages: Array<{
          role: string;
          content: unknown;
          toolName?: string;
          isError?: boolean;
        }>;
        tools?: Array<{ name: string }>;
      }>;
      active: string[];
      sessionFile: string;
      config: { suggestions: { enabled: boolean }; ui: { webTheme: string } };
      runtimeRequests: Array<{
        content: string;
        display: boolean;
        details: unknown;
      }>;
      restoredRequests: Array<{
        content: string;
        display: boolean;
        details: unknown;
      }>;
      exportedRequests: Array<{
        content: string;
        display: boolean;
        details: unknown;
      }>;
    };
    const rpcResponse = rpcLines
      .map((line) => JSON.parse(line))
      .find(({ id }) => id === "setup-messages") as {
      command: string;
      success: boolean;
      data: {
        messages: Array<{
          role: string;
          customType?: string;
          content: string;
          display: boolean;
          details: unknown;
        }>;
      };
    };
    assert.ok(rpcResponse);
    assert.equal(rpcResponse.command, "get_messages");
    assert.equal(rpcResponse.success, true);
    const rpcRequests = rpcResponse.data.messages.filter(
      ({ role, customType }) =>
        role === "custom" && customType === "openpi-setup-request",
    );
    assert.equal(path.dirname(result.sessionFile), path.join(cwd, "sessions"));
    await access(result.sessionFile);
    assert.equal(result.snapshots.length, 6);
    assert.equal(result.runtimeRequests.length, 3);
    const executionPayloads = (requests: typeof result.runtimeRequests) =>
      requests.map(({ content, display, details }) => ({
        content,
        display,
        details,
      }));
    assert.deepEqual(
      executionPayloads(result.restoredRequests),
      executionPayloads(result.runtimeRequests),
    );
    assert.deepEqual(
      executionPayloads(rpcRequests),
      executionPayloads(result.runtimeRequests),
      "the RPC/JSON wire must retain full setup content and display metadata",
    );
    for (const [index, request] of result.runtimeRequests.entries()) {
      const exported = result.exportedRequests[index];
      assert.ok(exported);
      assert.equal(exported.content, request.content);
      assert.equal(exported.display, true);
      assert.deepEqual(exported.details, request.details);
      assert.match(request.content, /Current configuration:/);
      assert.match(request.content, /configure_my_pi_setup/);
    }
    assert.equal(result.exportedRequests.length, 3);
    assert.ok(
      result.snapshots[0]?.tools?.some(
        ({ name }) => name === "configure_my_pi_setup",
      ),
      "the first provider snapshot must include the setup writer",
    );
    assert.equal(
      result.snapshots[1]?.tools?.some(
        ({ name }) => name === "configure_my_pi_setup",
      ),
      false,
      "the next provider snapshot must hide the setup writer",
    );
    assert.match(
      JSON.stringify(result.snapshots[1]?.messages),
      /configuration writer is now hidden/i,
    );
    assert.match(
      JSON.stringify(result.snapshots[1]?.messages),
      /no configuration update was confirmed/i,
    );
    assert.match(
      JSON.stringify(result.snapshots[1]?.messages),
      /do not edit configuration files directly/i,
    );
    assert.ok(
      result.snapshots[2]?.tools?.some(
        ({ name }) => name === "configure_my_pi_setup",
      ),
    );
    const writerResults = result.snapshots[3]?.messages.filter(
      ({ role, toolName }) =>
        role === "toolResult" && toolName === "configure_my_pi_setup",
    );
    assert.deepEqual(
      writerResults?.map(({ isError }) => isError).sort(),
      [false, true],
      "one parallel call must execute and the other must be blocked",
    );
    assert.equal(result.config.suggestions.enabled, false);
    assert.equal(result.config.ui.webTheme, "dark");
    assert.ok(
      result.snapshots[4]?.tools?.some(
        ({ name }) => name === "configure_my_pi_setup",
      ),
      "the next setup after a successful apply must expose its own writer",
    );
    const nextRequest = result.snapshots[4]?.messages
      .filter(({ role }) => role === "user")
      .at(-1);
    assert.match(
      JSON.stringify(nextRequest?.content),
      /A new OpenPI setup episode has started/,
    );
    assert.match(
      JSON.stringify(nextRequest?.content),
      /Earlier success or closure messages apply only to their earlier episodes/,
    );
    assert.match(
      JSON.stringify(result.snapshots[4]?.messages),
      /Do not call it again within this completed episode/,
    );
    assert.equal(
      result.snapshots[5]?.messages.filter(
        ({ role, toolName, isError }) =>
          role === "toolResult" &&
          toolName === "configure_my_pi_setup" &&
          !isError,
      ).length,
      2,
      "each setup episode must apply once even with a prior success in context",
    );
    assert.equal(result.active.includes("configure_my_pi_setup"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await assert.rejects(access(cwd), { code: "ENOENT" });
  }
});
