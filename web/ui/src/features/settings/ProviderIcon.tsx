import { Server } from "lucide-react";
import alibaba from "./provider-icons/alibaba.svg?inline";
import bedrock from "./provider-icons/amazon-bedrock.svg?inline";
import anthropic from "./provider-icons/claude-code.png?inline";
import antigravity from "./provider-icons/antigravity.svg?inline";
import azure from "./provider-icons/azure.svg?inline";
import cerebras from "./provider-icons/cerebras.svg?inline";
import cloudflare from "./provider-icons/cloudflare.svg?inline";
import cohere from "./provider-icons/cohere.svg?inline";
import cursor from "./provider-icons/cursor.svg?inline";
import deepinfra from "./provider-icons/deepinfra.svg?inline";
import deepseek from "./provider-icons/deepseek.svg?inline";
import fireworks from "./provider-icons/fireworks-ai.svg?inline";
import copilot from "./provider-icons/github-copilot.svg?inline";
import google from "./provider-icons/google.svg?inline";
import groq from "./provider-icons/groq.svg?inline";
import huggingface from "./provider-icons/huggingface.svg?inline";
import hunyuan from "./provider-icons/hunyuan.svg?inline";
import kimi from "./provider-icons/kimi-for-coding.svg?inline";
import meta from "./provider-icons/llama.svg?inline";
import lmstudio from "./provider-icons/lmstudio.svg?inline";
import localai from "./provider-icons/localai.svg?inline";
import minimax from "./provider-icons/minimax.svg?inline";
import mistral from "./provider-icons/mistral.svg?inline";
import moonshot from "./provider-icons/moonshotai.svg?inline";
import nvidia from "./provider-icons/nvidia.svg?inline";
import ollama from "./provider-icons/ollama.svg?inline";
import openai from "./provider-icons/openai.svg?inline";
import opencode from "./provider-icons/opencode.svg?inline";
import openrouter from "./provider-icons/openrouter.svg?inline";
import siliconcloud from "./provider-icons/siliconcloud.svg?inline";
import stepfun from "./provider-icons/stepfun.svg?inline";
import tencentcloud from "./provider-icons/tencentcloud.svg?inline";
import together from "./provider-icons/togetherai.svg?inline";
import vercel from "./provider-icons/vercel.svg?inline";
import volcengine from "./provider-icons/volcengine.svg?inline";
import xai from "./provider-icons/xai.svg?inline";
import xiaomimimo from "./provider-icons/xiaomimimo.svg?inline";
import zai from "./provider-icons/zai.svg?inline";
import zenmux from "./provider-icons/zenmux.svg?inline";

// Presentation aliases only; Pi's provider IDs and auth methods remain unchanged.
const icons: Record<string, string> = {
  alibaba,
  "alibaba-cn": alibaba,
  "alibaba-coding-plan": alibaba,
  "alibaba-coding-plan-cn": alibaba,
  "alibaba-token-plan": alibaba,
  "alibaba-token-plan-cn": alibaba,
  "amazon-bedrock": bedrock,
  anthropic,
  "claude-subscription": anthropic,
  "google-antigravity": antigravity,
  azure,
  "azure-openai-responses": azure,
  cerebras,
  cloudflare,
  "cloudflare-workers-ai": cloudflare,
  cohere,
  cursor,
  deepinfra,
  deepseek,
  fireworks,
  "fireworks-ai": fireworks,
  "github-copilot": copilot,
  google,
  "google-gemini-cli": google,
  "google-vertex": google,
  groq,
  huggingface,
  hunyuan,
  kimi,
  "kimi-code": kimi,
  "kimi-coding": kimi,
  "kimi-coding-plan": kimi,
  "kimi-for-coding": kimi,
  meta,
  minimax,
  "minimax-cn": minimax,
  "minimax-coding-plan": minimax,
  mistral,
  moonshot,
  "moonshot-global": moonshot,
  moonshotai: moonshot,
  nvidia,
  ollama,
  "ollama-cloud": ollama,
  openai,
  "openai-codex": openai,
  opencode,
  "opencode-free": opencode,
  "opencode-go": opencode,
  openrouter,
  siliconcloud,
  siliconflow: siliconcloud,
  stepfun,
  "stepfun-ai": stepfun,
  "stepfun-ai-step-plan": stepfun,
  "stepfun-step-plan": stepfun,
  tencent: tencentcloud,
  "tencent-coding-plan": tencentcloud,
  "tencent-token-plan": tencentcloud,
  "tencent-tokenhub": hunyuan,
  "lm-studio": lmstudio,
  lmstudio,
  localai,
  "local-ai": localai,
  together,
  togetherai: together,
  vercel,
  volcengine,
  "volcengine-agent-plan": volcengine,
  "volcengine-ark": volcengine,
  "volcengine-coding-plan": volcengine,
  xai,
  "xai-oauth": xai,
  xiaomi: xiaomimimo,
  xiaomimimo,
  "xiaomi-token-plan-ams": xiaomimimo,
  "xiaomi-token-plan-cn": xiaomimimo,
  "xiaomi-token-plan-sgp": xiaomimimo,
  zai,
  "z-ai": zai,
  "zai-coding-plan": zai,
  zenmux,
};

