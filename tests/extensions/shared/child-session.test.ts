import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  type SessionShutdownEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import capabilities from "../../../extensions/capabilities/index.ts";
import {
  bindChildSessionExtensions,
  CHILD_EXCLUDED_TOOL_NAMES,
  CHILD_SAFE_PACKAGE_TOOL_NAMES,
  childToolPolicy,
  createChildResources,
  type DisposableChildSession,
  effectiveChildToolAllowlist,
  resolveGitInfoPathOrThrow,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
} from "../../../extensions/shared/child-session.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("effective child allowlists never advertise parent-only tools", () => {
  assert.deepEqual(
    effectiveChildToolAllowlist([
      "read",
      "subagent_spawn",
      "bg_start",
      "ask_user",
      "human_handoff",
    ]),
    ["read"],
  );
  assert.deepEqual(effectiveChildToolAllowlist(["subagent_spawn"]), []);
  assert.equal(effectiveChildToolAllowlist(undefined), undefined);
  assert.deepEqual(childToolPolicy(["read", "subagent_spawn"]), {
    tools: ["read"],
    excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
  });
});

test("explicit child tools are checked against the final bound registry", async () => {
  await withTempDir(async (directory) => {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "fixture_extension_tool",
            label: "Fixture Extension Tool",
            description: "fixture",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: "ok" }],
                details: {},
              };
            },
          });
        },
      ],
    });
    await loader.reload();

    const create = async (tools: readonly string[]) => {
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: path.join(directory, "inline-agent"),
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        ...childToolPolicy(tools),
      });
      return session;
    };

    const available = await create(["read", "fixture_extension_tool"]);
    await bindChildSessionExtensions(available, [
      "read",
      "fixture_extension_tool",
    ]);
    assert.deepEqual(available.getActiveToolNames().sort(), [
      "fixture_extension_tool",
      "read",
    ]);
    await shutdownAndDisposeChildSession(available);

    const missing = await create(["read", "missing_fixture_tool"]);
    await assert.rejects(
      bindChildSessionExtensions(missing, ["read", "missing_fixture_tool"]),
      /Child tool preflight failed: requested tool "missing_fixture_tool" is unavailable after child extensions initialized/,
    );
    assert.equal(
      missing.messages.length,
      0,
      "preflight must run before prompt",
    );
    await shutdownAndDisposeChildSession(missing);

    const excluded = await create(["read", "subagent_spawn"]);
    await bindChildSessionExtensions(excluded, ["read", "subagent_spawn"]);
    assert.deepEqual(excluded.getActiveToolNames(), ["read"]);
    await shutdownAndDisposeChildSession(excluded);
  });
});

test("child binding restores only requested child-safe package tools after parent surface gating", async () => {
  await withTempDir(async (directory) => {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "capability-agent"),
      settingsManager,
      extensionFactories: [
        capabilities,
        (pi) => {
          for (const name of CHILD_SAFE_PACKAGE_TOOL_NAMES) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text" as const, text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await loader.reload();

    const create = async (tools?: readonly string[]) => {
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: path.join(directory, "capability-agent"),
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        ...childToolPolicy(tools),
      });
      await bindChildSessionExtensions(session, tools);
      return session;
    };

    const defaults = await create();
    assert.deepEqual(
      defaults
        .getActiveToolNames()
        .filter((name) =>
          (CHILD_SAFE_PACKAGE_TOOL_NAMES as readonly string[]).includes(name),
        )
        .sort(),
      [...CHILD_SAFE_PACKAGE_TOOL_NAMES].sort(),
    );
    assert.equal(
      defaults.getActiveToolNames().includes("openpi_load_tools"),
      false,
    );
    await shutdownAndDisposeChildSession(defaults);

    const narrowed = await create(["read"]);
    assert.equal(narrowed.getActiveToolNames().includes("fd"), false);
    assert.equal(narrowed.getActiveToolNames().includes("rg"), false);
    await shutdownAndDisposeChildSession(narrowed);
  });
});

test("child resources remove only verified parent-only OpenPI extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const extensionsDir = path.join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [fileURLToPath(new URL("../../../", import.meta.url))],
      }),
    );
    await writeFile(
      path.join(extensionsDir, "third-party.ts"),
      `export default function (pi) {
        pi.registerTool({
          name: "subagent_spawn",
          label: "Third-party subagent spawn",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; },
        });
      }`,
    );

    const { loader } = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const extensions = loader.getExtensions().extensions;

    assert.equal(
      extensions.some((extension) => extension.tools.has("openpi_load_tools")),
      false,
      "parent-only OpenPI extension should not reach the child runtime",
    );
    assert.equal(
      extensions.some((extension) => extension.tools.has("fd")),
      true,
      "child-safe OpenPI file-search extension should remain",
    );
    assert.equal(
      extensions.some((extension) => extension.tools.has("git_show")),
      true,
      "child-safe OpenPI git-read extension should remain",
    );
    assert.equal(
      extensions.some((extension) => extension.tools.has("subagent_spawn")),
      true,
      "ordinary third-party extensions must survive tool-name collisions",
    );
  });
});

