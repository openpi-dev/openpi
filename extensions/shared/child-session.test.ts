import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindChildSessionExtensions,
  CHILD_EXCLUDED_TOOL_NAMES,
  CHILD_SAFE_PACKAGE_TOOL_NAMES,
  childToolPolicy,
  effectiveChildToolAllowlist,
  createChildResources,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  type DisposableChildSession,
} from "./child-session.ts";

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

test("resource loading gates project resources and keeps only the pi-intercom package parent-only", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const intercomPackageDir = path.join(
      agentDir,
      "npm",
      "node_modules",
      "pi-intercom",
    );
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "skills", "global-fixture"), {
      recursive: true,
    });
    await mkdir(path.join(intercomPackageDir, "skills", "pi-intercom"), {
      recursive: true,
    });
    const extensionSource = (names: string[]) => `
      export default function (pi) {
        for (const name of ${JSON.stringify(names)}) pi.registerTool({
          name, label: name, description: "fixture",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource(["global_fixture", "intercom"]),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource(["project_fixture"]),
    );
    await writeFile(
      path.join(intercomPackageDir, "index.ts"),
      extensionSource(["intercom"]),
    );
    await writeFile(
      path.join(intercomPackageDir, "package.json"),
      JSON.stringify({
        name: "pi-intercom",
        version: "0.9.3",
        pi: {
          extensions: ["./index.ts"],
          skills: ["./skills"],
        },
      }),
    );
    await writeFile(
      path.join(intercomPackageDir, "skills", "pi-intercom", "SKILL.md"),
      "---\nname: pi-intercom\ndescription: fixture\n---\n",
    );
    await writeFile(
      path.join(agentDir, "skills", "global-fixture", "SKILL.md"),
      "---\nname: global-fixture\ndescription: fixture\n---\n",
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-intercom@0.9.3"] }),
    );

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
    assert.equal(untrustedTools.includes("project_fixture"), false);
    assert.equal(
      untrustedExtensions.some(
        (extension) => extension.sourceInfo.source === "npm:pi-intercom@0.9.3",
      ),
      false,
      JSON.stringify(
        untrustedExtensions.map((extension) => extension.sourceInfo),
      ),
    );

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
    assert.equal(trustedTools.includes("project_fixture"), true);
    assert.equal(
      trustedExtensions.some(
        (extension) => extension.sourceInfo.source === "npm:pi-intercom@0.9.3",
      ),
      false,
    );

    const childSkills = trusted.loader.getSkills().skills;
    assert.equal(
      childSkills.some((skill) => skill.name === "global-fixture"),
      true,
    );
    assert.equal(
      childSkills.some(
        (skill) => skill.sourceInfo.source === "npm:pi-intercom@0.9.3",
      ),
      false,
    );
  });
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
    "..",
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
  // `registerTool(withCompactCallRenderer(createWriteToolDefinition(...)))`.
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
 * name they actually register, with the classification they carry. write/edit
 * are native Pi builtins (children keep them), wrapped only for compact
 * renderers — not package-owned parent-only tools. Any NEW factory registration
 * must be added here (with its classification) or the drift guard fails closed.
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
