import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_WORKFLOW_AGENT_CALLS } from "../shared/setup-config.ts";
import { encodeCompleteJson, toSerializable } from "./serialization.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_MESSAGE_BYTES = 512 * 1024;
/** A narrator line is one terminal row; the host bounds it again on arrival. */
const MAX_LOG_MESSAGE_BYTES = 8 * 1024;
/**
 * The sandbox's hard agent-request cap sits this many calls ABOVE the
 * controller's graceful budget, so the controller rejects the (budget+1)th
 * agent() into the script (as { ok:false }) before the sandbox would fatally
 * kill the run. Bounded so the backstop still stops a runaway child that
 * bypasses the controller entirely.
 */
export const AGENT_CALL_BACKSTOP_MARGIN = 8;

export interface SandboxAgentOptions {
  agent_type?: unknown;
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  acceptance?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  isolation?: unknown;
  operator?: unknown;
  inputs?: unknown;
}

export interface SandboxAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  ref?: string;
  error?: string;
}

export interface RunWorkflowSandboxOptions {
  source: string;
  args: unknown;
  cwd: string;
  signal: AbortSignal;
  onAgent: (
    prompt: string,
    options: SandboxAgentOptions,
    signal: AbortSignal,
  ) => Promise<SandboxAgentResult>;
  onPhase: (title: string) => void;
  onLog: (text: string, kind?: "pipeline-drop") => void;
  /**
   * Cumulative run usage, read at send time so the child's `usage()` reflects
   * the agent that just settled rather than a value captured at launch.
   */
  usageSnapshot: () => unknown;
  maxConcurrency: number;
  /** Same budget the controller enforces; the sandbox is the outer guard. */
  maxAgentCalls: number;
  /**
   * Replayable results available to this run. A replayed call costs no
   * controller budget but still sends one agent IPC message, so without this
   * the backstop fires long before the controller does and kills the child
   * mid-run — losing the aggregate that resuming exists to preserve.
   */
  extraAgentRequests?: number;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function terminateChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 1_000);
  force.unref?.();
}

