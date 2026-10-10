import { Server } from "lucide-react";
import alibaba from "./provider-icons/alibaba.svg?inline";
import bedrock from "./provider-icons/amazon-bedrock.svg?inline";
import anthropic from "./provider-icons/anthropic.svg?inline";
import antigravity from "./provider-icons/antigravity.svg?inline";
import azure from "./provider-icons/azure.svg?inline";
import cohere from "./provider-icons/cohere.svg?inline";
import cursor from "./provider-icons/cursor.svg?inline";
import deepseek from "./provider-icons/deepseek.svg?inline";
import fireworks from "./provider-icons/fireworks-ai.svg?inline";
import copilot from "./provider-icons/github-copilot.svg?inline";
import google from "./provider-icons/google.svg?inline";
import groq from "./provider-icons/groq.svg?inline";
import huggingface from "./provider-icons/huggingface.svg?inline";
import kimi from "./provider-icons/kimi-for-coding.svg?inline";
import meta from "./provider-icons/llama.svg?inline";
import minimax from "./provider-icons/minimax.svg?inline";
import mistral from "./provider-icons/mistral.svg?inline";
import moonshot from "./provider-icons/moonshotai.svg?inline";
import nvidia from "./provider-icons/nvidia.svg?inline";
import openai from "./provider-icons/openai.svg?inline";
import openrouter from "./provider-icons/openrouter.svg?inline";
import together from "./provider-icons/togetherai.svg?inline";
import xai from "./provider-icons/xai.svg?inline";
import zai from "./provider-icons/zai.svg?inline";

// Presentation aliases only; Pi's provider IDs and auth methods remain unchanged.
const icons: Record<string, string> = {
  alibaba,
  "alibaba-cn": alibaba,
  "amazon-bedrock": bedrock,
  anthropic,
  "google-antigravity": antigravity,
  azure,
  "azure-openai-responses": azure,
  cohere,
  cursor,
  deepseek,
  fireworks,
  "fireworks-ai": fireworks,
  "github-copilot": copilot,
  google,
  "google-gemini-cli": google,
  "google-vertex": google,
  groq,
  huggingface,
  "kimi-coding": kimi,
  "kimi-for-coding": kimi,
  meta,
  minimax,
  "minimax-cn": minimax,
  mistral,
  moonshot,
  moonshotai: moonshot,
  nvidia,
  openai,
  "openai-codex": openai,
  openrouter,
  together,
  togetherai: together,
  xai,
  zai,
  "z-ai": zai,
};

// Small brand accents only. Text, controls and connection status keep the theme.
const colors: Record<string, string> = {
  anthropic: "#c8795a",
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

export function ProviderIcon({ id }: { id: string }) {
  const icon = Object.hasOwn(icons, id) ? icons[id] : undefined;
  return (
    <span
      className={`models-provider-icon${icon ? "" : " models-provider-connection"}`}
      aria-hidden="true"
      style={
        icon
          ? {
              maskImage: `url("${icon}")`,
              color: Object.hasOwn(colors, id) ? colors[id] : undefined,
            }
          : undefined
      }
    >
      {!icon && <Server strokeWidth={1.75} />}
    </span>
  );
}
