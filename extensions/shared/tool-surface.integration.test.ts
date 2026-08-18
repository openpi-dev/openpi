import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type InlineExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createCapabilitiesExtension } from "../capabilities/index.ts";
import {
  DEFAULT_OPENPI_ACTIVE_TOOL_NAMES,
  OPENPI_TOOL_SURFACE,
  OPENPI_TOOL_SURFACE_NAMES,
  patchOwnedTools,
} from "./tool-surface.ts";

async function withSession(
  factories: InlineExtension[],
  run: (
    session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  ) => Promise<void>,
  additionalExtensionPaths: string[] = [],
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-tool-surface-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths,
    extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await run(session);
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

const extensionPath = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));
const CAPABILITIES_EXTENSION = extensionPath("../capabilities/index.ts");
const SUBAGENTS_EXTENSION = extensionPath("../subagents/index.ts");
const BACKGROUND_EXTENSION = extensionPath("../background-terminals/index.ts");
const PLAN_EXTENSION = extensionPath("../plan-mode/index.ts");
const OPENPI_EXTENSION_PATHS = [
  extensionPath("../ask-user/index.ts"),
  BACKGROUND_EXTENSION,
  CAPABILITIES_EXTENSION,
  "../context-pivot/index.ts",
  "../file-search/index.ts",
  "../goal/index.ts",
  PLAN_EXTENSION,
  "../setup/index.ts",
  SUBAGENTS_EXTENSION,
  "../tasks/index.ts",
  "../workflows/index.ts",
].map((entry) => (path.isAbsolute(entry) ? entry : extensionPath(entry)));
const OPENPI_EXTENSION_PATHS_WITHOUT_CAPABILITIES =
  OPENPI_EXTENSION_PATHS.filter((entry) => entry !== CAPABILITIES_EXTENSION);
const EXPLICIT_CAPABILITIES_FACTORY = createCapabilitiesExtension({
  loadConfig: () => ({ capabilities: { discovery: "explicit" } }),
  sourcePath: "<inline:openpi-capabilities-explicit-test>",
});
const EXPLICIT_CAPABILITIES_EXTENSION: InlineExtension = {
  name: "openpi-capabilities-explicit-test",
  factory: EXPLICIT_CAPABILITIES_FACTORY,
};

const execFileAsync = promisify(execFile);

async function createSessionSnapshot(
  cwd: string,
  agentDir: string,
  additionalExtensionPaths: string[],
  extensionFactories: InlineExtension[] = [],
) {
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths,
    extensionFactories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    const active = session.getActiveToolNames();
    const activeSet = new Set(active);
    return {
      active,
      systemPrompt: session.systemPrompt,
      tools: session
        .getAllTools()
        .filter(({ name }) => activeSet.has(name))
        .map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
    };
  } finally {
    session.dispose();
  }
}

