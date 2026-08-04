/** Built-in subagent role names shared by configuration and spawning. */
export const SUBAGENT_ROLE_NAMES = [
  "explorer",
  "implementer",
  "reviewer",
  "advisor",
] as const;

export type SubagentRoleName = (typeof SUBAGENT_ROLE_NAMES)[number];

export interface SubagentRoleModel {
  readonly provider: string;
  readonly model: string;
}

export type SubagentRoleModels = Partial<
  Record<SubagentRoleName, SubagentRoleModel>
>;

export function isSubagentRoleName(value: string): value is SubagentRoleName {
  return SUBAGENT_ROLE_NAMES.includes(value as SubagentRoleName);
}
