/**
 * Small Cursor AgentService protobuf surface.
 *
 * The field numbers and message names are vendored from
 * oh-my-pi@eab72e88e4, packages/catalog/src/discovery/cursor-proto.ts
 * (MIT). Only the chat, image, model-discovery, and exec-rejection messages
 * used by this chat-only provider are retained. Unknown fields are skipped by
 * the local protobuf codec so newer Cursor messages remain forward-compatible.
 */

import { type MessageCodec, type ProtoMessage, pb } from "./protobuf.ts";

export interface AgentClientMessage extends ProtoMessage {
  message:
    | { case: undefined; value?: undefined }
    | { case: "runRequest"; value: AgentRunRequest }
    | { case: "execClientMessage"; value: ExecClientMessage }
    | { case: "execClientControlMessage"; value: ExecClientControlMessage }
    | { case: "kvClientMessage"; value: KvClientMessage }
    | { case: "clientHeartbeat"; value: ClientHeartbeat };
}

export const AgentClientMessageSchema: MessageCodec<AgentClientMessage> =
  pb<AgentClientMessage>("agent.v1.AgentClientMessage", [
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 1,
          name: "runRequest",
          kind: "message",
          T: () => AgentRunRequestSchema,
        },
        {
          no: 2,
          name: "execClientMessage",
          kind: "message",
          T: () => ExecClientMessageSchema,
        },
        {
          no: 5,
          name: "execClientControlMessage",
          kind: "message",
          T: () => ExecClientControlMessageSchema,
        },
        {
          no: 3,
          name: "kvClientMessage",
          kind: "message",
          T: () => KvClientMessageSchema,
        },
        {
          no: 7,
          name: "clientHeartbeat",
          kind: "message",
          T: () => ClientHeartbeatSchema,
        },
      ],
    },
  ]);

export interface AgentRunRequest extends ProtoMessage {
  conversationState?: ConversationStateStructure;
  action?: ConversationAction;
  modelDetails?: ModelDetails;
  requestedModel?: RequestedModel;
  conversationId?: string;
  customSystemPrompt?: string;
}

export const AgentRunRequestSchema: MessageCodec<AgentRunRequest> =
  pb<AgentRunRequest>("agent.v1.AgentRunRequest", [
    {
      no: 1,
      name: "conversationState",
      kind: "message",
      T: () => ConversationStateStructureSchema,
    },
    {
      no: 2,
      name: "action",
      kind: "message",
      T: () => ConversationActionSchema,
    },
    {
      no: 3,
      name: "modelDetails",
      kind: "message",
      T: () => ModelDetailsSchema,
    },
    {
      no: 9,
      name: "requestedModel",
      kind: "message",
      T: () => RequestedModelSchema,
    },
    { no: 5, name: "conversationId", kind: "string", optional: true },
    { no: 8, name: "customSystemPrompt", kind: "string", optional: true },
  ]);

export interface ConversationStateStructure extends ProtoMessage {
  rootPromptMessagesJson: Uint8Array[];
  turns: Uint8Array[];
  pendingToolCalls: string[];
}

export const ConversationStateStructureSchema: MessageCodec<ConversationStateStructure> =
  pb<ConversationStateStructure>("agent.v1.ConversationStateStructure", [
    { no: 1, name: "rootPromptMessagesJson", kind: "bytes", repeat: true },
    { no: 4, name: "pendingToolCalls", kind: "string", repeat: true },
    { no: 8, name: "turns", kind: "bytes", repeat: true },
  ]);

export interface ConversationAction extends ProtoMessage {
  action:
    | { case: undefined; value?: undefined }
    | { case: "userMessageAction"; value: UserMessageAction }
    | { case: "resumeAction"; value: ResumeAction };
}

export const ConversationActionSchema: MessageCodec<ConversationAction> =
  pb<ConversationAction>("agent.v1.ConversationAction", [
    {
      kind: "oneof",
      name: "action",
      variants: [
        {
          no: 1,
          name: "userMessageAction",
          kind: "message",
          T: () => UserMessageActionSchema,
        },
        {
          no: 2,
          name: "resumeAction",
          kind: "message",
          T: () => ResumeActionSchema,
        },
      ],
    },
  ]);

