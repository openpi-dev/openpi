import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LiveToolEvidence } from "../protocol/evidence.ts";
import type { PlanControlRequest, projectPlanControl } from "../../extensions/plan-mode/control.ts";
import type {
  WebModelSearchResult,
  WebCommandDiscoveryResult,
  WebModelSummary,
  WebSettingsResourceCatalog,
  WebSessionUsage,
  WebPromptImage,
} from "../protocol/types.ts";
import type { WebProjectTrustStatus } from "./trust-status.ts";

export type WebProviderAuthSource =
  | "stored"
  | "runtime"
  | "environment"
  | "fallback"
  | "models_json_key"
  | "models_json_command";

export interface WebProviderAuthSummary {
  readonly id: string;
  readonly name: string;
  readonly authMethods: readonly ("api_key" | "oauth")[];
  readonly configured: boolean;
  readonly source?: WebProviderAuthSource;
  readonly subscription: boolean;
  readonly nameTruncated: boolean;
}

export interface WebProviderAuthProjection {
  readonly providers: readonly WebProviderAuthSummary[];
  readonly truncation: {
    readonly truncated: boolean;
    readonly providersOmitted: number;
    readonly namesTruncated: number;
    readonly maxProviders: number;
  };
}

export interface WebModelConfiguration {
  provider: string;
  id: string;
  name: string;
  baseUrl: string;
  api: "openai-responses" | "openai-completions" | "anthropic-messages";
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface WebModelConfigurations {
  revision: string;
  models: WebModelConfiguration[];
}

export interface WebRuntimeEvent {
  type: string;
  detail?: Record<string, unknown>;
}

export type WebRuntimeRequestErrorCode =
  | "PLAN_BUSY"
  | "PLAN_CONFLICT"
  | "PLAN_CONTROL_UNAVAILABLE"
  | "MODEL_NOT_AVAILABLE"
  | "MODEL_CONFIGURATION_CONFLICT"
  | "SESSION_CONFLICT"
  | "PROMPT_REJECTED"
  | "WORKSPACE_REQUIRED"
  | "THINKING_LEVEL_NOT_AVAILABLE";

export class WebRuntimeRequestError extends Error {
  readonly code: WebRuntimeRequestErrorCode;
  readonly statusCode: 400 | 409 | 422 | 501;

  constructor(
    message: string,
    code: WebRuntimeRequestErrorCode,
    statusCode: 400 | 409 | 422 | 501,
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
  expectedSessionPath?: string;
  images?: readonly WebPromptImage[];
}

export interface WebPromptAdmissionReceipt {
  pendingFollowUps: number;
}

export interface WebActiveTurn {
  sessionId: string;
  commandId: string;
  epoch: number;
  /** Actual execution start; admission/queue waiting is excluded. */
  startedAt?: number;
  /** Monotonic elapsed time captured with this projection. */
  elapsedMs?: number;
  sessionPath?: string;
}

/** Read-only facts for the selected Session, independent of input ownership. */
export interface WebSessionExecution {
  sessionId: string;
  sessionPath: string;
  status: "running" | "idle" | "unknown";
  pendingFollowUps?: number;
  /** Bounded FIFO preview of Pi's native follow-up queue. */
  queuedMessages?: readonly string[];
  liveTools: LiveToolEvidence[];
  liveToolsOmitted: number;
  activeTurn?: WebActiveTurn;
}

export interface WebTurnCancellationOptions extends WebActiveTurn {}

export type WebTurnCancellationState =
  | "accepted"
  | "already-settled"
  | "stale-session"
  | "stale-turn"
  | "failed";

export interface WebTurnCancellationResult extends WebActiveTurn {
  state: WebTurnCancellationState;
  error?: string;
}

export interface WebModelSelectionOptions {
  expectedSessionId?: string;
  expectedSessionPath?: string;
}

export interface WebThinkingSelectionOptions {
  expectedSessionId?: string;
  expectedSessionPath?: string;
}

export interface WebThinkingProjection {
  level: string;
  available: readonly string[];
  supported: boolean;
}

export interface WebSessionCreationOptions {
  commandId?: string;
}

export interface WebSessionCreationResult {
  cancelled: boolean;
  replayed?: boolean;
  commandId?: string;
  sessionId: string;
  sessionPath?: string;
}

export interface WebRuntimeController {
  readonly cwd: string;
  /** Runtime authority: false until a real Web workspace and Session are active. */
  readonly workspaceSelected: boolean;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
  getProjectTrustStatus?(): WebProjectTrustStatus;
  isIdle(): boolean;
  getActiveTurn(): WebActiveTurn | undefined;
  getSessionExecution?(sessionId: string, sessionPath: string): WebSessionExecution;
  /** Internal read seam; never activates a Session or grants input authority. */
  getSessionManagerForRead?(sessionId: string, sessionPath: string): SessionManager | undefined;
  sendPrompt(
    content: string,
    options?: WebPromptOptions,
  ): Promise<WebPromptAdmissionReceipt>;
  cancelTurn(
    options: WebTurnCancellationOptions,
  ): Promise<WebTurnCancellationResult>;
  newSession(
    workspacePath: string,
    options?: WebSessionCreationOptions,
  ): Promise<WebSessionCreationResult>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  listModels(): WebModelSummary[];
  searchModels(query: string, limit?: number): WebModelSearchResult;
  listCommands?(): WebCommandDiscoveryResult;
  listSettingsResources?(): WebSettingsResourceCatalog;
  listProviderAuth?(): WebProviderAuthProjection;
  saveProviderKey?(sessionId: string, provider: string, apiKey: string): Promise<void>;
  readModelConfigurations?(): Promise<WebModelConfigurations>;
  saveModelConfiguration?(sessionId: string, revision: string, model: WebModelConfiguration): Promise<void>;
  getSessionUsage?(): WebSessionUsage;
  getThinkingState?(): WebThinkingProjection;
  setPlanMode?(request: PlanControlRequest & { sessionId: string; sessionPath: string }): Promise<ReturnType<typeof projectPlanControl>>;
  setThinkingLevel?(
    level: string,
    options?: WebThinkingSelectionOptions,
  ): Promise<WebThinkingProjection>;
  setModel(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ): Promise<WebModelSummary>;
  subscribe(listener: (event: WebRuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
