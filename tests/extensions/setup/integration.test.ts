import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("real Pi provider snapshots setup writer before the first call and records no-op closure", {
  timeout: 20_000,
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
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";

const cwd = process.env.OPENPI_TEST_CWD;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const extensionPaths = JSON.parse(process.env.OPENPI_TEST_EXTENSION_PATHS);
const snapshots = [];
const capture = (context) => ({
  tools: context.tools?.map(({ name }) => ({ name })),
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
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model: faux.getModel(),
  modelRuntime,
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
});
try {
  await session.bindExtensions({ mode: "print" });
  await session.prompt("/openpi-setup keep everything unchanged");
  await session.waitForIdle();
  await session.prompt("What happened in setup?");
  await session.waitForIdle();
  await session.prompt("/openpi-setup disable suggestions");
  await session.waitForIdle();
  const config = JSON.parse(await readFile(agentDir + "/my-pi-setup.json", "utf8"));
  process.stdout.write(JSON.stringify({ snapshots, active: session.getActiveToolNames(), config }));
} finally {
  session.dispose();
}
`;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        timeout: 8_000,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          OPENPI_TEST_CWD: cwd,
          OPENPI_TEST_EXTENSION_PATHS: JSON.stringify(extensionPaths),
        },
      },
    );
    const result = JSON.parse(stdout) as {
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
      config: { suggestions: { enabled: boolean } };
    };
    assert.equal(result.snapshots.length, 4);
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
    assert.equal(result.active.includes("configure_my_pi_setup"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