test("production child binding skips foreign Workflow artifacts", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const runDir = path.join(agentDir, "workflows", "wf_f0e1");
    const artifactContents = [
      JSON.stringify({
        runId: "wf_f0e1",
        sessionId: "foreign-session",
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        agents: [],
        phases: [],
        resultArtifact: "result.json",
        transcriptArtifact: "transcripts.json",
      }),
      JSON.stringify({ result: "foreign result" }),
      JSON.stringify({}),
    ];
    const artifactPaths = new Set([
      path.join(runDir, "workflow.json"),
      path.join(runDir, "result.json"),
      path.join(runDir, "transcripts.json"),
    ]);
    let readCalls = 0;
    let readBytes = 0;
    let workflowParses = 0;
    const originalReadFileSync = fs.readFileSync;
    const originalJsonParse = JSON.parse;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [fileURLToPath(new URL("../../../", import.meta.url))],
      }),
    );
    await Promise.all(
      ["workflow.json", "result.json", "transcripts.json"].map((name, index) =>
        writeFile(path.join(runDir, name), artifactContents[index]!),
      ),
    );

    Object.defineProperty(fs, "readFileSync", {
      value: (...args: Parameters<typeof originalReadFileSync>) => {
        const content = originalReadFileSync(...args);
        const filePath = args[0];
        if (typeof filePath === "string" && artifactPaths.has(filePath)) {
          readCalls++;
          readBytes += Buffer.byteLength(
            typeof content === "string" ? content : content.toString(),
          );
        }
        return content;
      },
    });
    syncBuiltinESMExports();
    JSON.parse = (text, reviver) => {
      if (text === artifactContents[0]) {
        workflowParses++;
      }
      return originalJsonParse(text, reviver);
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const { loader, settingsManager } = await createChildResources({
        cwd,
        agentDir,
        projectTrusted: true,
      });
      const structuredOutput = defineTool({
        name: "structured_output",
        label: "Structured Output",
        description: "fixture structured result",
        parameters: Type.Object({ value: Type.String() }),
        async execute(_id, params) {
          return {
            content: [{ type: "text", text: params.value }],
            details: {},
          };
        },
      });
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
        customTools: [structuredOutput],
        ...childToolPolicy(),
      }));
      await bindChildSessionExtensions(session);

      assert.equal(
        session.getActiveToolNames().includes("structured_output"),
        true,
        "dynamically registered workflow output tool should remain available",
      );
      assert.equal(readCalls, 0);
      assert.equal(readBytes, 0);
      assert.equal(workflowParses, 0);
    } finally {
      if (session) await shutdownAndDisposeChildSession(session);
      Object.defineProperty(fs, "readFileSync", {
        value: originalReadFileSync,
      });
      syncBuiltinESMExports();
      JSON.parse = originalJsonParse;
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
    }
  });
});

test("child denylist keeps extension and workflow structured tools available", async () => {
  await withTempDir(async (directory) => {
    let starts = 0;
    let shutdowns = 0;
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            starts++;
          });
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
          for (const name of [
            "fixture_extension_tool",
            ...CHILD_EXCLUDED_TOOL_NAMES,
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();

    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture structured result",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: {},
        };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);

    const allTools = new Set(session.getAllTools().map((tool) => tool.name));
    const activeTools = new Set(session.getActiveToolNames());
    assert.equal(starts, 1);
    assert.equal(allTools.has("fixture_extension_tool"), true);
    assert.equal(activeTools.has("fixture_extension_tool"), true);
    assert.equal(allTools.has("structured_output"), true);
    assert.equal(activeTools.has("structured_output"), true);
    for (const denied of CHILD_EXCLUDED_TOOL_NAMES) {
      assert.equal(allTools.has(denied), false, `${denied} should be denied`);
      assert.equal(
        activeTools.has(denied),
        false,
        `${denied} should be inactive`,
      );
    }
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(
        activeTools.has(builtin),
        true,
        `${builtin} should stay active`,
      );
    }

    await Promise.all([
      shutdownAndDisposeChildSession(session),
      shutdownAndDisposeChildSession(session),
    ]);
    assert.equal(shutdowns, 1);
  });
});

