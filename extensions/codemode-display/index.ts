import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CodemodeRenderers, codemodeRenderers } from "./render.ts";

type RendererResolver = (
  toolName: string,
  next: () => CodemodeRenderers | undefined,
) => CodemodeRenderers | undefined;

/** Pi 1.0.2 exposes this presentation-only seam. Older hosts keep native UI. */
export default function codemodeDisplay(pi: ExtensionAPI) {
  const host = pi as ExtensionAPI & {
    registerToolRenderer?: (resolver: RendererResolver) => void;
  };
  if (typeof host.registerToolRenderer !== "function") return;
  host.registerToolRenderer((name, next) =>
    name === "codemode" ? codemodeRenderers : next(),
  );
}