test("ordinary OpenPI requests match Bare Pi's resident prompt and tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-zero-resident-"));
  const cwd = path.join(root, "candidate");
  await mkdir(cwd, { recursive: true });
  try {
    const bare = await createSessionSnapshot(
      cwd,
      path.join(root, "bare-agent"),
      [],
    );
    const openPi = await createSessionSnapshot(
      cwd,
      path.join(root, "openpi-agent"),
      OPENPI_EXTENSION_PATHS_WITHOUT_CAPABILITIES,
      [EXPLICIT_CAPABILITIES_EXTENSION],
    );

    assert.deepEqual(openPi, bare);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi adaptive discovery exposes only the gateway", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-adaptive-discovery-"));
  const cwd = path.join(root, "candidate");
  await mkdir(cwd, { recursive: true });
  try {
    const agentDir = path.join(root, "openpi-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "my-pi-setup.json"),
      `${JSON.stringify({ capabilities: { discovery: "adaptive" } }, null, 2)}\n`,
    );
    const script = `
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
const cwd = process.env.OPENPI_TEST_CWD;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const extensionPaths = JSON.parse(process.env.OPENPI_TEST_EXTENSION_PATHS);
const settingsManager = SettingsManager.inMemory(undefined, { projectTrusted: false });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: extensionPaths });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
try {
  await session.bindExtensions({ mode: "print" });
  process.stdout.write(JSON.stringify(session.getActiveToolNames()));
} finally {
  session.dispose();
}
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          OPENPI_TEST_CWD: cwd,
          OPENPI_TEST_EXTENSION_PATHS: JSON.stringify(OPENPI_EXTENSION_PATHS),
        },
      },
    );
    const active = JSON.parse(stdout) as string[];
    const managedNames = new Set<string>(OPENPI_TOOL_SURFACE_NAMES);
    assert.deepEqual(
      active.filter((name) => managedNames.has(name)),
      ["openpi_load_tools"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi session starts with the compact OpenPI parent surface", async () => {
  await withSession(
    [EXPLICIT_CAPABILITIES_EXTENSION],
    async (session) => {
      const active = session.getActiveToolNames();
      const defaultOpenPiTools = new Set<string>(
        DEFAULT_OPENPI_ACTIVE_TOOL_NAMES,
      );
      for (const builtin of ["read", "bash", "edit", "write"]) {
        assert.ok(active.includes(builtin), `${builtin} should stay active`);
      }
      assert.deepEqual(
        active.filter((name) => defaultOpenPiTools.has(name)).sort(),
        [...DEFAULT_OPENPI_ACTIVE_TOOL_NAMES].sort(),
      );
      for (const deferred of Object.values(OPENPI_TOOL_SURFACE).flatMap(
        ({ deferred }) => [...deferred],
      )) {
        assert.equal(
          active.includes(deferred),
          false,
          `${deferred} should hide`,
        );
      }

      const allTools = session.getAllTools();
      const serializedToolChars = (tool: (typeof allTools)[number]) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines,
        }).length;
      const managedNames = new Set<string>(OPENPI_TOOL_SURFACE_NAMES);
      const compactToolChars = allTools
        .filter(({ name }) => managedNames.has(name) && active.includes(name))
        .reduce((total, tool) => total + serializedToolChars(tool), 0);
      const fullToolChars = allTools
        .filter(({ name }) => managedNames.has(name))
        .reduce((total, tool) => total + serializedToolChars(tool), 0);
      const reduction = 1 - compactToolChars / fullToolChars;
      const compactBreakdown = allTools
        .filter(({ name }) => managedNames.has(name) && active.includes(name))
        .map((tool) => `${tool.name}:${serializedToolChars(tool)}`)
        .join(", ");
      assert.ok(
        reduction >= 0.85,
        `default OpenPI tool surface should shrink by at least 85%, got ${(reduction * 100).toFixed(1)}% (${compactToolChars}/${fullToolChars} chars; ${compactBreakdown})`,
      );
    },
    OPENPI_EXTENSION_PATHS_WITHOUT_CAPABILITIES,
  );
});

test("real Pi session rebuilds tools and prompt after a capability and owner state activate its family", async () => {
  let controller: Parameters<ExtensionFactory>[0] | undefined;
  const controllerFactory: ExtensionFactory = (pi) => {
    controller = pi;
  };

  await withSession(
    [controllerFactory, EXPLICIT_CAPABILITIES_EXTENSION],
    async (session) => {
      const beforePrompt = session.systemPrompt;
      assert.ok(controller);
      assert.deepEqual(session.getActiveToolNames(), [
        "read",
        "bash",
        "edit",
        "write",
      ]);
      patchOwnedTools(controller, "subagents", {
        disable: OPENPI_TOOL_SURFACE.subagents.deferred,
      });

      const gateway = session.getToolDefinition("openpi_load_tools");
      assert.ok(gateway);
      await gateway.execute(
        "capability-1",
        { groups: ["delegate"] },
        undefined,
        undefined,
        session.createReplacedSessionContext(),
      );
      assert.deepEqual(session.getActiveToolNames(), [
        "read",
        "bash",
        "edit",
        "write",
        "subagent_spawn",
      ]);

      patchOwnedTools(controller, "subagents", {
        enable: OPENPI_TOOL_SURFACE.subagents.deferred,
      });

      assert.deepEqual(session.getActiveToolNames(), [
        "read",
        "bash",
        "edit",
        "write",
        "subagent_spawn",
        ...OPENPI_TOOL_SURFACE.subagents.deferred,
      ]);
      assert.notEqual(session.systemPrompt, beforePrompt);
    },
    [SUBAGENTS_EXTENSION],
  );
});

test("separate owner wrappers cannot remove each other's lifecycle tools", async () => {
  let controller: Parameters<ExtensionFactory>[0] | undefined;
  const controllerFactory: ExtensionFactory = (pi) => {
    controller = pi;
  };

  await withSession(
    [controllerFactory, EXPLICIT_CAPABILITIES_EXTENSION],
    async (session) => {
      assert.ok(controller);
      patchOwnedTools(controller, "subagents", {
        disable: ["subagent_wait"],
      });
      patchOwnedTools(controller, "background", {
        disable: ["bg_status"],
      });
      const gateway = session.getToolDefinition("openpi_load_tools");
      assert.ok(gateway);
      await gateway.execute(
        "capability-cross-owner",
        { groups: ["delegate", "background"] },
        undefined,
        undefined,
        session.createReplacedSessionContext(),
      );

      patchOwnedTools(controller, "subagents", {
        enable: ["subagent_wait"],
      });
      assert.ok(session.getActiveToolNames().includes("subagent_wait"));

      patchOwnedTools(controller, "background", { enable: ["bg_status"] });
      assert.ok(session.getActiveToolNames().includes("subagent_wait"));
      assert.ok(session.getActiveToolNames().includes("bg_status"));
    },
    [SUBAGENTS_EXTENSION, BACKGROUND_EXTENSION],
  );
});

test("filesystem ownership does not hide a first-registered foreign namesake", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "openpi-foreign-tool-source-"),
  );
  const foreignExtension = path.join(fixtureRoot, "foreign.mjs");
  await writeFile(
    foreignExtension,
    `export default function foreign(pi) {
  pi.registerTool({
    name: "plan_ready",
    label: "Foreign Plan Ready",
    description: "FOREIGN_SENTINEL",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "foreign" }], details: {} };
    },
  });
}
`,
  );

  try {
    await withSession(
      [],
      async (session) => {
        assert.ok(session.getActiveToolNames().includes("plan_ready"));
        const tool = session
          .getAllTools()
          .find(({ name }) => name === "plan_ready");
        assert.equal(tool?.description, "FOREIGN_SENTINEL");
        assert.equal(tool?.sourceInfo.path, foreignExtension);
      },
      [foreignExtension, PLAN_EXTENSION],
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
