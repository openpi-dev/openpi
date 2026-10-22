import { Dialog } from "@astryxdesign/core/Dialog";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Power } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebClient } from "../../protocol/client.ts";

export function ShutdownButton({ client }: { client: WebClient }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    "idle" | "pending" | "accepted" | "failed"
  >("idle");
  const inFlight = useRef(false);
  const locked = state === "pending" || state === "accepted";

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("pending");
    try {
      const receipt = await client.shutdown();
      if (receipt.accepted !== true)
        throw new Error("Shutdown was not accepted");
      setState("accepted");
    } catch {
      inFlight.current = false;
      setState("failed");
    }
  }

  return (
    <>
      <Tooltip content={t("quitOpenPI")} placement="above">
        <button
          className="sidebar-settings-button"
          type="button"
          aria-label={t("quitOpenPI")}
          onClick={() => {
            setState("idle");
            setOpen(true);
          }}
        >
          <Power aria-hidden="true" />
          <span>{t("quitOpenPI")}</span>
        </button>
      </Tooltip>
      <Dialog
        isOpen={open}
        onOpenChange={(value: boolean) => !locked && setOpen(value)}
        purpose={locked ? "required" : "form"}
        variant={state === "accepted" ? "fullscreen" : "standard"}
        width={460}
        aria-label={t(state === "accepted" ? "quitAccepted" : "quitOpenPI")}
      >
        <div
          className={`openpi-dialog${state === "accepted" ? " openpi-shutdown-screen" : ""}`}
        >
          <strong>
            {t(state === "accepted" ? "quitAccepted" : "quitOpenPI")}
          </strong>
          {state === "accepted" ? (
            <>
              <p role="status">{t("quitAcceptedHelp")}</p>
              <p>{t("quitRestartHelp")}</p>
            </>
          ) : (
            <>
              <p>{t("quitConfirmHelp")}</p>
              <p>{t("quitTabHelp")}</p>
              {state === "failed" && (
                <p className="sidebar-dialog-error" role="alert">
                  {t("quitFailed")}
                </p>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setOpen(false)}
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={locked}
                  onClick={() => void confirm()}
                >
                  {t(state === "pending" ? "quittingOpenPI" : "quitOpenPI")}
                </button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