export interface UserMessageAction extends ProtoMessage {
  userMessage?: UserMessage;
}

export const UserMessageActionSchema: MessageCodec<UserMessageAction> =
  pb<UserMessageAction>("agent.v1.UserMessageAction", [
    { no: 1, name: "userMessage", kind: "message", T: () => UserMessageSchema },
  ]);

export interface ResumeAction extends ProtoMessage {}

export const ResumeActionSchema: MessageCodec<ResumeAction> = pb<ResumeAction>(
  "agent.v1.ResumeAction",
  [],
);

export interface UserMessage extends ProtoMessage {
  text: string;
  messageId: string;
  selectedContext?: SelectedContext;
  mode: number;
}

export const UserMessageSchema: MessageCodec<UserMessage> = pb<UserMessage>(
  "agent.v1.UserMessage",
  [
    { no: 1, name: "text", kind: "string" },
    { no: 2, name: "messageId", kind: "string" },
    {
      no: 3,
      name: "selectedContext",
      kind: "message",
      T: () => SelectedContextSchema,
    },
    { no: 4, name: "mode", kind: "int32" },
  ],
);

export interface SelectedContext extends ProtoMessage {
  selectedImages: SelectedImage[];
}

export const SelectedContextSchema: MessageCodec<SelectedContext> =
  pb<SelectedContext>("agent.v1.SelectedContext", [
    {
      no: 1,
      name: "selectedImages",
      kind: "message",
      T: () => SelectedImageSchema,
      repeat: true,
    },
  ]);

export interface SelectedImage extends ProtoMessage {
  uuid: string;
  path: string;
  dimension?: SelectedImage_Dimension;
  mimeType: string;
  dataOrBlobId:
    | { case: undefined; value?: undefined }
    | { case: "blobId"; value: Uint8Array }
    | { case: "data"; value: Uint8Array }
    | { case: "blobIdWithData"; value: SelectedImage_BlobIdWithData };
}

export const SelectedImageSchema: MessageCodec<SelectedImage> =
  pb<SelectedImage>("agent.v1.SelectedImage", [
    { no: 2, name: "uuid", kind: "string" },
    { no: 3, name: "path", kind: "string" },
    {
      no: 4,
      name: "dimension",
      kind: "message",
      T: () => SelectedImage_DimensionSchema,
    },
    { no: 7, name: "mimeType", kind: "string" },
    {
      kind: "oneof",
      name: "dataOrBlobId",
      variants: [
        { no: 1, name: "blobId", kind: "bytes" },
        { no: 8, name: "data", kind: "bytes" },
        {
          no: 9,
          name: "blobIdWithData",
          kind: "message",
          T: () => SelectedImage_BlobIdWithDataSchema,
        },
      ],
    },
  ]);

export interface SelectedImage_BlobIdWithData extends ProtoMessage {
  blobId: Uint8Array;
  data: Uint8Array;
}

export const SelectedImage_BlobIdWithDataSchema: MessageCodec<SelectedImage_BlobIdWithData> =
  pb<SelectedImage_BlobIdWithData>("agent.v1.SelectedImage_BlobIdWithData", [
    { no: 1, name: "blobId", kind: "bytes" },
    { no: 2, name: "data", kind: "bytes" },
  ]);

export interface SelectedImage_Dimension extends ProtoMessage {
  width: number;
  height: number;
}

export const SelectedImage_DimensionSchema: MessageCodec<SelectedImage_Dimension> =
  pb<SelectedImage_Dimension>("agent.v1.SelectedImage_Dimension", [
    { no: 1, name: "width", kind: "int32" },
    { no: 2, name: "height", kind: "int32" },
  ]);

export interface ConversationTurnStructure extends ProtoMessage {
  turn:
    | { case: undefined; value?: undefined }
    | { case: "agentConversationTurn"; value: AgentConversationTurnStructure };
}