test("child resources exclude pi-intercom npm, Git, and local packages without matching ordinary project paths", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const npmPackageDir = path.join(
      agentDir,
      "npm",
      "node_modules",
      "pi-intercom",
    );
    const gitPackageDir = path.join(
      agentDir,
      "git",
      "github.com",
      "nicobailon",
      "pi-intercom",
    );
    const localPackageDir = path.join(directory, "local-package-checkout");
    const singleFilePackageDir = path.join(directory, "single-file-checkout");
    const singleFileSource = path.join(
      singleFilePackageDir,
      "extensions",
      "intercom.ts",
    );
    const manifestlessLocalPackageDir = path.join(
      directory,
      "manifestless",
      "ordinary-package",
    );
    const projectIntercomDir = path.join(
      cwd,
      ".pi",
      "extensions",
      "pi-intercom",
    );
    await mkdir(projectIntercomDir, { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "skills", "global-fixture"), {
      recursive: true,
    });
    await mkdir(path.join(cwd, ".pi", "skills", "pi-intercom"), {
      recursive: true,
    });
    const extensionSource = (names: string[], executionMarker?: string) => {
      const executionSideEffect = executionMarker
        ? `writeFileSync(${JSON.stringify(executionMarker)}, "executed");`
        : "";
      return `
        import { writeFileSync } from "node:fs";
        export default function (pi) {
          ${executionSideEffect}
          for (const name of ${JSON.stringify(names)}) pi.registerTool({
            name, label: name, description: "fixture",
            parameters: { type: "object", properties: {} },
            async execute() { return { content: [{ type: "text", text: "ok" }] }; }
          });
        }
      `;
    };
    const writeIntercomPackage = async (packageDir: string, suffix: string) => {
      const executionMarker = path.join(directory, `${suffix}-executed`);
      await mkdir(path.join(packageDir, "skills", suffix), { recursive: true });
      await writeFile(
        path.join(packageDir, "index.ts"),
        extensionSource([`intercom_${suffix}`], executionMarker),
      );
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "pi-intercom",
          version: "0.10.0",
          pi: {
            extensions: ["./index.ts"],
            skills: ["./skills"],
          },
        }),
      );
      await writeFile(
        path.join(packageDir, "skills", suffix, "SKILL.md"),
        `---\nname: intercom-${suffix}\ndescription: fixture\n---\n`,
      );
      return executionMarker;
    };
    const writeManifestlessOrdinaryPackage = async () => {
      const executionMarker = path.join(directory, "manifestless-executed");
      await Promise.all([
        mkdir(path.join(manifestlessLocalPackageDir, "extensions"), {
          recursive: true,
        }),
        mkdir(
          path.join(manifestlessLocalPackageDir, "skills", "manifestless"),
          {
            recursive: true,
          },
        ),
      ]);
      await writeFile(
        path.join(manifestlessLocalPackageDir, "extensions", "index.ts"),
        extensionSource(["ordinary_manifestless"], executionMarker),
      );
      await writeFile(
        path.join(
          manifestlessLocalPackageDir,
          "skills",
          "manifestless",
          "SKILL.md",
        ),
        "---\nname: ordinary-manifestless\ndescription: fixture\n---\n",
      );
      return executionMarker;
    };
    const writeSingleFileIntercomPackage = async () => {
      const executionMarker = path.join(directory, "single-file-executed");
      await mkdir(path.dirname(singleFileSource), { recursive: true });
      await writeFile(
        singleFileSource,
        extensionSource(["intercom_single_file"], executionMarker),
      );
      await writeFile(
        path.join(singleFilePackageDir, "package.json"),
        JSON.stringify({ name: "pi-intercom", version: "0.10.0" }),
      );
      return executionMarker;
    };
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource(["global_fixture", "intercom"]),
    );
    await writeFile(
      path.join(projectIntercomDir, "index.ts"),
      extensionSource(["project_intercom_path_fixture"]),
    );
    await writeFile(
      path.join(agentDir, "skills", "global-fixture", "SKILL.md"),
      "---\nname: global-fixture\ndescription: fixture\n---\n",
    );
    await writeFile(
      path.join(cwd, ".pi", "skills", "pi-intercom", "SKILL.md"),
      "---\nname: project-intercom-path-fixture\ndescription: fixture\n---\n",
    );
    const [
      npmMarker,
      gitMarker,
      localMarker,
      ordinaryMarker,
      singleFileMarker,
    ] = await Promise.all([
      writeIntercomPackage(npmPackageDir, "npm"),
      writeIntercomPackage(gitPackageDir, "git"),
      writeIntercomPackage(localPackageDir, "local"),
      writeManifestlessOrdinaryPackage(),
      writeSingleFileIntercomPackage(),
    ]);
    const executionMarkers = [
      npmMarker,
      gitMarker,
      localMarker,
      singleFileMarker,
    ];
    await writeFile(
      path.join(gitPackageDir, "package.json"),
      JSON.stringify({
        name: "renamed-package",
        version: "0.10.0",
        pi: {
          extensions: ["./index.ts"],
          skills: ["./skills"],
        },
      }),
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          "npm:pi-intercom@0.10.0",
          "git:github.com/nicobailon/pi-intercom@v0.10.0",
          localPackageDir,
          manifestlessLocalPackageDir,
          singleFileSource,
        ],
      }),
    );

    const packageSources = [
      "npm:pi-intercom@0.10.0",
      "git:github.com/nicobailon/pi-intercom@v0.10.0",
      localPackageDir,
      singleFileSource,
    ];
    const packageToolNames = [
      "intercom_npm",
      "intercom_git",
      "intercom_local",
      "intercom_single_file",
    ];
    const packageSkillNames = [
      "intercom-npm",
      "intercom-git",
      "intercom-local",
    ];

    const untrusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedExtensions = untrusted.loader.getExtensions().extensions;
    const untrustedTools = untrustedExtensions.flatMap((extension) => [
      ...extension.tools.keys(),
    ]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("intercom"), true);
    assert.equal(untrustedTools.includes("ordinary_manifestless"), true);
    assert.equal(
      untrustedTools.includes("project_intercom_path_fixture"),
      false,
    );
    for (const name of packageToolNames) {
      assert.equal(
        untrustedTools.includes(name),
        false,
        `${name} must be excluded`,
      );
    }
    for (const source of packageSources) {
      assert.equal(
        untrustedExtensions.some(
          (extension) => extension.sourceInfo.source === source,
        ),
        false,
        JSON.stringify(
          untrustedExtensions.map((extension) => extension.sourceInfo),
        ),
      );
    }
    for (const marker of executionMarkers) {
      await assert.rejects(
        readFile(marker),
        `${path.basename(marker)} proves a child imported pi-intercom`,
      );
    }
    assert.equal(await readFile(ordinaryMarker, "utf8"), "executed");

    const trusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedExtensions = trusted.loader.getExtensions().extensions;
    const trustedTools = trustedExtensions.flatMap((extension) => [
      ...extension.tools.keys(),
    ]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("intercom"), true);
    assert.equal(trustedTools.includes("ordinary_manifestless"), true);
    const ordinaryExtension = trustedExtensions.find((extension) =>
      extension.tools.has("ordinary_manifestless"),
    );
    assert.equal(ordinaryExtension?.sourceInfo.origin, "package");
    assert.equal(
      ordinaryExtension?.sourceInfo.source,
      manifestlessLocalPackageDir,
    );
    assert.equal(trustedTools.includes("project_intercom_path_fixture"), true);
    for (const name of packageToolNames) {
      assert.equal(
        trustedTools.includes(name),
        false,
        `${name} must be excluded`,
      );
    }
    for (const source of packageSources) {
      assert.equal(
        trustedExtensions.some(
          (extension) => extension.sourceInfo.source === source,
        ),
        false,
      );
    }
    for (const marker of executionMarkers) {
      await assert.rejects(
        readFile(marker),
        `${path.basename(marker)} proves a child imported pi-intercom`,
      );
    }

    const childSkills = trusted.loader.getSkills().skills;
    assert.equal(
      childSkills.some((skill) => skill.name === "global-fixture"),
      true,
    );
    assert.equal(
      childSkills.some(
        (skill) => skill.name === "project-intercom-path-fixture",
      ),
      true,
    );
    assert.equal(
      childSkills.some((skill) => skill.name === "ordinary-manifestless"),
      true,
    );
    const ordinarySkill = childSkills.find(
      (skill) => skill.name === "ordinary-manifestless",
    );
    assert.equal(ordinarySkill?.sourceInfo.origin, "package");
    assert.equal(ordinarySkill?.sourceInfo.source, manifestlessLocalPackageDir);
    for (const name of packageSkillNames) {
      assert.equal(
        childSkills.some((skill) => skill.name === name),
        false,
        `${name} must be excluded`,
      );
    }
    for (const source of packageSources) {
      assert.equal(
        childSkills.some((skill) => skill.sourceInfo.source === source),
        false,
      );
    }

    const topLevelSettings = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const topLevelLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: topLevelSettings,
    });
    await topLevelLoader.reload();
    const topLevelTools = topLevelLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    const topLevelSkills = topLevelLoader.getSkills().skills;
    assert.equal(topLevelTools.includes("ordinary_manifestless"), true);
    assert.equal(
      topLevelSkills.some((skill) => skill.name === "ordinary-manifestless"),
      true,
    );
    for (const name of packageToolNames) {
      assert.equal(
        topLevelTools.includes(name),
        true,
        `${name} must stay top-level`,
      );
    }
    for (const name of packageSkillNames) {
      assert.equal(
        topLevelSkills.some((skill) => skill.name === name),
        true,
        `${name} must stay top-level`,
      );
    }
    for (const marker of executionMarkers) {
      assert.equal(await readFile(marker, "utf8"), "executed");
    }
  });
});

