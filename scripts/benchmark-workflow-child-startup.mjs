import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../extensions/shared/child-session.ts";

const foreignRunCounts = [0, 100, 1_000];
const childCounts = [1, 4, 8];
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function writeForeignRuns(agentDir, count) {
  const artifacts = new Map();
  for (let index = 0; index < count; index++) {
    const runId = `wf_${index.toString(16).padStart(8, "0")}`;
    const runDir = path.join(agentDir, "workflows", runId);
    const workflow = JSON.stringify({
      runId,
      sessionId: `foreign-session-${index}`,
      status: "completed",
      startedAt: index,
      finishedAt: index + 1,
      agents: [],
      phases: [],
      resultArtifact: "result.json",
      transcriptArtifact: "transcripts.json",
    });
    const result = JSON.stringify({ result: `foreign result ${index}` });
    const transcripts = JSON.stringify({});
    await mkdir(runDir, { recursive: true });
    await Promise.all(
      [
        ["workflow.json", workflow],
        ["result.json", result],
        ["transcripts.json", transcripts],
      ].map(async ([name, content]) => {
        const artifactPath = path.join(runDir, name);
        artifacts.set(artifactPath, content);
        await writeFile(artifactPath, content);
      }),
    );
  }
  return artifacts;
}

function instrumentWorkflowArtifacts(artifacts) {
  const originalReadFileSync = fs.readFileSync;
  const originalJsonParse = JSON.parse;
  const workflowJson = new Set(
    [...artifacts.entries()]
      .filter(
        ([artifactPath]) => path.basename(artifactPath) === "workflow.json",
      )
      .map(([, content]) => content),
  );
  const metrics = {
    workflowSyncReadCalls: 0,
    workflowBytesRead: 0,
    workflowJsonParses: 0,
    workflowSyncReadMilliseconds: 0,
  };

  fs.readFileSync = (...args) => {
    const startedAt = performance.now();
    const content = originalReadFileSync(...args);
    const elapsed = performance.now() - startedAt;
    const artifactPath = args[0];
    if (typeof artifactPath === "string" && artifacts.has(artifactPath)) {
      metrics.workflowSyncReadCalls++;
      metrics.workflowSyncReadMilliseconds += elapsed;
      metrics.workflowBytesRead += Buffer.byteLength(
        typeof content === "string" ? content : content.toString(),
      );
    }
    return content;
  };
  syncBuiltinESMExports();
  JSON.parse = (text, reviver) => {
    if (typeof text === "string" && workflowJson.has(text)) {
      metrics.workflowJsonParses++;
    }
    return originalJsonParse(text, reviver);
  };

  return {
    metrics,
    restore() {
      fs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
      JSON.parse = originalJsonParse;
    },
  };
}

async function startChild({ cwd, agentDir, index }) {
  let session;
  try {
    const { loader, settingsManager } = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(path.join(cwd, String(index))),
      ...childToolPolicy(),
    }));
    await bindChildSessionExtensions(session);
    return session;
  } catch (error) {
    if (session) await shutdownAndDisposeChildSession(session);
    throw error;
  }
}

async function benchmarkScenario({ foreignRunCount, childCount }) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "openpi-workflow-child-startup-"),
  );
  const agentDir = path.join(directory, "agent");
  const cwd = path.join(directory, "project");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let instrumentation;
  let sessions = [];

  try {
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageRoot] }),
    );
    const artifacts = await writeForeignRuns(agentDir, foreignRunCount);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    instrumentation = instrumentWorkflowArtifacts(artifacts);

    const startedAt = performance.now();
    const starts = await Promise.allSettled(
      Array.from({ length: childCount }, (_value, index) =>
        startChild({ cwd, agentDir, index }),
      ),
    );
    sessions = starts
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failedStart = starts.find((result) => result.status === "rejected");
    if (failedStart) throw failedStart.reason;
    const batchStartupMilliseconds = performance.now() - startedAt;
    const result = {
      childCount,
      foreignRunCount,
      ...instrumentation.metrics,
      batchStartupMilliseconds,
    };
    if (
      result.workflowSyncReadCalls !== 0 ||
      result.workflowBytesRead !== 0 ||
      result.workflowJsonParses !== 0
    ) {
      throw new Error(
        `Workflow artifact gate failed for ${childCount} children and ${foreignRunCount} foreign runs: ` +
          `${result.workflowSyncReadCalls} reads, ${result.workflowBytesRead} bytes, ` +
          `${result.workflowJsonParses} parses`,
      );
    }
    return result;
  } finally {
    await Promise.all(
      sessions.map((session) => shutdownAndDisposeChildSession(session)),
    );
    instrumentation?.restore();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const scenarios = [];
for (const foreignRunCount of foreignRunCounts) {
  for (const childCount of childCounts) {
    scenarios.push(await benchmarkScenario({ foreignRunCount, childCount }));
  }
}

console.log(
  "children | foreign runs | reads | bytes | parses | read ms | startup ms",
);
for (const scenario of scenarios) {
  console.log(
    `${String(scenario.childCount).padStart(8)} | ` +
      `${String(scenario.foreignRunCount).padStart(12)} | ` +
      `${String(scenario.workflowSyncReadCalls).padStart(5)} | ` +
      `${String(scenario.workflowBytesRead).padStart(5)} | ` +
      `${String(scenario.workflowJsonParses).padStart(6)} | ` +
      `${scenario.workflowSyncReadMilliseconds.toFixed(3).padStart(7)} | ` +
      scenario.batchStartupMilliseconds.toFixed(3),
  );
}
console.log(JSON.stringify({ scenarios }));