export const ConversationTurnStructureSchema: MessageCodec<ConversationTurnStructure> =
  pb<ConversationTurnStructure>("agent.v1.ConversationTurnStructure", [
    {
      kind: "oneof",
      name: "turn",
      variants: [
        {
          no: 1,
          name: "agentConversationTurn",
          kind: "message",
          T: () => AgentConversationTurnStructureSchema,
        },
      ],
    },
  ]);

export interface AgentConversationTurnStructure extends ProtoMessage {
  userMessage: Uint8Array;
  steps: Uint8Array[];
  requestId?: string;
}

export const AgentConversationTurnStructureSchema: MessageCodec<AgentConversationTurnStructure> =
  pb<AgentConversationTurnStructure>(
    "agent.v1.AgentConversationTurnStructure",
    [
      { no: 1, name: "userMessage", kind: "bytes" },
      { no: 2, name: "steps", kind: "bytes", repeat: true },
      { no: 3, name: "requestId", kind: "string", optional: true },
    ],
  );

export interface ConversationStep extends ProtoMessage {
  message:
    | { case: undefined; value?: undefined }
    | { case: "assistantMessage"; value: AssistantMessage }
    | { case: "thinkingMessage"; value: ThinkingMessage };
}

export const ConversationStepSchema: MessageCodec<ConversationStep> =
  pb<ConversationStep>("agent.v1.ConversationStep", [
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 1,
          name: "assistantMessage",
          kind: "message",
          T: () => AssistantMessageSchema,
        },
        {
          no: 3,
          name: "thinkingMessage",
          kind: "message",
          T: () => ThinkingMessageSchema,
        },
      ],
    },
  ]);

export interface AssistantMessage extends ProtoMessage {
  text: string;
}

export const AssistantMessageSchema: MessageCodec<AssistantMessage> =
  pb<AssistantMessage>("agent.v1.AssistantMessage", [
    { no: 1, name: "text", kind: "string" },
  ]);

export interface ThinkingMessage extends ProtoMessage {
  text: string;
  durationMs: number;
}

export const ThinkingMessageSchema: MessageCodec<ThinkingMessage> =
  pb<ThinkingMessage>("agent.v1.ThinkingMessage", [
    { no: 1, name: "text", kind: "string" },
    { no: 2, name: "durationMs", kind: "uint32" },
  ]);

export interface ModelDetails extends ProtoMessage {
  modelId: string;
  displayModelId: string;
  displayName: string;
  displayNameShort: string;
  aliases: string[];
  thinkingDetails?: ThinkingDetails;
  maxMode?: boolean;
}

export const ModelDetailsSchema: MessageCodec<ModelDetails> = pb<ModelDetails>(
  "agent.v1.ModelDetails",
  [
    { no: 1, name: "modelId", kind: "string" },
    { no: 3, name: "displayModelId", kind: "string" },
    { no: 4, name: "displayName", kind: "string" },
    { no: 5, name: "displayNameShort", kind: "string" },
    { no: 6, name: "aliases", kind: "string", repeat: true },
    {
      no: 2,
      name: "thinkingDetails",
      kind: "message",
      T: () => ThinkingDetailsSchema,
    },
    { no: 7, name: "maxMode", kind: "bool", optional: true },
  ],
);

export interface ThinkingDetails extends ProtoMessage {}

export const ThinkingDetailsSchema: MessageCodec<ThinkingDetails> =
  pb<ThinkingDetails>("agent.v1.ThinkingDetails", []);

export interface RequestedModel extends ProtoMessage {
  modelId: string;
  maxMode: boolean;
  parameters: RequestedModel_ModelParameterbytes[];
}

export const RequestedModelSchema: MessageCodec<RequestedModel> =
  pb<RequestedModel>("agent.v1.RequestedModel", [
    { no: 1, name: "modelId", kind: "string" },
    { no: 2, name: "maxMode", kind: "bool" },
    {
      no: 3,
      name: "parameters",
      kind: "message",
      T: () => RequestedModel_ModelParameterbytesSchema,
      repeat: true,
    },
  ]);