test("headless child resources exclude OpenPI git polling at 1/8/64 retained sessions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const gitInfoPath = await realpath(
      fileURLToPath(
        new URL("../../../extensions/git-info/index.ts", import.meta.url),
      ),
    );
    const gitReadPath = await realpath(
      fileURLToPath(
        new URL("../../../extensions/git-read/index.ts", import.meta.url),
      ),
    );
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          {
            source: repoRoot,
            extensions: [`+${gitInfoPath}`, "extensions/git-read/index.ts"],
          },
        ],
      }),
    );

    const topLevelSettings = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    const topLevelLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: topLevelSettings,
    });
    await topLevelLoader.reload();
    const topLevelPaths = await Promise.all(
      topLevelLoader
        .getExtensions()
        .extensions.map((extension) => realpath(extension.resolvedPath)),
    );
    const topLevelPollers = topLevelPaths.filter(
      (extensionPath) => extensionPath === gitInfoPath,
    ).length;
    assert.equal(topLevelPollers, 1, "the parent loader must keep git-info");

    const child = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const childPaths = await Promise.all(
      child.loader
        .getExtensions()
        .extensions.map((extension) => realpath(extension.resolvedPath)),
    );
    const childPollers = childPaths.filter(
      (extensionPath) => extensionPath === gitInfoPath,
    ).length;
    const childPackageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: child.settingsManager,
    });
    const childPackagePaths = await childPackageManager.resolve(
      async () => "skip",
    );
    const childGitInfoResource = await Promise.all(
      childPackagePaths.extensions.map(async (resource) => ({
        ...resource,
        canonicalPath: await realpath(resource.path),
      })),
    ).then((resources) =>
      resources.find((resource) => resource.canonicalPath === gitInfoPath),
    );
    assert.equal(
      childGitInfoResource?.enabled,
      false,
      "the child package filter must disable git-info before import",
    );
    assert.equal(
      childPaths.includes(gitReadPath),
      true,
      "ordinary child-safe OpenPI extensions must remain loaded",
    );

    for (const retained of [1, 8, 64]) {
      assert.equal(
        retained * childPollers,
        0,
        `${retained} retained children must create no git-info pollers`,
      );
      assert.equal(
        retained * topLevelPollers,
        retained,
        "the parent-loader control must remain valid",
      );
    }

    for (const source of [gitInfoPath, path.dirname(gitInfoPath)]) {
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ extensions: [source] }),
      );
      const directSettings = SettingsManager.create(cwd, agentDir, {
        projectTrusted: true,
      });
      const directLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: directSettings,
      });
      await directLoader.reload();
      assert.deepEqual(directLoader.getExtensions().errors, []);
      const parentDirectPaths = await Promise.all(
        directLoader
          .getExtensions()
          .extensions.map((extension) => realpath(extension.resolvedPath)),
      );
      assert.equal(
        parentDirectPaths.includes(gitInfoPath),
        true,
        `parent source ${source} must load git-info as the control`,
      );
      const directChild = await createChildResources({
        cwd,
        agentDir,
        projectTrusted: true,
      });
      const directPaths = await Promise.all(
        directChild.loader
          .getExtensions()
          .extensions.map((extension) => realpath(extension.resolvedPath)),
      );
      assert.equal(
        directPaths.includes(gitInfoPath),
        false,
        `child source ${source} must not restore git-info`,
      );
    }

    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: repoRoot, extensions: [] }] }),
    );
    const disabledExtensionsChild = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(
      disabledExtensionsChild.loader.getExtensions().extensions,
      [],
      "an empty package extension filter must remain fully disabled",
    );
  });
});

