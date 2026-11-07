import type { WebGitReviewSource } from "../../../../protocol/types.ts";

/** Identity of the displayed bounded review projection, not a retained file snapshot. */
export interface ReviewSourceIdentity {
  repositoryRoot: string;
  comparison: WebGitReviewSource;
  revision: string;
}

export interface PlanTextReference {
  kind: "plan";
  sessionId: string;
  sessionPath: string;
  entryId?: string;
  toolCallId?: string;
  text: string;
}

export const REVIEW_REFERENCE_TEXT_LIMIT = 8000;