export interface RequestedModel_ModelParameterbytes extends ProtoMessage {
  id: string;
  value: string;
}

export const RequestedModel_ModelParameterbytesSchema: MessageCodec<RequestedModel_ModelParameterbytes> =
  pb<RequestedModel_ModelParameterbytes>(
    "agent.v1.RequestedModel_ModelParameterbytes",
    [
      { no: 1, name: "id", kind: "string" },
      { no: 2, name: "value", kind: "string" },
    ],
  );

export interface ClientHeartbeat extends ProtoMessage {}

export const ClientHeartbeatSchema: MessageCodec<ClientHeartbeat> =
  pb<ClientHeartbeat>("agent.v1.ClientHeartbeat", []);

export interface GetBlobArgs extends ProtoMessage {
  blobId: Uint8Array;
}

export const GetBlobArgsSchema: MessageCodec<GetBlobArgs> = pb<GetBlobArgs>(
  "agent.v1.GetBlobArgs",
  [{ no: 1, name: "blobId", kind: "bytes" }],
);

export interface GetBlobResult extends ProtoMessage {
  blobData?: Uint8Array;
}

export const GetBlobResultSchema: MessageCodec<GetBlobResult> =
  pb<GetBlobResult>("agent.v1.GetBlobResult", [
    { no: 1, name: "blobData", kind: "bytes", optional: true },
  ]);

export interface SetBlobArgs extends ProtoMessage {
  blobId: Uint8Array;
  blobData: Uint8Array;
}

export const SetBlobArgsSchema: MessageCodec<SetBlobArgs> = pb<SetBlobArgs>(
  "agent.v1.SetBlobArgs",
  [
    { no: 1, name: "blobId", kind: "bytes" },
    { no: 2, name: "blobData", kind: "bytes" },
  ],
);

export interface SetBlobResult extends ProtoMessage {}

export const SetBlobResultSchema: MessageCodec<SetBlobResult> =
  pb<SetBlobResult>("agent.v1.SetBlobResult", []);

export interface KvClientMessage extends ProtoMessage {
  id: number;
  message:
    | { case: undefined; value?: undefined }
    | { case: "getBlobResult"; value: GetBlobResult }
    | { case: "setBlobResult"; value: SetBlobResult };
}

export const KvClientMessageSchema: MessageCodec<KvClientMessage> =
  pb<KvClientMessage>("agent.v1.KvClientMessage", [
    { no: 1, name: "id", kind: "uint32" },
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 2,
          name: "getBlobResult",
          kind: "message",
          T: () => GetBlobResultSchema,
        },
        {
          no: 3,
          name: "setBlobResult",
          kind: "message",
          T: () => SetBlobResultSchema,
        },
      ],
    },
  ]);

export interface KvServerMessage extends ProtoMessage {
  id: number;
  message:
    | { case: undefined; value?: undefined }
    | { case: "getBlobArgs"; value: GetBlobArgs }
    | { case: "setBlobArgs"; value: SetBlobArgs };
}

export const KvServerMessageSchema: MessageCodec<KvServerMessage> =
  pb<KvServerMessage>("agent.v1.KvServerMessage", [
    { no: 1, name: "id", kind: "uint32" },
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 2,
          name: "getBlobArgs",
          kind: "message",
          T: () => GetBlobArgsSchema,
        },
        {
          no: 3,
          name: "setBlobArgs",
          kind: "message",
          T: () => SetBlobArgsSchema,
        },
      ],
    },
  ]);

/** Exec context is the only server-side interaction answered successfully. */
export interface CursorRuleTypeGlobal extends ProtoMessage {}

export const CursorRuleTypeGlobalSchema: MessageCodec<CursorRuleTypeGlobal> =
  pb<CursorRuleTypeGlobal>("agent.v1.CursorRuleTypeGlobal", []);

