import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WebModelSummary } from "../protocol/types.ts";

export interface WebRuntimeEvent {
  type: string;
  detail?: Record<string, unknown>;
}

export type WebRuntimeRequestErrorCode =
  | "MODEL_NOT_AVAILABLE"
  | "SESSION_CONFLICT"
  | "PROMPT_REJECTED"
  | "WORKSPACE_REQUIRED";

export class WebRuntimeRequestError extends Error {
  readonly code: WebRuntimeRequestErrorCode;
  readonly statusCode: 400 | 409 | 422;

  constructor(
    message: string,
    code: WebRuntimeRequestErrorCode,
    statusCode: 400 | 409 | 422,
  ) {
    super(message);
    this.name = "WebRuntimeRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface WebPromptOptions {
  commandId?: string;
  expectedSessionId?: string;
}

export interface WebModelSelectionOptions {
  expectedSessionId?: string;
}

export interface WebSessionCreationOptions {
  commandId?: string;
}

export interface WebSessionCreationResult {
  cancelled: boolean;
  commandId?: string;
  sessionPath?: string;
}

export interface WebRuntimeController {
  readonly cwd: string;
  /** Runtime authority: false until a real Web workspace and Session are active. */
  readonly workspaceSelected: boolean;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
  isIdle(): boolean;
  sendPrompt(content: string, options?: WebPromptOptions): Promise<void>;
  newSession(
    workspacePath: string,
    options?: WebSessionCreationOptions,
  ): Promise<WebSessionCreationResult>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  listModels(): WebModelSummary[];
  setModel(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ): Promise<WebModelSummary>;
  subscribe(listener: (event: WebRuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
