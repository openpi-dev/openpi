import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_CHANNEL } from "../shared/plan-mode-state.ts";
import subagents from "./index.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-subagent-roster-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("session_start re-registers agent types for its cwd and live trust decision", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "agents", "session-only.md"),
      "---\nname: session-only\ndescription: Present only with live session trust.\ntools: [read]\n---\nRead only.",
    );

    const sessionStarts: Array<
      (event: unknown, ctx: ExtensionContext) => unknown
    > = [];
    const spawnTools: Array<{
      parameters: { properties: { agent_type: { enum?: string[] } } };
      execute?: (...args: unknown[]) => Promise<unknown>;
    }> = [];
    const eventHandlers = new Map<string, (payload: unknown) => void>();
    const pi = {
      on(event: string, handler: unknown) {
        if (event === "session_start") {
          sessionStarts.push(
            handler as (event: unknown, ctx: ExtensionContext) => unknown,
          );
        }
      },
      events: {
        on(channel: string, handler: unknown) {
          eventHandlers.set(channel, handler as (payload: unknown) => void);
        },
      },
      registerTool(tool: unknown) {
        const candidate = tool as {
          name?: string;
          parameters?: { properties?: { agent_type?: { enum?: string[] } } };
          execute?: (...args: unknown[]) => Promise<unknown>;
        };
        if (
          candidate.name === "subagent_spawn" &&
          candidate.parameters?.properties?.agent_type
        ) {
          spawnTools.push({
            parameters: {
              properties: {
                agent_type: candidate.parameters.properties.agent_type,
              },
            },
            execute: candidate.execute,
          });
        }
      },
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      registerCommand() {},
    } as unknown as ExtensionAPI;

    subagents(pi);
    assert.equal(sessionStarts.length, 1);
    const start = sessionStarts[0];
    assert.ok(start);

    start({}, {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext);
    assert.ok(spawnTools.length > 1, "session_start re-registers spawn");
    assert.ok(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
    );

    const alternateCwd = path.join(cwd, "alternate");
    await mkdir(path.join(alternateCwd, ".pi", "agents"), {
      recursive: true,
    });
    await writeFile(
      path.join(alternateCwd, ".pi", "agents", "alternate-only.md"),
      "---\nname: alternate-only\ndescription: Present only in another trusted session cwd.\ntools: [read]\n---\nRead only.",
    );
    start({}, {
      cwd: alternateCwd,
      hasUI: false,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext);
    assert.ok(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("alternate-only"),
    );
    assert.equal(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
      false,
    );

    start({}, {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
    } as unknown as ExtensionContext);
    assert.equal(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
      false,
    );

    const setPlanning = eventHandlers.get(PLAN_MODE_CHANNEL);
    assert.ok(setPlanning);
    setPlanning({ planning: true });
    const spawn = spawnTools.at(-1)?.execute;
    assert.ok(spawn);
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
    } as unknown as ExtensionContext;
    await assert.rejects(
      () =>
        spawn(
          "call",
          {
            prompt: "Inspect only.",
            name: "inspect",
            agent_type: "implementer",
            isolation: "worktree",
          },
          undefined,
          undefined,
          context,
        ),
      /Plan mode is active: isolation: "worktree"/,
    );
    await assert.rejects(
      () =>
        spawn(
          "call",
          {
            prompt: "Inspect only.",
            name: "inspect",
            agent_type: "implementer",
          },
          undefined,
          undefined,
          context,
        ),
      /agent type "implementer" declares tools that plan mode excludes/,
    );
  });
});
