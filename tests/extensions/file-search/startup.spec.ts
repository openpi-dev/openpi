import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import fileSearchTools from "../../../extensions/file-search/index.ts";
import { liveBinaryEnv } from "../../../extensions/file-search/src/binaries.ts";

afterEach(() => vi.restoreAllMocks());

it("does not block headless parent or child startup on optional search binary initialization", async () => {
  const probe = vi.spyOn(liveBinaryEnv, "probe").mockReturnValue(Effect.never);
  let sessionStart:
    | ((event: unknown, context: ExtensionContext) => unknown)
    | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start")
        sessionStart = handler as typeof sessionStart;
    },
    registerTool() {},
    getActiveTools: () => ["read", "bash"],
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  fileSearchTools(pi);
  expect(sessionStart).toBeDefined();
  const result = await Promise.race([
    Promise.resolve(
      sessionStart!({}, { hasUI: false, mode: "print" } as ExtensionContext),
    ).then(() => "ready"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  expect(result).toBe("ready");
  expect(probe).not.toHaveBeenCalled();
});
