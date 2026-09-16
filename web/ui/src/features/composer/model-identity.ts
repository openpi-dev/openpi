import type { WebModelSummary } from "../../../../protocol/types.ts";

export function modelIdentity(model: WebModelSummary) {
  const identity = `${model.provider}/${model.id}`;
  return model.label === identity ? identity : `${model.label} (${identity})`;
}
