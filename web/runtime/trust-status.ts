export type WebProjectTrustState =
  | "trusted"
  | "untrusted"
  | "restricted"
  | "unknown";

export type WebProjectTrustDecision =
  | "trusted"
  | "denied"
  | "undecided"
  | "unknown";

export interface WebProjectTrustStatus {
  readonly source: "pi-project-trust";
  readonly workspace?: string;
  readonly state: WebProjectTrustState;
  readonly decision: WebProjectTrustDecision;
  readonly projectResources: boolean | "unknown";
  readonly sessionTrusted: boolean | "unknown";
  readonly refreshRequired: boolean | "unknown";
}

export interface WebProjectTrustFacts {
  readonly workspace?: string;
  readonly storedDecision?: boolean | null;
  readonly projectResources?: boolean;
  readonly sessionTrusted?: boolean;
}

export function projectWebTrustStatus(
  facts: WebProjectTrustFacts,
): WebProjectTrustStatus {
  if (
    facts.workspace === undefined ||
    facts.storedDecision === undefined ||
    facts.projectResources === undefined ||
    facts.sessionTrusted === undefined
  ) {
    return {
      source: "pi-project-trust",
      ...(facts.workspace ? { workspace: facts.workspace } : {}),
      state: "unknown",
      decision: "unknown",
      projectResources: facts.projectResources ?? "unknown",
      sessionTrusted: facts.sessionTrusted ?? "unknown",
      refreshRequired: "unknown",
    };
  }

  const decision =
    facts.storedDecision === true
      ? ("trusted" as const)
      : facts.storedDecision === false
        ? ("denied" as const)
        : ("undecided" as const);
  const state = facts.sessionTrusted
    ? ("trusted" as const)
    : facts.storedDecision === false
      ? ("untrusted" as const)
      : facts.projectResources
        ? ("restricted" as const)
        : ("unknown" as const);
  const storedTrusted = facts.storedDecision === true;
  return {
    source: "pi-project-trust",
    workspace: facts.workspace,
    state,
    decision,
    projectResources: facts.projectResources,
    sessionTrusted: facts.sessionTrusted,
    refreshRequired:
      facts.projectResources && storedTrusted !== facts.sessionTrusted,
  };
}
