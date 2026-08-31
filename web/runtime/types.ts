import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WebModelSummary } from "../protocol/types.ts";

export interface WebRuntimeEvent {
  type: string;
  detail?: Record<string, unknown>;
}

export interface WebRuntimeController {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
  isIdle(): boolean;
  sendPrompt(
    content: string,
    trace?: { commandId: string; sessionId: string },
  ): Promise<void>;
  newSession(workspacePath: string): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  listModels(): WebModelSummary[];
  setModel(provider: string, modelId: string): Promise<WebModelSummary>;
  subscribe(listener: (event: WebRuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
