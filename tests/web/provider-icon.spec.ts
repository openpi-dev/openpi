// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { ProviderIcon } from "../../web/ui/src/features/settings/ProviderIcon.tsx";

afterEach(cleanup);

function iconResult(props: Parameters<typeof ProviderIcon>[0]) {
  const { container } = render(createElement(ProviderIcon, props));
  const icon = container.querySelector<HTMLElement>(".models-provider-icon");
  if (!icon) throw new Error("Provider icon did not render");
  return {
    style: icon.getAttribute("style") ?? "",
    fallback: icon.classList.contains("models-provider-connection"),
  };
}

it.each([
  [
    "DeepSeek behind a custom gateway",
    { id: "magpie", modelId: "workbuddy/deepseek-v4-pro" },
    "deepseek",
  ],
  [
    "Xiaomi MiMo behind a custom gateway",
    { id: "magpie", modelId: "workbuddy/mimo-v2.6-pro" },
    "xiaomi",
  ],
  ["a Kimi provider alias", { id: "kimi-code", modelId: "k3" }, "kimi-coding"],
  [
    "Kimi identified by its display name",
    { id: "custom", modelId: "k3", modelName: "Kimi K3" },
    "kimi-coding",
  ],
  [
    "DeepSeek behind another custom gateway",
    { id: "bai", modelId: "deepseek-v4.1-flash" },
    "deepseek",
  ],
])("uses the model brand for %s", (_label, props, canonicalProvider) => {
  const actual = iconResult(props);
  const expected = iconResult({ id: canonicalProvider });
  expect(actual.fallback).toBe(false);
  expect(actual.style).toContain("mask-image");
  expect(actual.style).toBe(expected.style);
});

it.each([
  ["cerebras", "cerebras"],
  ["cloudflare-workers-ai", "cloudflare"],
  ["deepinfra", "deepinfra"],
  ["lm-studio", "lmstudio"],
  ["local-ai", "localai"],
  ["ollama-cloud", "ollama"],
  ["opencode-go", "opencode"],
  ["siliconflow", "siliconcloud"],
  ["stepfun-ai", "stepfun"],
  ["tencent-coding-plan", "tencent"],
  ["tencent-tokenhub", "hunyuan"],
  ["vercel", "vercel"],
  ["volcengine-ark", "volcengine"],
  ["xiaomi-token-plan-cn", "xiaomi"],
  ["zenmux", "zenmux"],
])("resolves provider alias %s", (provider, canonicalProvider) => {
  const actual = iconResult({ id: provider });
  const expected = iconResult({ id: canonicalProvider });
  expect(actual.fallback).toBe(false);
  expect(actual.style).toContain("mask-image");
  expect(actual.style).toBe(expected.style);
});

it("keeps a known provider brand instead of replacing it with the model brand", () => {
  const actual = iconResult({ id: "openrouter", modelId: "deepseek-v4" });
  expect(actual.style).toBe(iconResult({ id: "openrouter" }).style);
  expect(actual.style).not.toBe(iconResult({ id: "deepseek" }).style);
});

it("retains the generic connection icon when neither identity is known", () => {
  const result = iconResult({ id: "custom", modelId: "unknown-model" });
  expect(result.fallback).toBe(true);
  expect(result.style).toBe("");
});
