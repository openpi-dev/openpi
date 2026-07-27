import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderRecap } from "./src/ui.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("does not render Next when no concrete action remains", () => {
  const component = renderRecap(
    {
      recap: "Everything is pushed.",
      provider: "seal",
      model: "deepseek-v4-flash",
      reasoning: "off",
    },
    false,
    theme,
  );

  assert.doesNotMatch(component.render(100).join("\n"), /Next:/);
});

test("omits model metadata and avoids blank spacer rows", () => {
  const component = renderRecap(
    {
      recap: "Everything is pushed.",
      provider: "seal",
      model: "deepseek-v4-flash",
      reasoning: "off",
    },
    true,
    theme,
  );
  const output = component.render(100).join("\n");

  assert.match(output, /Recap: Everything is pushed\./);
  assert.doesNotMatch(output, /Run recap|✦|seal|deepseek|off|local fallback/);
  assert.doesNotMatch(output, /\n\s*\n/);
});

test("renders Next when a concrete action remains", () => {
  const component = renderRecap(
    {
      recap: "Configuration was updated.",
      next: "Run /reload.",
      provider: "seal",
      model: "deepseek-v4-flash",
      reasoning: "off",
    },
    false,
    theme,
  );

  assert.match(component.render(100).join("\n"), /Next: Run \/reload\./);
});