export interface CursorRuleType extends ProtoMessage {
  type:
    | { case: undefined; value?: undefined }
    | { case: "global"; value: CursorRuleTypeGlobal };
}

export const CursorRuleTypeSchema: MessageCodec<CursorRuleType> =
  pb<CursorRuleType>("agent.v1.CursorRuleType", [
    {
      kind: "oneof",
      name: "type",
      variants: [
        {
          no: 1,
          name: "global",
          kind: "message",
          T: () => CursorRuleTypeGlobalSchema,
        },
      ],
    },
  ]);

export interface CursorRule extends ProtoMessage {
  fullPath: string;
  content: string;
  type?: CursorRuleType;
  source: number;
}

export const CursorRuleSchema: MessageCodec<CursorRule> = pb<CursorRule>(
  "agent.v1.CursorRule",
  [
    { no: 1, name: "fullPath", kind: "string" },
    { no: 2, name: "content", kind: "string" },
    { no: 3, name: "type", kind: "message", T: () => CursorRuleTypeSchema },
    { no: 4, name: "source", kind: "int32" },
  ],
);

/** Empty definitions deliberately make the request-context tool list empty. */
export interface McpToolDefinition extends ProtoMessage {}

export const McpToolDefinitionSchema: MessageCodec<McpToolDefinition> =
  pb<McpToolDefinition>("agent.v1.McpToolDefinition", []);

export interface RequestContext extends ProtoMessage {
  rules: CursorRule[];
  tools: McpToolDefinition[];
}

export const RequestContextSchema: MessageCodec<RequestContext> =
  pb<RequestContext>("agent.v1.RequestContext", [
    {
      no: 2,
      name: "rules",
      kind: "message",
      T: () => CursorRuleSchema,
      repeat: true,
    },
    {
      no: 7,
      name: "tools",
      kind: "message",
      T: () => McpToolDefinitionSchema,
      repeat: true,
    },
  ]);

export interface RequestContextArgs extends ProtoMessage {
  notesSessionId?: string;
  workspaceId?: string;
  readOnlyPinnedTreeSha?: string;
  readOnlyPluginCacheRoot?: string;
  useCached?: boolean;
}

export const RequestContextArgsSchema: MessageCodec<RequestContextArgs> =
  pb<RequestContextArgs>("agent.v1.RequestContextArgs", [
    { no: 2, name: "notesSessionId", kind: "string", optional: true },
    { no: 3, name: "workspaceId", kind: "string", optional: true },
    { no: 4, name: "readOnlyPinnedTreeSha", kind: "string", optional: true },
    { no: 5, name: "readOnlyPluginCacheRoot", kind: "string", optional: true },
    { no: 7, name: "useCached", kind: "bool", optional: true },
  ]);

export interface RequestContextSuccess extends ProtoMessage {
  requestContext?: RequestContext;
  servedFromDiskCache?: boolean;
}

export const RequestContextSuccessSchema: MessageCodec<RequestContextSuccess> =
  pb<RequestContextSuccess>("agent.v1.RequestContextSuccess", [
    {
      no: 1,
      name: "requestContext",
      kind: "message",
      T: () => RequestContextSchema,
    },
    { no: 2, name: "servedFromDiskCache", kind: "bool", optional: true },
  ]);

export interface RequestContextError extends ProtoMessage {
  error: string;
}

export const RequestContextErrorSchema: MessageCodec<RequestContextError> =
  pb<RequestContextError>("agent.v1.RequestContextError", [
    { no: 1, name: "error", kind: "string" },
  ]);

export interface RequestContextRejected extends ProtoMessage {
  reason: string;
}

export const RequestContextRejectedSchema: MessageCodec<RequestContextRejected> =
  pb<RequestContextRejected>("agent.v1.RequestContextRejected", [
    { no: 1, name: "reason", kind: "string" },
  ]);

export interface RequestContextResult extends ProtoMessage {
  result:
    | { case: undefined; value?: undefined }
    | { case: "success"; value: RequestContextSuccess }
    | { case: "error"; value: RequestContextError }
    | { case: "rejected"; value: RequestContextRejected };
}