test("nested manifestless packages are not mistaken for OpenPI", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const openPiCheckout = path.join(directory, "openpi-checkout");
    const ordinaryPackage = path.join(openPiCheckout, "ordinary-package");
    const ordinaryGitInfo = path.join(
      ordinaryPackage,
      "extensions",
      "git-info",
      "index.ts",
    );
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.dirname(ordinaryGitInfo), { recursive: true });
    await writeFile(
      path.join(openPiCheckout, "package.json"),
      JSON.stringify({ name: "@tt-a1i/openpi" }),
    );
    await writeFile(
      ordinaryGitInfo,
      `export default function (pi) {
        pi.registerCommand("ordinary-lg", { handler() {} });
      }`,
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [ordinaryPackage] }),
    );

    const child = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const childPaths = await Promise.all(
      child.loader
        .getExtensions()
        .extensions.map((extension) => realpath(extension.resolvedPath)),
    );
    assert.equal(childPaths.includes(await realpath(ordinaryGitInfo)), true);
  });
});

test("child package snapshot handles canonical and historical package Git sources offline", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const intercomSources = [
      "git:github:nicobailon/pi-intercom@feature/test",
      "git:github.com/nicobailon/pi-intercom@feature/test",
      "git:git@github.com:nicobailon/pi-intercom@feature/test",
    ];
    const openPiSources = [
      "git:github.com/openpi-dev/openpi",
      "git:github.com/tt-a1i/openpi",
    ];
    const ordinarySource = "npm:ordinary-missing-package@1.0.0";
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [...intercomSources, ...openPiSources, ordinarySource],
      }),
    );

    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    let child: Awaited<ReturnType<typeof createChildResources>>;
    try {
      child = await createChildResources({
        cwd,
        agentDir,
        projectTrusted: true,
      });
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }

    assert.deepEqual(child.settingsManager.getGlobalSettings().packages, [
      ...openPiSources.map((source) => ({
        source,
        extensions: ["-extensions/git-info/index.ts"],
      })),
      ordinarySource,
    ]);
    for (const source of intercomSources) {
      assert.equal(
        child.loader
          .getExtensions()
          .extensions.some(
            (extension) => extension.sourceInfo.source === source,
          ),
        false,
      );
    }
  });
});

