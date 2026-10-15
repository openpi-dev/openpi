import type { Api, Model } from "@earendil-works/pi-ai";

export interface WebSearchModelSupport {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly supported: boolean;
}

export interface WebSearchConfig {
  readonly enabled: boolean;
  /** Explicit declarations for connections not covered by official defaults. */
  readonly modelSupport: readonly WebSearchModelSupport[];
}

export function webSearchConnection(model: Model<Api>) {
  return {
    provider: model.provider,
    model: model.id,
    api: model.api,
    baseUrl: model.baseUrl.replace(/\/+$/u, ""),
  };
}

export function sameWebSearchConnection(
  left: Omit<WebSearchModelSupport, "supported">,
  right: Omit<WebSearchModelSupport, "supported">,
) {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.api === right.api &&
    left.baseUrl === right.baseUrl
  );
}

export function isWebSearchModelSupport(
  value: unknown,
): value is WebSearchModelSupport[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      return (
        ["provider", "model", "api", "baseUrl"].every(
          (key) =>
            typeof item[key] === "string" &&
            item[key].length > 0 &&
            item[key].length <= 2048,
        ) && typeof item.supported === "boolean"
      );
    })
  );
}

/** Protocol and endpoint are authoritative; an OpenAI-compatible name is insufficient. */
export function resolveWebSearchSupport(
  model: Model<Api> | undefined,
  config: WebSearchConfig,
  usingOAuth = false,
) {
  if (!model) return { available: false, reason: "no-model" } as const;
  const adapter =
    model.api === "openai-responses" || model.api === "openai-codex-responses"
      ? "responses"
      : model.api === "anthropic-messages"
        ? "anthropic"
        : undefined;
  if (!adapter)
    return { available: false, reason: "unsupported-protocol" } as const;
  const url = URL.parse(model.baseUrl);
  // DeepSeek's Responses endpoint explicitly ignores hosted web_search tools.
  if (adapter === "responses" && url?.hostname === "api.deepseek.com")
    return { available: false, reason: "unsupported-provider" } as const;
  const connection = webSearchConnection(model);
  const declaration = config.modelSupport.find((entry) =>
    sameWebSearchConnection(entry, connection),
  );
  if (declaration?.supported === false)
    return { available: false, reason: "unsupported-model" } as const;
  if (declaration?.supported === true)
    return { available: true, adapter } as const;
  const official =
    url?.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  if (
    official &&
    adapter === "responses" &&
    ((model.provider === "openai" &&
      model.api === "openai-responses" &&
      url.hostname === "api.openai.com" &&
      /^\/v1\/?$/u.test(url.pathname)) ||
      (model.provider === "openai-codex" &&
        model.api === "openai-codex-responses" &&
        url.hostname === "chatgpt.com" &&
        /^\/backend-api(?:\/codex)?\/?$/u.test(url.pathname))) &&
    // Reviewed official models, not an assumption about future suffixes or variants.
    /^(?:gpt-(?:4\.1(?:-mini)?|5(?:\.[45])?|5\.6-sol|6-astra)|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      model.id,
    )
  ) {
    return { available: true, adapter } as const;
  }
  if (
    official &&
    adapter === "anthropic" &&
    !usingOAuth &&
    model.provider === "anthropic" &&
    url.hostname === "api.anthropic.com" &&
    /^\/(?:v1\/?)?$/u.test(url.pathname) &&
    /^claude-(?:sonnet|opus|haiku)-[45](?:[.-]|$)/u.test(model.id)
  ) {
    return { available: true, adapter } as const;
  }
  return { available: false, reason: "unknown-connection" } as const;
}