function sanitizeAgentOptions(value: unknown): SandboxAgentOptions {
  if (!isRecord(value)) return {};
  return {
    ...(value.agent_type !== undefined ? { agent_type: value.agent_type } : {}),
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    ...(value.schema !== undefined ? { schema: value.schema } : {}),
    ...(value.acceptance !== undefined ? { acceptance: value.acceptance } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
    ...(value.isolation !== undefined ? { isolation: value.isolation } : {}),
    ...(value.operator !== undefined ? { operator: value.operator } : {}),
    ...(value.inputs !== undefined ? { inputs: value.inputs } : {}),
  };
}

/**
 * Execute orchestration code in a separate, permission-restricted Node process.
 * The child can only invoke the narrow agent/phase IPC protocol and is always
 * terminated on completion, cancellation, or protocol failure. The workflow
 * itself and its agent requests have no wall-clock deadline. Active requests
 * are aborted only when the workflow is cancelled or the sandbox is cleaned up.
 */
export function runWorkflowSandbox(options: RunWorkflowSandboxOptions) {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
    return Promise.reject(
      new Error("This Node runtime cannot enforce workflow child permissions"),
    );
  }
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    return Promise.reject(
      new Error(`Workflow script exceeds the ${MAX_SOURCE_BYTES} byte limit`),
    );
  }

  // See AGENT_CALL_BACKSTOP_MARGIN: the sandbox hard cap sits above the
  // controller's graceful budget so the controller rejects first and the
  // script can still return its aggregate.
  const controllerBudget = Math.max(
    1,
    Math.min(MAX_WORKFLOW_AGENT_CALLS, Math.floor(options.maxAgentCalls)),
  );
  const maxAgentRequests =
    controllerBudget +
    AGENT_CALL_BACKSTOP_MARGIN +
    Math.max(
      0,
      Math.min(
        MAX_WORKFLOW_AGENT_CALLS,
        Math.floor(options.extraAgentRequests ?? 0),
      ),
    );

  const encodedArgs = encodeCompleteJson(
    { defined: options.args !== undefined, value: options.args },
    {
      maxBytes: MAX_ARGS_BYTES,
      maxDepth: 16,
      maxNodes: 10_000,
      maxStringBytes: MAX_ARGS_BYTES,
    },
  );
  if (!encodedArgs.ok) {
    return Promise.reject(
      new Error(
        `Workflow args exceed the ${MAX_ARGS_BYTES}-byte IPC limit (${encodedArgs.limit} limit at ${encodedArgs.path})`,
      ),
    );
  }
  const argsJson = encodedArgs.json;

  return new Promise<unknown>((resolve, reject) => {
    const workerPath = fileURLToPath(
      new URL("./sandbox-child.cjs", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${path.dirname(workerPath)}`,
        "--max-old-space-size=128",
        "--stack-size=2048",
        workerPath,
      ],
      {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const token = randomBytes(24).toString("hex");
    const requestIds = new Set<number>();
    const activeAgentRequests = new Map<number, AbortController>();
    let requestCount = 0;
    let finished = false;

    // The child parses this and falls back to zeros if it is ever unusable, so
    // a broken snapshot degrades `usage()` to a zero reading instead of
    // failing the run.
    const usageJson = () => {
      try {
        return JSON.stringify(options.usageSnapshot()) ?? "{}";
      } catch {
        return "{}";
      }
    };

    const cleanup = () => {
      for (const abortController of activeAgentRequests.values()) {
        abortController.abort(new Error("Workflow stopped"));
      }
      activeAgentRequests.clear();
      options.signal.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      terminateChild(child);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Workflow was aborted"));

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!finished) {
        finish(
          new Error(
            `Workflow sandbox exited before completion (${exitSignal ?? code ?? "unknown"})`,
          ),
        );
      }
    });
    child.on("message", (raw: unknown) => {
      if (
        !isRecord(raw) ||
        raw.token !== token ||
        typeof raw.kind !== "string"
      ) {
        finish(new Error("Workflow sandbox sent an invalid IPC message"));
        return;
      }
      if (raw.kind === "phase") {
        // Same clip-not-kill rule as log below: a phase title is display text,
        // and an oversized one must not cost the run its agent results.
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > MAX_LOG_MESSAGE_BYTES
        ) {
          return;
        }
        try {
          const payload: unknown = JSON.parse(raw.payloadJson);
          if (!isRecord(payload) || typeof payload.title !== "string") {
            throw new Error("invalid title");
          }
          options.onPhase(payload.title.slice(0, 160));
        } catch {
          return;
        }
        return;
      }
      if (raw.kind === "log") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > MAX_LOG_MESSAGE_BYTES
        ) {
          // Dropped, never fatal. A narrator line is the least important thing
          // in a run; killing the child over one discards every completed
          // agent's output. The byte ceiling is protocol abuse protection, and
          // it is generous precisely so that ordinary oversized narration
          // (a JSON.stringify of 400 paths, 3000 emoji) is clipped by
          // appendLog rather than losing the run.
          return;
        }
        try {
          const payload: unknown = JSON.parse(raw.payloadJson);
          if (!isRecord(payload) || typeof payload.text !== "string") {
            throw new Error("invalid text");
          }
          if (payload.kind !== undefined && payload.kind !== "pipeline-drop") {
            throw new Error("invalid log kind");
          }
          options.onLog(payload.text, payload.kind);
        } catch {
          finish(new Error("Workflow sandbox sent an invalid log line"));
        }
        return;
      }
      if (raw.kind === "agent") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > MAX_AGENT_MESSAGE_BYTES
        ) {
          finish(new Error("Workflow sandbox sent an oversized agent request"));
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.payloadJson);
        } catch {
          finish(new Error("Workflow sandbox sent malformed agent JSON"));
          return;
        }
        if (
          !isRecord(payload) ||
          !Number.isSafeInteger(payload.id) ||
          typeof payload.id !== "number" ||
          payload.id < 1 ||
          typeof payload.prompt !== "string" ||
          payload.prompt.length > 100_000 ||
          !isRecord(payload.options)
        ) {
          finish(new Error("Workflow sandbox sent an invalid agent request"));
          return;
        }
        if (requestIds.has(payload.id) || ++requestCount > maxAgentRequests) {
          finish(
            new Error("Workflow sandbox exceeded its agent request budget"),
          );
          return;
        }
        requestIds.add(payload.id);
        const id = payload.id;
        const abortController = new AbortController();
        const sendResult = (result: SandboxAgentResult) => {
          if (!activeAgentRequests.delete(id)) return;
          if (finished || !child.connected) return;
          const normalized = toSerializable(result, {
            maxDepth: 16,
            maxNodes: 10_000,
            maxStringBytes: 128 * 1024,
          });
          let resultJson = JSON.stringify(normalized);
          if (byteLength(resultJson) > MAX_AGENT_MESSAGE_BYTES) {
            resultJson = JSON.stringify({
              ok: false,
              output: "",
              error: "Agent result exceeded the workflow IPC output limit",
            });
          }
          child.send({
            token,
            kind: "agentResult",
            id,
            resultJson,
            usageJson: usageJson(),
          });
        };
        activeAgentRequests.set(id, abortController);
        let agentOperation: Promise<SandboxAgentResult>;
        try {
          agentOperation = options.onAgent(
            payload.prompt,
            sanitizeAgentOptions(payload.options),
            abortController.signal,
          );
        } catch (error) {
          sendResult({ ok: false, output: "", error: errorText(error) });
          return;
        }
        void agentOperation.then(sendResult, (error) =>
          sendResult({ ok: false, output: "", error: errorText(error) }),
        );
        return;
      }
      if (raw.kind === "result") {
        if (
          typeof raw.resultJson !== "string" ||
          byteLength(raw.resultJson) > MAX_RESULT_BYTES
        ) {
          finish(new Error("Workflow result exceeded the IPC limit"));
          return;
        }
        try {
          const normalized = toSerializable(JSON.parse(raw.resultJson));
          finish(undefined, JSON.parse(JSON.stringify(normalized)));
        } catch (error) {
          finish(
            new Error(`Workflow returned invalid JSON: ${errorText(error)}`),
          );
        }
        return;
      }
      if (raw.kind === "error" && typeof raw.error === "string") {
        finish(new Error(raw.error.slice(0, 16 * 1024)));
        return;
      }
      finish(new Error("Workflow sandbox sent an unknown IPC message"));
    });

    child.send(
      {
        kind: "init",
        token,
        source: options.source,
        argsJson,
        maxConcurrency: options.maxConcurrency,
        usageJson: usageJson(),
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
}
