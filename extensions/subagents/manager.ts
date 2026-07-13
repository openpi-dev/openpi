/**
 * SubagentManager - owns the lifecycle of in-process subagent sessions.
 *
 * Each subagent is a real AgentSession with its own session file (visible in
 * /resume), created via the pi SDK. Subagents are fire-and-forget: they run in
 * the background and settle to "done"/"error" whenever they go idle.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export const MAX_RUNNING = 4;

export const SUBAGENT_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
] as const;

/** Orchestration tools that child sessions must never receive. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  ...SUBAGENT_TOOL_NAMES,
  "workflow",
  "ask_user",
] as const;

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type SubagentStatus = "running" | "done" | "error";

export interface Subagent {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  session: AgentSession;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  /** Lightweight lifecycle listener used only for status accounting. */
  unsubscribeLifecycle?: () => void;
}

export interface SpawnOptions {
  prompt: string;
  title: string;
  cwd: string;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

/** Narrow an AgentMessage-ish value to a pi-ai Message role. */
export function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(sub: Subagent): AssistantMessage | undefined {
  const messages = sub.session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output of a subagent (last assistant message with text). */
export function finalOutput(sub: Subagent): string {
  const messages = sub.session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const assistant = msg as AssistantMessage;
    const text = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Context tokens of the subagent's last assistant message, if any. */
export function contextTokens(sub: Subagent): number | undefined {
  const messages = sub.session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const usage = (msg as AssistantMessage).usage;
    if (usage?.totalTokens) return usage.totalTokens;
  }
  return undefined;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatElapsed(sub: Subagent): string {
  const end = sub.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - sub.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export class SubagentManager {
  private subagents = new Map<string, Subagent>();
  private counter = 0;
  private disposed = false;
  private changeResolvers: Array<() => void> = [];
  /** Count of active subagent_wait calls interested in each id. */
  private waitInterest = new Map<string, number>();

  private changeListeners = new Set<() => void>();
  /** Fired when a subagent settles. `consumed` is true when a wait tool is collecting it. */
  onSettled?: (sub: Subagent, consumed: boolean) => void;

  list(): Subagent[] {
    return [...this.subagents.values()];
  }

  get(id: string): Subagent | undefined {
    return this.subagents.get(id);
  }

  size(): number {
    return this.subagents.size;
  }

  runningCount(): number {
    return this.list().filter((sub) => sub.status === "running").length;
  }

  /** Subscribe to any state change (status transitions, run start/end). */
  addChangeListener(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange() {
    const resolvers = this.changeResolvers;
    this.changeResolvers = [];
    for (const resolve of resolvers) resolve();
    for (const listener of this.changeListeners) listener();
  }

  /** Resolves on the next state change, or immediately when the signal aborts. */
  nextChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.changeResolvers.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async spawn(options: SpawnOptions): Promise<Subagent> {
    if (this.disposed) throw new Error("Subagent manager is shutting down.");
    if (this.runningCount() >= MAX_RUNNING) {
      throw new Error(
        `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
      );
    }

    const { session } = await createAgentSession({
      cwd: options.cwd,
      sessionManager: SessionManager.create(options.cwd),
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      // No recursive/nested orchestration: child sessions get coding and
      // integration tools, but never subagent or workflow spawning tools.
      excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
    });

    const id = `sa-${++this.counter}`;
    const sub: Subagent = {
      id,
      title: options.title,
      prompt: options.prompt,
      cwd: options.cwd,
      session,
      status: "running",
      createdAt: Date.now(),
    };
    this.subagents.set(id, sub);
    sub.unsubscribeLifecycle = session.subscribe((event) => {
      if (this.disposed) return;
      if (event.type === "agent_start") {
        sub.status = "running";
        sub.settledAt = undefined;
        sub.errorText = undefined;
        this.notifyChange();
      } else if (event.type === "agent_settled") {
        // Stronger than prompt() completion: no queued steering/follow-up,
        // retry, compaction, or automatic continuation remains.
        this.settle(sub);
      }
    });

    try {
      session.sessionManager.appendSessionInfo(`subagent: ${options.title}`);
    } catch {
      // Session naming is best-effort.
    }

    void this.run(sub, options.prompt);
    return sub;
  }

  /**
   * Send a message from the takeover view. While the agent is active, use the
   * SDK's steering queue rather than starting a second concurrent prompt().
   * If it is idle, the message starts a fresh run.
   */
  send(sub: Subagent, text: string) {
    if (sub.session.isStreaming) {
      sub.status = "running";
      sub.settledAt = undefined;
      this.notifyChange();
      void sub.session.steer(text).catch((error) => {
        sub.errorText = error instanceof Error ? error.message : String(error);
        this.notifyChange();
      });
      return;
    }
    void this.run(sub, text);
  }

  private async run(sub: Subagent, text: string) {
    sub.status = "running";
    sub.settledAt = undefined;
    sub.errorText = undefined;
    this.notifyChange();
    try {
      await sub.session.prompt(text);
    } catch (error) {
      sub.errorText = error instanceof Error ? error.message : String(error);
      // Preflight failures may not start an agent lifecycle, so no
      // agent_settled event will arrive for them.
      if (!sub.session.isStreaming) this.settle(sub);
    }
  }

  private settle(sub: Subagent) {
    sub.settledAt = Date.now();
    const last = lastAssistantMessage(sub);
    const failed =
      sub.errorText !== undefined ||
      last?.stopReason === "error" ||
      last?.stopReason === "aborted";
    sub.status = failed ? "error" : "done";
    if (!sub.errorText && last?.errorMessage) sub.errorText = last.errorMessage;
    if (!sub.errorText && last?.stopReason === "aborted")
      sub.errorText = "Run was aborted";
    const consumed = (this.waitInterest.get(sub.id) ?? 0) > 0;
    this.notifyChange();
    // During teardown, don't queue results into a session that is shutting down.
    if (!this.disposed) this.onSettled?.(sub, consumed);
  }

  /**
   * Wait until all listed subagents are settled (not running).
   * While waiting, settles for these ids are marked "consumed" so results are
   * not additionally queued as follow-up messages.
   */
  async waitFor(
    ids: string[],
    signal?: AbortSignal,
    onPending?: (pendingIds: string[]) => void,
  ): Promise<void> {
    for (const id of ids) {
      this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
    }
    try {
      while (!signal?.aborted) {
        const pending = ids.filter((id) => this.get(id)?.status === "running");
        if (pending.length === 0) return;
        onPending?.(pending);
        await this.nextChange(signal);
      }
    } finally {
      for (const id of ids) {
        const count = (this.waitInterest.get(id) ?? 1) - 1;
        if (count <= 0) this.waitInterest.delete(id);
        else this.waitInterest.set(id, count);
      }
    }
  }

  async abort(sub: Subagent) {
    await sub.session.abort();
  }

  async disposeAll() {
    this.disposed = true;
    const subs = this.list();
    this.subagents.clear();
    for (const sub of subs) {
      sub.unsubscribeLifecycle?.();
      sub.unsubscribeLifecycle = undefined;
      try {
        if (sub.status === "running") await sub.session.abort();
      } catch {
        // Best-effort abort.
      }
      try {
        sub.session.dispose();
      } catch {
        // Best-effort dispose.
      }
    }
    this.notifyChange();
  }
}