test("unverifiable local package identities fail closed before factory execution", async () => {
  for (const fixture of [
    { directoryName: "local-package-checkout", manifest: "{ invalid json" },
    { directoryName: "pi-intercom", manifest: undefined },
  ]) {
    await withTempDir(async (directory) => {
      const cwd = path.join(directory, "project");
      const agentDir = path.join(directory, "agent");
      const packageDir = path.join(directory, fixture.directoryName);
      const executionMarker = path.join(directory, "factory-executed");
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(packageDir, "extensions"), { recursive: true });
      await mkdir(agentDir, { recursive: true });
      if (fixture.manifest !== undefined) {
        await writeFile(
          path.join(packageDir, "package.json"),
          fixture.manifest,
        );
      }
      await writeFile(
        path.join(packageDir, "extensions", "index.ts"),
        `import { writeFileSync } from "node:fs";
         export default function () {
           writeFileSync(${JSON.stringify(executionMarker)}, "executed");
         }`,
      );
      await writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: [packageDir] }),
      );

      await assert.rejects(
        createChildResources({ cwd, agentDir, projectTrusted: true }),
        /Cannot verify child package identity/,
      );
      await assert.rejects(readFile(executionMarker));
    });
  }
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    new ProjectTrustStore(agentDir).set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  const result = await shutdownAndDisposeChildSession(session, {
    timeoutMs: 10,
  });
  assert.equal(disposals, 1);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.errors.join("; "), /shutdown timed out/i);
});

test("shutdown helper bounds abort and surfaces cleanup failure", async () => {
  let aborts = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => false,
      async emit() {},
    },
    abort() {
      aborts++;
      return new Promise(() => {});
    },
    dispose() {
      disposals++;
      throw new Error("dispose fixture");
    },
  };

  const startedAt = Date.now();
  const result = await shutdownAndDisposeChildSession(session, {
    abort: true,
    timeoutMs: 10,
  });
  assert.ok(Date.now() - startedAt < 200);
  assert.equal(aborts, 1);
  assert.equal(disposals, 1);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.errors.join("; "), /abort timed out.*dispose fixture/i);
});

/**
 * Discover every tool this package registers by scanning the extension sources
 * for `name: "..."` inside `pi.registerTool(...)` / `pi.registerTool({...})`
 * blocks. This is intentionally source-based, not runtime-based: it must catch a
 * newly-added tool even before any wiring exists, so the boundary cannot drift.
 */