const modelBrandPatterns: [RegExp, string][] = [
  [/deepseek/i, "deepseek"],
  [/(?:xiaomi|mimo)/i, "xiaomimimo"],
  [/kimi/i, "kimi"],
  [/moonshot/i, "moonshot"],
  [/(?:claude|anthropic)/i, "anthropic"],
  [/gemini/i, "google"],
  [/qwen/i, "alibaba"],
  [/llama/i, "meta"],
  [/minimax/i, "minimax"],
  [/(?:mistral|mixtral)/i, "mistral"],
  [/grok/i, "xai"],
  [/(?:openai|chatgpt|gpt[-_.:0-9])/i, "openai"],
  [/(?:^|[^a-z0-9])o[134](?:[^a-z0-9]|$)/i, "openai"],
  [/(?:^|[^a-z0-9])glm[-_.:0-9]/i, "zai"],
  [/doubao/i, "volcengine"],
  [/hunyuan/i, "hunyuan"],
  [/(?:stepfun|(?:^|[/_.:-])step-[0-9])/i, "stepfun"],
  [/(?:cohere|command[-_.:0-9])/i, "cohere"],
];

// Small brand accents only. Text, controls and connection status keep the theme.
const colors: Record<string, string> = {
  anthropic: "#d8765b",
  deepseek: "#4d6bfe",
  google: "#4285f4",
  "google-gemini-cli": "#4285f4",
  "google-vertex": "#4285f4",
  "google-antigravity": "#6387ed",
  meta: "#1685f8",
  azure: "#168cda",
  "azure-openai-responses": "#168cda",
  "amazon-bedrock": "#e99b32",
  alibaba: "#ed7d31",
  "alibaba-cn": "#ed7d31",
  mistral: "#ef8b31",
  nvidia: "#76b900",
  cohere: "#659a81",
  groq: "#ef6847",
};

export function ProviderIcon({
  id,
  modelId,
  modelName,
}: {
  id: string;
  modelId?: string;
  modelName?: string;
}) {
  const providerId = id.trim().toLowerCase();
  const modelText = `${modelId ?? ""} ${modelName ?? ""}`;
  const iconId = Object.hasOwn(icons, providerId)
    ? providerId
    : modelBrandPatterns.find(([pattern]) => pattern.test(modelText))?.[1];
  const icon = iconId ? icons[iconId] : undefined;
  return (
    <span
      className={`models-provider-icon${icon ? "" : " models-provider-connection"}`}
      aria-hidden="true"
      style={
        icon
          ? {
              maskImage: `url("${icon}")`,
              color:
                colors[providerId] ?? (iconId ? colors[iconId] : undefined),
            }
          : undefined
      }
    >
      {!icon && <Server strokeWidth={1.75} />}
    </span>
  );
}
