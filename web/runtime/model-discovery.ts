import {
  boundedText,
  jsonByteLength,
  WEB_MAX_MODEL_QUERY,
  WEB_MAX_MODEL_SEARCH_BYTES,
  WEB_MAX_MODEL_SEARCH_RESULTS,
  type WebModelSearchResult,
  type WebModelSummary,
} from "../protocol/types.ts";

const WEB_MAX_MODEL_DISPLAY_TEXT = 500;

function resultWithByteEvidence(
  models: WebModelSummary[],
  totalAvailable: number,
  totalMatches: number,
  maxResults: number,
) {
  const base = {
    models,
    totalAvailable,
    totalMatches,
    truncation: {
      truncated: totalMatches > models.length,
      matchesOmitted: totalMatches - models.length,
      maxResults,
      maxBytes: WEB_MAX_MODEL_SEARCH_BYTES,
      bytes: 0,
    },
  } satisfies WebModelSearchResult;
  let bytes = jsonByteLength(base);
  for (;;) {
    const result = {
      ...base,
      truncation: { ...base.truncation, bytes },
    } satisfies WebModelSearchResult;
    const measured = jsonByteLength(result);
    if (measured === bytes) return result;
    bytes = measured;
  }
}

export function projectWebModelSearch(
  allModels: readonly WebModelSummary[],
  query: string,
  limit = WEB_MAX_MODEL_SEARCH_RESULTS,
) {
  const normalizedQuery = query
    .trim()
    .slice(0, WEB_MAX_MODEL_QUERY)
    .toLocaleLowerCase();
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
  const matches = allModels.filter((model) => {
    const haystack = [model.provider, model.id, model.name, model.label]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const maxResults = Math.max(
    1,
    Math.min(WEB_MAX_MODEL_SEARCH_RESULTS, Math.trunc(limit)),
  );
  const models: WebModelSummary[] = [];
  for (const model of matches) {
    if (models.length >= maxResults) break;
    const projected = {
      ...model,
      name: boundedText(model.name, WEB_MAX_MODEL_DISPLAY_TEXT),
      label: boundedText(model.label, WEB_MAX_MODEL_DISPLAY_TEXT),
    };
    const candidate = resultWithByteEvidence(
      [...models, projected],
      allModels.length,
      matches.length,
      maxResults,
    );
    if (candidate.truncation.bytes <= WEB_MAX_MODEL_SEARCH_BYTES) {
      models.push(projected);
    }
  }
  return resultWithByteEvidence(
    models,
    allModels.length,
    matches.length,
    maxResults,
  );
}