async function discoverRegisteredToolNames() {
  const extensionsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../extensions",
  );
  const entries = await readdir(extensionsDir, { withFileTypes: true });
  const names = new Set<string>();
  const factoryRegistrations: string[] = [];
  // Matches `registerTool(` then the first `name:` string literal after it.
  // The optional `<...>` skips a generic type-argument list, because some tools
  // register as `pi.registerTool<Params, Details>({ ... })` (e.g. file-search's
  // fd/rg). `[^(]*` safely spans nested generics like `<ReturnType<...>, D>`
  // since a type-argument list contains no `(`. Missing this style silently
  // drops those tools from the scan and defeats the fail-closed guard below.
  const registerToolRe =
    /registerTool\s*(?:<[^(]*>)?\s*\(\s*(?:defineTool\s*\(\s*)?\{?/g;
  const nameRe = /name\s*:\s*["'`]([a-z0-9_]+)["'`]/i;
  const namedToolRe = /defineTool\s*\(\s*\{/g;
  // Factory style: `registerTool(createEditToolDefinition(...))` /
  // `registerTool(withActivityRenderer(createWriteToolDefinition(...)))`.
  // The tool name is not a literal here, so an inline-name scan is blind to it.
  // A factory registration is `registerTool(` whose first argument is a call
  // expression, not an object/generic literal. Reach through any renderer
  // wrapper to the innermost `create<Tool>Definition(` that actually names the
  // tool, so the classifier below fails closed on an UNKNOWN factory tool
  // rather than silently ignoring it.
  const factoryHeadRe = /registerTool\s*\(\s*([A-Za-z_$][\w$]*)\s*\(/g;
  const defFactoryRe = /(create[A-Za-z]*ToolDefinition)\s*\(/;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    const indexPath = path.join(extensionsDir, entry.name, "index.ts");
    let source: string;
    try {
      source = await readFile(indexPath, "utf8");
    } catch {
      continue; // not every extension registers tools
    }
    let match: RegExpExecArray | null;
    while ((match = registerToolRe.exec(source))) {
      const after = source.slice(match.index, match.index + 400);
      const nameMatch = nameRe.exec(after);
      if (nameMatch) names.add(nameMatch[1]);
    }
    let namedToolMatch: RegExpExecArray | null;
    while ((namedToolMatch = namedToolRe.exec(source))) {
      const nameMatch = nameRe.exec(
        source.slice(namedToolMatch.index, namedToolMatch.index + 400),
      );
      if (nameMatch) names.add(nameMatch[1]);
    }
    let factoryMatch: RegExpExecArray | null;
    while ((factoryMatch = factoryHeadRe.exec(source))) {
      // defineTool preserves an inline literal name, which registerToolRe
      // already found above; it is not an opaque factory registration.
      if (factoryMatch[1] === "defineTool") continue;
      // Look at the registerTool(...) argument region and prefer the innermost
      // create<Tool>Definition; fall back to the outer callee name if none.
      const region = source.slice(factoryMatch.index, factoryMatch.index + 200);
      const def = defFactoryRe.exec(region);
      factoryRegistrations.push(
        `${entry.name}: ${def ? def[1] : factoryMatch[1]}(...)`,
      );
    }
  }
  return { names, factoryRegistrations };
}

/**
 * Factory-registered tools the scan cannot name-resolve, mapped to the tool
 * name they actually register, with the classification they carry. These seven
 * native Pi builtins remain child-safe; OpenPI wraps only their TUI renderers.
 * Any NEW factory registration must be added here (with its classification) or
 * the drift guard fails closed.
 */
const KNOWN_FACTORY_TOOLS: Record<
  string,
  { tool: string; classification: "child-safe-builtin" | "excluded" }
> = {
  "createBashToolDefinition(...)": {
    tool: "bash",
    classification: "child-safe-builtin",
  },
  "createWriteToolDefinition(...)": {
    tool: "write",
    classification: "child-safe-builtin",
  },
  "createEditToolDefinition(...)": {
    tool: "edit",
    classification: "child-safe-builtin",
  },
  "createReadToolDefinition(...)": {
    tool: "read",
    classification: "child-safe-builtin",
  },
  "createGrepToolDefinition(...)": {
    tool: "grep",
    classification: "child-safe-builtin",
  },
  "createFindToolDefinition(...)": {
    tool: "find",
    classification: "child-safe-builtin",
  },
  "createLsToolDefinition(...)": {
    tool: "ls",
    classification: "child-safe-builtin",
  },
  "createHumanHandoffToolDefinition(...)": {
    tool: "human_handoff",
    classification: "excluded",
  },
};

test("every registered package tool is classified child-safe or excluded (fail-closed drift guard)", async () => {
  const { names: registered, factoryRegistrations } =
    await discoverRegisteredToolNames();
  // Sanity: the scan must actually find tools, or the guard is vacuous.
  assert.ok(
    registered.size >= 15,
    `expected to discover the package tools, found ${registered.size}`,
  );
  assert.ok(registered.has("bg_start"), "scan should find bg_start");
  assert.ok(registered.has("context_pivot"), "scan should find context_pivot");
  // fd/rg register with a generic type argument; the scan must find them too,
  // otherwise the CHILD_SAFE classification is never exercised and a future
  // parent-only tool in that same style would slip through the guard.
  assert.ok(registered.has("fd"), "scan should find generic-typed fd");
  assert.ok(registered.has("rg"), "scan should find generic-typed rg");

  // Factory-registered tools carry no inline name literal, so the inline scan
  // is blind to them. Fail closed: every factory registration must be a KNOWN
  // one whose classification we have vetted. A new, unrecognized factory
  // registration trips here instead of silently escaping the boundary — which
  // is exactly the leak the guard promises to prevent.
  for (const reg of factoryRegistrations) {
    const factoryCall = reg.slice(reg.indexOf(": ") + 2);
    const known = KNOWN_FACTORY_TOOLS[factoryCall];
    assert.ok(
      known,
      `unrecognized factory tool registration "${reg}": add it to ` +
        `KNOWN_FACTORY_TOOLS with its child classification, and exclude it in ` +
        `CHILD_EXCLUDED_TOOL_NAMES if it is parent-only`,
    );
    // A factory tool classified parent-only must appear in the exclusion list.
    if (known.classification === "excluded") {
      assert.ok(
        (CHILD_EXCLUDED_TOOL_NAMES as readonly string[]).includes(known.tool),
        `factory tool "${known.tool}" is parent-only but missing from CHILD_EXCLUDED_TOOL_NAMES`,
      );
      // Inline registrations enter `registered` through their literal name.
      // An opaque factory has no such literal at the call site, so record the
      // reviewed mapping here before the bidirectional drift checks below.
      registered.add(known.tool);
    }
  }
  // The wrapped builtins are what motivated this branch; assert the scan saw
  // every factory registration so this coverage cannot silently regress.
  assert.ok(
    factoryRegistrations.some((r) => r.includes("createBashToolDefinition")),
    "scan should see the factory-registered bash builtin",
  );
  assert.ok(
    factoryRegistrations.some((r) => r.includes("createWriteToolDefinition")),
    "scan should see the factory-registered write builtin",
  );
  assert.ok(
    factoryRegistrations.some((r) => r.includes("createEditToolDefinition")),
    "scan should see the factory-registered edit builtin",
  );
  for (const name of ["Read", "Grep", "Find", "Ls"]) {
    assert.ok(
      factoryRegistrations.some((registration) =>
        registration.includes(`create${name}ToolDefinition`),
      ),
      `scan should see the factory-registered ${name.toLowerCase()} builtin`,
    );
  }

  const safe = new Set<string>(CHILD_SAFE_PACKAGE_TOOL_NAMES);
  const excluded = new Set<string>(CHILD_EXCLUDED_TOOL_NAMES);

  // No tool may be both child-safe and excluded.
  for (const name of safe) {
    assert.equal(
      excluded.has(name),
      false,
      `${name} cannot be both child-safe and excluded`,
    );
  }

  // Every tool the package registers must be explicitly classified. A new
  // parent-only tool that is neither listed as child-safe nor excluded fails
  // here instead of silently leaking into headless children.
  for (const name of registered) {
    const classified = safe.has(name) || excluded.has(name);
    assert.ok(
      classified,
      `tool "${name}" is registered but not classified: add it to ` +
        `CHILD_EXCLUDED_TOOL_NAMES (parent-only) or ` +
        `CHILD_SAFE_PACKAGE_TOOL_NAMES (read-only, child-safe) in child-session.ts`,
    );
  }

  // The exclusion list must not name tools the package no longer registers
  // (except structured_output, a workflow-child tool registered dynamically).
  for (const name of excluded) {
    assert.ok(
      registered.has(name),
      `excluded tool "${name}" is no longer registered; remove it from CHILD_EXCLUDED_TOOL_NAMES`,
    );
  }
});

test("git-info exclusion: ENOENT degrades, other errors fail closed", async () => {
  const enoent: NodeJS.ErrnoException = new Error("no such file");
  enoent.code = "ENOENT";
  // Absent (ENOENT) -> undefined, so nothing is excluded.
  assert.equal(
    resolveGitInfoPathOrThrow(() => {
      throw enoent;
    }),
    undefined,
  );
  // Present -> the real path is returned for exclusion matching.
  assert.equal(
    resolveGitInfoPathOrThrow(() => "/repo/extensions/git-info/index.ts"),
    "/repo/extensions/git-info/index.ts",
  );
  // Unverifiable (non-ENOENT) -> must throw, not silently degrade.
  const eacces: NodeJS.ErrnoException = new Error("permission denied");
  eacces.code = "EACCES";
  assert.throws(
    () =>
      resolveGitInfoPathOrThrow(() => {
        throw eacces;
      }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
    "non-ENOENT realpath failures must fail closed",
  );
});
