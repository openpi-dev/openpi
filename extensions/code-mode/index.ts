import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onSetupApply } from "../shared/setup-apply.ts";
import { loadSetupConfig } from "../shared/setup-config.ts";

/** Activate Pi's executor in ordinary parent sessions, without changing Pi settings. */
export function createCodeModeExtension(loadConfig = loadSetupConfig) {
  return (pi: ExtensionAPI) => {
    let activatedByOpenPi = false;
    const reconcile = () => {
      // Native tool selections and SDK/CLI allowlists remain authoritative.
      if (pi.getSettings().defaultTools !== undefined) return;
      if (
        !pi
          .getAllTools()
          .some(
            (tool) =>
              tool.name === "codemode" &&
              tool.sourceInfo?.path === "builtin:codemode",
          )
      )
        return;
      const active = pi.getActiveTools();
      const enabled = loadConfig().codeMode.enabled;
      // An opt-out removes only our default, not an explicit CLI/SDK activation.
      if (!enabled && !activatedByOpenPi) return;
      if (active.includes("codemode") === enabled) return;
      pi.setActiveTools(
        enabled
          ? [...active, "codemode"]
          : active.filter((name) => name !== "codemode"),
      );
      activatedByOpenPi = enabled;
    };
    pi.on("session_start", reconcile);
    onSetupApply(pi, reconcile);
  };
}

export default createCodeModeExtension();
