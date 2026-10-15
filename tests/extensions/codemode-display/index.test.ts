import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codemodeDisplay from "../../../extensions/codemode-display/index.ts";
import {
  type CodemodeRenderers,
  codemodeRenderers,
} from "../../../extensions/codemode-display/render.ts";

test("older SDK without renderer resolver is a safe no-op", () => {
  codemodeDisplay(
    new Proxy({} as ExtensionAPI, {
      get(_target, name) {
        assert.equal(
          name,
          "registerToolRenderer",
          "no tools, hooks or executors are replaced",
        );
        return undefined;
      },
    }),
  );
});

test("public renderer registration preserves receiver and delegates every other tool", () => {
  type Resolver = (
    name: string,
    next: () => CodemodeRenderers | undefined,
  ) => CodemodeRenderers | undefined;
  const resolvers: Resolver[] = [];
  const host = {
    registerToolRenderer(resolver: Resolver) {
      assert.equal(this, host);
      resolvers.push(resolver);
    },
  };
  codemodeDisplay(host as unknown as ExtensionAPI);
  assert.equal(resolvers.length, 1);
  const native = { renderShell: "default" as const };
  assert.equal(
    resolvers[0]!("codemode", () => {
      throw new Error("native executor is never requested or replaced");
    }),
    codemodeRenderers,
  );
  assert.equal(
    resolvers[0]!("read", () => native),
    native,
  );
  assert.equal(
    resolvers[0]!("unknown", () => undefined),
    undefined,
  );
  assert.equal(
    resolvers[0]!("codemodeOther", () => native),
    native,
  );
});
