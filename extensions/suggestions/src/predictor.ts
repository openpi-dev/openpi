import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Data, Effect } from "effect";
import { sanitizeTerminalText } from "../../shared/terminal-text.ts";
import type { SuggestionConfig } from "./config.ts";
import { buildSuggestionPrompt, SUGGESTION_SYSTEM_PROMPT } from "./prompt.ts";

const SUGGESTION_MAX_CHARS = 200;

class PredictionError extends Data.TaggedError("PredictionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function cleanSuggestion(value: string) {
  const oneLine = sanitizeTerminalText(value)
    .normalize("NFC")
    // Model output is untrusted editor input. Format controls can create an
    // invisible or direction-spoofed suggestion, so never offer them.
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = [...oneLine].slice(0, SUGGESTION_MAX_CHARS).join("");
  return visibleWidth(bounded) > 0 ? bounded : "";
}

function parseCandidate(candidate: string): string | undefined | null {
  try {
    const value: unknown = JSON.parse(candidate);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).join(",") !== "suggestion" ||
      !("suggestion" in value)
    ) {
      return null;
    }
    if (value.suggestion === null) return undefined;
    if (typeof value.suggestion !== "string") return null;
    return cleanSuggestion(value.suggestion) || undefined;
  } catch {
    return null;
  }
}

export function parseSuggestionResponse(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed !== null) return parsed;
  }
  throw new PredictionError({
    message: "The prediction model did not return valid suggestion JSON.",
  });
}

export function reasoningOptions(reasoning: SuggestionConfig["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

function assistantText(
  content: Awaited<ReturnType<typeof completeSimple>>["content"],
) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function predictNextAction(options: {
  readonly modelRegistry: ModelRegistry;
  readonly config: SuggestionConfig;
  readonly transcript: string;
  readonly signal: AbortSignal;
}) {
  const completion = Effect.tryPromise({
    try: async (effectSignal) => {
      const model = options.modelRegistry.find(
        options.config.provider,
        options.config.model,
      );
      if (!model) {
        throw new PredictionError({
          message: `Suggestion model is unavailable: ${options.config.provider}/${options.config.model}`,
        });
      }

      const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new PredictionError({ message: auth.error });

      const response = await completeSimple(
        model,
        {
          systemPrompt: SUGGESTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildSuggestionPrompt(options.transcript),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          env: auth.env,
          headers: auth.headers,
          maxTokens: 300,
          maxRetries: 1,
          signal: effectSignal,
          timeoutMs: 20_000,
          ...reasoningOptions(options.config.reasoning),
        },
      );

      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted"
      ) {
        throw new PredictionError({
          message: response.errorMessage ?? "Suggestion model request failed.",
        });
      }
      return parseSuggestionResponse(assistantText(response.content));
    },
    catch: (cause) =>
      cause instanceof PredictionError
        ? cause
        : new PredictionError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  }).pipe(Effect.timeout("25 seconds"));

  return Effect.runPromise(completion, { signal: options.signal });
}
