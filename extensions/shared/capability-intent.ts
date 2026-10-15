import {
  OPENPI_CAPABILITY_NAMES,
  type OpenPiCapability,
} from "./tool-surface.ts";

// Runtime inspection is gateway-only; it has no prompt keyword activation.
const CAPABILITY_INTENT: Partial<Record<OpenPiCapability, RegExp>> = {
  search:
    /\b(?:use|run)\s+(?:fd|rg)\b|\buse\s+(?:structured\s+)?(?:(?:file|code|content)\s+)?search\b|\b(?:structured|fast)\s+(?:file|code|content)\s+search\b|(?:使用|用|运行).{0,8}(?:fd|rg|git\s+(?:show|diff|log))|结构化(?:文件|代码|内容)搜索/iu,
  delegate:
    /(?:^|[.!?]\s+)(?:please\s+)?(?:delegate|parallelize)\s+(?:this|the)\s+(?:task|work)\b|\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:delegate|parallelize)\s+(?:this|the)\s+(?:task|work)\b|\bparallel\s+agents?\b|并行.{0,8}(?:代理|agent)|委派.{0,6}(?:任务|给|出去)/iu,
  background:
    /\b(?:run|start|keep)\b.{0,40}\b(?:in the background|background\s+(?:process|terminal|job))\b|后台.{0,8}(?:运行|启动|进程|终端|任务)/iu,
  session:
    /\b(?:create|set|update|track)\s+(?:an?\s+)?(?:session\s+)?(?:goal|task list|tasks)\b|(?:设置|创建|更新|跟踪|追踪).{0,8}(?:目标|任务)/iu,
};

const CAPABILITY_GATEWAY_INTENT =
  /\bopenpi\s+(?:capabilit(?:y|ies)|tools?|features?)\b|openpi.{0,8}(?:能力|工具|功能)/iu;

const CONDITIONAL_OR_NEGATED_INTENT =
  /^(?:\s*(?:only\s+)?(?:if|when|unless|before|in case)\b)|\b(?:do not|don't|cannot|can't|not|no|never|avoid)\b|\b(?:if|unless)\b|\bwhen\s+(?:needed|required|necessary)\b|(?:如果|若|假如|除非|仅当|需要时|不要|不能|不用|不必|无需|避免|请勿|禁止)/iu;

function clauses(prompt: string) {
  return prompt.split(/[\n.!?。！？;；]+/u);
}

function isExplicitClause(clause: string) {
  return !CONDITIONAL_OR_NEGATED_INTENT.test(clause);
}

// Names select discovery, not execution. Keep identifier/path fragments inert.
const CAPABILITY_NAMES =
  /(?<![\w./\\-])(?:subagents?|workflows?|子代理|工作流)(?![\w/\\-]|\.[\p{L}\p{N}_])/giu;

export function capabilityNameMentions(text: string) {
  return [...text.matchAll(CAPABILITY_NAMES)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    capability: /^(?:subagents?|子代理)$/iu.test(match[0])
      ? ("delegate" as const)
      : ("workflow" as const),
  }));
}

/** Mentioning a name loads its guidance/tools; the model decides whether to
 * use them, including discussion, negation and conditional requests. Other
 * capability groups retain their existing explicit request interpretation. */
export function capabilitiesRequestedByPrompt(prompt: string) {
  const mentioned = capabilityNameMentions(prompt);
  const promptClauses = clauses(prompt);
  return OPENPI_CAPABILITY_NAMES.filter(
    (capability) =>
      mentioned.some((mention) => mention.capability === capability) ||
      promptClauses.some(
        (clause) =>
          isExplicitClause(clause) &&
          CAPABILITY_INTENT[capability]?.test(clause),
      ),
  );
}

export function requestsCapabilityGateway(prompt: string) {
  return clauses(prompt).some(
    (clause) =>
      isExplicitClause(clause) && CAPABILITY_GATEWAY_INTENT.test(clause),
  );
}