export const RequestContextResultSchema: MessageCodec<RequestContextResult> =
  pb<RequestContextResult>("agent.v1.RequestContextResult", [
    {
      kind: "oneof",
      name: "result",
      variants: [
        {
          no: 1,
          name: "success",
          kind: "message",
          T: () => RequestContextSuccessSchema,
        },
        {
          no: 2,
          name: "error",
          kind: "message",
          T: () => RequestContextErrorSchema,
        },
        {
          no: 3,
          name: "rejected",
          kind: "message",
          T: () => RequestContextRejectedSchema,
        },
      ],
    },
  ]);

export interface ExecClientMessage extends ProtoMessage {
  id: number;
  execId: string;
  message:
    | { case: undefined; value?: undefined }
    | { case: "requestContextResult"; value: RequestContextResult };
}

export const ExecClientMessageSchema: MessageCodec<ExecClientMessage> =
  pb<ExecClientMessage>("agent.v1.ExecClientMessage", [
    { no: 1, name: "id", kind: "uint32" },
    { no: 15, name: "execId", kind: "string" },
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 10,
          name: "requestContextResult",
          kind: "message",
          T: () => RequestContextResultSchema,
        },
      ],
    },
  ]);

export interface ExecClientStreamClose extends ProtoMessage {
  id: number;
}

export const ExecClientStreamCloseSchema: MessageCodec<ExecClientStreamClose> =
  pb<ExecClientStreamClose>("agent.v1.ExecClientStreamClose", [
    { no: 1, name: "id", kind: "uint32" },
  ]);

export interface ExecClientThrow extends ProtoMessage {
  id: number;
  error: string;
  stackTrace?: string;
  errorCode?: string;
}

export const ExecClientThrowSchema: MessageCodec<ExecClientThrow> =
  pb<ExecClientThrow>("agent.v1.ExecClientThrow", [
    { no: 1, name: "id", kind: "uint32" },
    { no: 2, name: "error", kind: "string" },
    { no: 3, name: "stackTrace", kind: "string", optional: true },
    { no: 4, name: "errorCode", kind: "string", optional: true },
  ]);

export interface ExecClientControlMessage extends ProtoMessage {
  message:
    | { case: undefined; value?: undefined }
    | { case: "streamClose"; value: ExecClientStreamClose }
    | { case: "throw"; value: ExecClientThrow };
}

export const ExecClientControlMessageSchema: MessageCodec<ExecClientControlMessage> =
  pb<ExecClientControlMessage>("agent.v1.ExecClientControlMessage", [
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 1,
          name: "streamClose",
          kind: "message",
          T: () => ExecClientStreamCloseSchema,
        },
        {
          no: 2,
          name: "throw",
          kind: "message",
          T: () => ExecClientThrowSchema,
        },
      ],
    },
  ]);

export interface ExecServerMessage extends ProtoMessage {
  id: number;
  execId: string;
  message:
    | { case: undefined; value?: undefined }
    | { case: "requestContextArgs"; value: RequestContextArgs };
}

export const ExecServerMessageSchema: MessageCodec<ExecServerMessage> =
  pb<ExecServerMessage>("agent.v1.ExecServerMessage", [
    { no: 1, name: "id", kind: "uint32" },
    { no: 15, name: "execId", kind: "string" },
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 10,
          name: "requestContextArgs",
          kind: "message",
          T: () => RequestContextArgsSchema,
        },
      ],
    },
  ]);

export interface AgentServerMessage extends ProtoMessage {
  message:
    | { case: undefined; value?: undefined }
    | { case: "interactionUpdate"; value: InteractionUpdate }
    | { case: "execServerMessage"; value: ExecServerMessage }
    | { case: "kvServerMessage"; value: KvServerMessage }
    | { case: "interactionQuery"; value: InteractionQuery };
}

