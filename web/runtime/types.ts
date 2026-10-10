import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LiveToolEvidence } from "../protocol/evidence.ts";
import type {
  PlanControlResult,
  projectPlanControl,
} from "../../extensions/plan-mode/control.ts";
import type {
  WebModelSearchResult,
  WebCommandDiscoveryResult,
  WebModelSummary,
  WebSettingsResourceCatalog,
  WebSessionUsage,
  WebPromptImage,
  WebHistoryAnchor,
} from "../protocol/types.ts";
import type { WebProjectTrustStatus } from "./trust-status.ts";
import type { WebProviderLogin } from "../protocol/provider-login.ts";

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
  readonly custom?: boolean;
  readonly baseUrl?: string;
  readonly api?: WebModelConfiguration["api"];
  readonly loginLabel?: string;
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
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
}

export interface WebModelConfigurations {
  revision: string;
  models: WebModelConfiguration[];
  providers?: WebProviderConfigurationSummary[];
}

/** Pi-owned global default; trusted project settings may override it. */
export interface WebModelDefaults {
  model: { provider: string; id: string } | null;
  projectOverride?: { provider: string; id: string };
}

export interface WebProviderConfigurationSummary {
  provider: string;
  name: string;
  baseUrl: string;
  api: WebModelConfiguration["api"] | "";
  /** False when the native file contains models this editor cannot project. */
  editable: boolean;
}

export interface WebProviderConfiguration {
  provider: string;
  name: string;
  baseUrl: string;
  api: WebModelConfiguration["api"];
  models: WebModelConfiguration[];
}

export type WebProviderConfigurationChange =
  | { action: "save"; configuration: WebProviderConfiguration }
  | { action: "remove"; provider: string };

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
  | "PROVIDER_LOGIN_CONFLICT"
  | "SESSION_CONFLICT"
  | "SESSION_FORK_UNAVAILABLE"
  | "SESSION_FORK_CAPACITY"
  | "TURN_CONFLICT"
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
  planRevision?: string;
  streamingBehavior?: "followUp" | "steer";
  expectedTurnCommandId?: string;
}

export interface WebPromptAdmissionReceipt {
  pendingFollowUps: number;
  pendingSteering?: number;
  delivery?: "prompt" | "followUp" | "steer";
}

export interface WebActiveTurn {
  sessionId: string;
  commandId: string;
  epoch: number;
  /** Native input owning the run; steering does not replace this identity. */
  promptEntryId?: string;
  /** Actual execution start; admission/queue waiting is excluded. */
  startedAt?: number;
  /** Monotonic elapsed time captured with this projection. */
  elapsedMs?: number;
  sessionPath?: string;
}

/** Read-only facts for the selected Session, independent of input ownership. */
export interface WebSessionExecution {
  promptQueueBlocked?: boolean;
  lastTurn?: { commandId: string; finishedAt: number; outcome: "completed" | "cancelled" | "failed" | "uncertain"; resultEntryId?: string };
  sessionId: string;
  sessionPath: string;
  status: "running" | "idle" | "unknown";
  pendingFollowUps?: number;
  pendingSteering?: number;
  /** Bounded FIFO preview of Pi's native follow-up queue. */
  queuedMessages?: readonly string[];
  /** Pending Pi steering messages; receipt never implies execution. */
  steeringMessages?: readonly string[];
  liveTools: LiveToolEvidence[];
  liveToolsOmitted: number;
  activeTurn?: WebActiveTurn;
  /** Pi retry facts survive a Web reconnect; unknown counts stay omitted. */
  retry?: { attempt?: number; maxAttempts?: number; errorMessage?: string };
  /** Native compaction observation; completion history remains in Pi entries. */
  compaction?: {
    state: "running" | "completed" | "failed" | "cancelled" | "unchanged";
    startedAt?: number;
    elapsedMs?: number;
  };
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

export interface WebSessionForkRequest extends WebHistoryAnchor {
  commandId: string;
  rerun?: { mode: "edit"; content: string } | { mode: "regenerate" };
}

export interface WebSessionForkResult {
  state: "forked" | "cancelled" | "uncertain";
  commandId: string;
  source: WebHistoryAnchor;
  replayed?: boolean;
  sessionId?: string;
  sessionPath?: string;
  /** Prepared from the complete native user message; admission still uses /api/prompt. */
  prompt?: { content: string; images: WebPromptImage[] };
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
  forkSession?(request: WebSessionForkRequest): Promise<WebSessionForkResult>;
  listModels(): WebModelSummary[];
  searchModels(query: string, limit?: number, provider?: string): WebModelSearchResult;
  listCommands?(): WebCommandDiscoveryResult;
  listSettingsResources?(): WebSettingsResourceCatalog;
  getWebSearchSupport?(): { available: boolean; reason?: string; model?: string; provider?: string };
  applySetupConfiguration?(): Promise<void>;
  reloadSettingsResources?(sessionId: string, sessionPath: string): Promise<void>;
  listProviderAuth?(): WebProviderAuthProjection;
  saveProviderKey?(sessionId: string, provider: string, apiKey: string): Promise<void>;
  startProviderLogin?(sessionId: string, provider: string): Promise<WebProviderLogin>;
  readProviderLogin?(sessionId: string, id?: string): WebProviderLogin | null;
  respondProviderLogin?(sessionId: string, id: string, promptId: string, value: string): WebProviderLogin;
  cancelProviderLogin?(sessionId: string, id: string): WebProviderLogin;
  logoutProvider?(sessionId: string, provider: string): Promise<{ refreshRequired?: boolean }>;
  readModelConfigurations?(): Promise<WebModelConfigurations>;
  readModelDefaults?(): WebModelDefaults;
  saveModelDefault?(provider: string, modelId: string, options: WebModelSelectionOptions): Promise<WebModelDefaults>;
  saveModelConfiguration?(sessionId: string, revision: string, model: WebModelConfiguration): Promise<void>;
  saveModelConfigurations?(sessionId: string, revision: string, models: WebModelConfiguration[]): Promise<void>;
  changeProviderConfiguration?(sessionId: string, revision: string, change: WebProviderConfigurationChange): Promise<void>;
  discoverProviderModels?(sessionId: string, request: import("./provider-model-discovery.ts").ProviderModelDiscovery, signal: AbortSignal): Promise<{ models: import("./provider-model-discovery.ts").DiscoveredProviderModel[]; truncated: boolean }>;
  getSessionUsage?(): WebSessionUsage;
  getThinkingState?(): WebThinkingProjection;
  setPlanMode?(
    request: {
      sessionId: string;
      sessionPath: string;
      enabled: boolean;
      expectedRevision: string | null;
    },
  ): Promise<ReturnType<typeof projectPlanControl>>;
  preparePlanImplementation?(request: {
    sessionId: string;
    sessionPath: string;
    expectedRevision: string | null;
  }): Promise<PlanControlResult & { prompt: string }>;
  updatePromptQueue?(request: { sessionId: string; sessionPath: string; action: "retry" | "clear" }): void;
  compactSession?(request: { sessionId: string; sessionPath: string }): Promise<void>;
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
