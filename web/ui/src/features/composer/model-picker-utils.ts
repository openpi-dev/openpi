import type { WebModelSummary } from "../../../../protocol/types.ts";

export function listProviders(models: readonly WebModelSummary[]) {
  return [...new Set(models.map((model) => model.provider))];
}

export function filterModels(
  models: readonly WebModelSummary[],
  query: string,
) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...models];
  return models.filter((model) =>
    [model.label, model.name, model.id, model.provider].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function formatContextWindow(tokens?: number) {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${millions}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function modelMetaParts(
  model: WebModelSummary,
  labels: { reasoning: string; imageInput: string },
) {
  const parts = [model.provider];
  const contextWindow = formatContextWindow(model.contextWindow);
  if (contextWindow) parts.push(`${contextWindow} ctx`);
  if (model.reasoning) parts.push(labels.reasoning);
  if (model.imageInput) parts.push(labels.imageInput);
  return parts;
}