export const AgentServerMessageSchema: MessageCodec<AgentServerMessage> =
  pb<AgentServerMessage>("agent.v1.AgentServerMessage", [
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 1,
          name: "interactionUpdate",
          kind: "message",
          T: () => InteractionUpdateSchema,
        },
        {
          no: 2,
          name: "execServerMessage",
          kind: "message",
          T: () => ExecServerMessageSchema,
        },
        {
          no: 4,
          name: "kvServerMessage",
          kind: "message",
          T: () => KvServerMessageSchema,
        },
        {
          no: 7,
          name: "interactionQuery",
          kind: "message",
          T: () => InteractionQuerySchema,
        },
      ],
    },
  ]);

/**
 * Queries require an interactive client answer. This provider has no UI or
 * tool execution channel, so it recognizes the envelope and fails the turn
 * explicitly instead of silently dropping a server request.
 */
export interface InteractionQuery extends ProtoMessage {
  id: number;
  query:
    | { case: undefined; value?: undefined }
    | { case: "webSearchRequestQuery"; value: InteractionQueryPayload }
    | { case: "askQuestionInteractionQuery"; value: InteractionQueryPayload }
    | { case: "switchModeRequestQuery"; value: InteractionQueryPayload }
    | { case: "exaSearchRequestQuery"; value: InteractionQueryPayload }
    | { case: "exaFetchRequestQuery"; value: InteractionQueryPayload }
    | { case: "createPlanRequestQuery"; value: InteractionQueryPayload }
    | { case: "setupVmEnvironmentArgs"; value: InteractionQueryPayload }
    | { case: "webFetchRequestQuery"; value: InteractionQueryPayload };
}

export interface InteractionQueryPayload extends ProtoMessage {}

export const InteractionQueryPayloadSchema: MessageCodec<InteractionQueryPayload> =
  pb<InteractionQueryPayload>("agent.v1.InteractionQueryPayload", []);

