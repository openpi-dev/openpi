import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderRecap } from "./src/ui.ts";

const colors: string[] = [];
const theme = {
  fg: (name: string, text: string) => {
    colors.push(name);
    return text;
  },
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
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

  assert.doesNotMatch(component.render(100).join("\n"), /next:/);
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

  assert.match(output, /※ recap: Everything is pushed\./);
  assert.doesNotMatch(output, /Run recap|✦|seal|deepseek|off|local fallback/);
  assert.doesNotMatch(output, /\n\s*\n/);
});

test("uses only subdued text styling and renders next when needed", () => {
  colors.length = 0;
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

  assert.match(component.render(100).join("\n"), /※ next: Run \/reload\./);
  assert.ok(colors.length > 0);
  assert.deepEqual(new Set(colors), new Set(["dim"]));
});