export const InteractionQuerySchema: MessageCodec<InteractionQuery> =
  pb<InteractionQuery>("agent.v1.InteractionQuery", [
    { no: 1, name: "id", kind: "uint32" },
    {
      kind: "oneof",
      name: "query",
      variants: [
        {
          no: 2,
          name: "webSearchRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 3,
          name: "askQuestionInteractionQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 4,
          name: "switchModeRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 5,
          name: "exaSearchRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 6,
          name: "exaFetchRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 7,
          name: "createPlanRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 8,
          name: "setupVmEnvironmentArgs",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
        {
          no: 9,
          name: "webFetchRequestQuery",
          kind: "message",
          T: () => InteractionQueryPayloadSchema,
        },
      ],
    },
  ]);

export interface InteractionUpdate extends ProtoMessage {
  message:
    | { case: undefined; value?: undefined }
    | { case: "textDelta"; value: TextDeltaUpdate }
    | { case: "partialToolCall"; value: ToolInteractionUpdate }
    | { case: "toolCallDelta"; value: ToolInteractionUpdate }
    | { case: "toolCallStarted"; value: ToolInteractionUpdate }
    | { case: "toolCallCompleted"; value: ToolInteractionUpdate }
    | { case: "thinkingDelta"; value: ThinkingDeltaUpdate }
    | { case: "thinkingCompleted"; value: ThinkingCompletedUpdate }
    | { case: "tokenDelta"; value: TokenDeltaUpdate }
    | { case: "heartbeat"; value: HeartbeatUpdate }
    | { case: "turnEnded"; value: TurnEndedUpdate };
}

export const InteractionUpdateSchema: MessageCodec<InteractionUpdate> =
  pb<InteractionUpdate>("agent.v1.InteractionUpdate", [
    {
      kind: "oneof",
      name: "message",
      variants: [
        {
          no: 1,
          name: "textDelta",
          kind: "message",
          T: () => TextDeltaUpdateSchema,
        },
        {
          no: 7,
          name: "partialToolCall",
          kind: "message",
          T: () => ToolInteractionUpdateSchema,
        },
        {
          no: 15,
          name: "toolCallDelta",
          kind: "message",
          T: () => ToolInteractionUpdateSchema,
        },
        {
          no: 2,
          name: "toolCallStarted",
          kind: "message",
          T: () => ToolInteractionUpdateSchema,
        },
        {
          no: 3,
          name: "toolCallCompleted",
          kind: "message",
          T: () => ToolInteractionUpdateSchema,
        },
        {
          no: 4,
          name: "thinkingDelta",
          kind: "message",
          T: () => ThinkingDeltaUpdateSchema,
        },
        {
          no: 5,
          name: "thinkingCompleted",
          kind: "message",
          T: () => ThinkingCompletedUpdateSchema,
        },
        {
          no: 8,
          name: "tokenDelta",
          kind: "message",
          T: () => TokenDeltaUpdateSchema,
        },
        {
          no: 13,
          name: "heartbeat",
          kind: "message",
          T: () => HeartbeatUpdateSchema,
        },
        {
          no: 14,
          name: "turnEnded",
          kind: "message",
          T: () => TurnEndedUpdateSchema,
        },
      ],
    },
  ]);

export interface ToolInteractionUpdate extends ProtoMessage {}

export const ToolInteractionUpdateSchema: MessageCodec<ToolInteractionUpdate> =
  pb<ToolInteractionUpdate>("agent.v1.ToolInteractionUpdate", []);

export interface TextDeltaUpdate extends ProtoMessage {
  text: string;
}

export const TextDeltaUpdateSchema: MessageCodec<TextDeltaUpdate> =
  pb<TextDeltaUpdate>("agent.v1.TextDeltaUpdate", [
    { no: 1, name: "text", kind: "string" },
  ]);

export interface ThinkingDeltaUpdate extends ProtoMessage {
  text: string;
}

export const ThinkingDeltaUpdateSchema: MessageCodec<ThinkingDeltaUpdate> =
  pb<ThinkingDeltaUpdate>("agent.v1.ThinkingDeltaUpdate", [
    { no: 1, name: "text", kind: "string" },
  ]);

export interface ThinkingCompletedUpdate extends ProtoMessage {
  thinkingDurationMs: number;
}

export const ThinkingCompletedUpdateSchema: MessageCodec<ThinkingCompletedUpdate> =
  pb<ThinkingCompletedUpdate>("agent.v1.ThinkingCompletedUpdate", [
    { no: 1, name: "thinkingDurationMs", kind: "int32" },
  ]);

export interface TokenDeltaUpdate extends ProtoMessage {
  tokens: number;
}

export const TokenDeltaUpdateSchema: MessageCodec<TokenDeltaUpdate> =
  pb<TokenDeltaUpdate>("agent.v1.TokenDeltaUpdate", [
    { no: 1, name: "tokens", kind: "int32" },
  ]);

export interface HeartbeatUpdate extends ProtoMessage {}

export const HeartbeatUpdateSchema: MessageCodec<HeartbeatUpdate> =
  pb<HeartbeatUpdate>("agent.v1.HeartbeatUpdate", []);

export interface TurnEndedUpdate extends ProtoMessage {}

export const TurnEndedUpdateSchema: MessageCodec<TurnEndedUpdate> =
  pb<TurnEndedUpdate>("agent.v1.TurnEndedUpdate", []);

export interface GetUsableModelsRequest extends ProtoMessage {
  customModelIds: string[];
}

export const GetUsableModelsRequestSchema: MessageCodec<GetUsableModelsRequest> =
  pb<GetUsableModelsRequest>("agent.v1.GetUsableModelsRequest", [
    { no: 1, name: "customModelIds", kind: "string", repeat: true },
  ]);

export interface GetUsableModelsResponse extends ProtoMessage {
  models: ModelDetails[];
}

export const GetUsableModelsResponseSchema: MessageCodec<GetUsableModelsResponse> =
  pb<GetUsableModelsResponse>("agent.v1.GetUsableModelsResponse", [
    {
      no: 1,
      name: "models",
      kind: "message",
      T: () => ModelDetailsSchema,
      repeat: true,
    },
  ]);
