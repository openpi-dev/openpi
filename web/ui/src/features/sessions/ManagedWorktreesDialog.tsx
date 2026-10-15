import { Dialog } from "@astryxdesign/core/Dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebWorktreeReleaseTarget,
  WebWorktreeReleaseResult,
} from "../../../../runtime/types.ts";
import { WebApiError, type WebClient } from "../../protocol/client.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

/** Discovery is a preview; only the native release action decides ownership. */
export function ManagedWorktreesDialog({
  workspace,
  client,
  actions,
  connected,
  onClose,
}: {
  workspace: string;
  client: Pick<WebClient, "workspaceWorktrees">;
  actions: Pick<WebStoreActions, "releaseSessionWorktree">;
  connected: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<WebWorktreeReleaseTarget[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<"changed" | "failed" | null>(null);
  const [unavailable, setUnavailable] = useState(0);
  const [target, setTarget] = useState<WebWorktreeReleaseTarget | null>(null);
  const [result, setResult] = useState<WebWorktreeReleaseResult | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);
  const releasing = useRef(false);
  const mounted = useRef(true);
  const load = useCallback(
    async (next?: string) => {
      const id = ++request.current;
      setLoading(true);
      setLoadError(null);
      try {
        const page = await client.workspaceWorktrees(workspace, next);
        if (!mounted.current || id !== request.current) return;
        if (page.truncated && !page.nextCursor)
          throw new Error("Missing worktree continuation");
        setTargets((previous) => {
          const items = next ? [...previous] : [];
          for (const item of page.worktrees)
            if (
              !items.some(
                (old) =>
                  old.worktreePath === item.worktreePath &&
                  old.sessionId === item.sessionId &&
                  old.sessionPath === item.sessionPath,
              )
            )
              items.push(item);
          return items;
        });
        setCursor(page.nextCursor);
        setUnavailable((count) => (next ? count : 0) + page.unavailable);
      } catch (error) {
        if (mounted.current && id === request.current)
          setLoadError(
            error instanceof WebApiError &&
              error.code === "WORKTREE_LIST_CHANGED"
              ? "changed"
              : "failed",
          );
      } finally {
        if (mounted.current && id === request.current) setLoading(false);
      }
    },
    [client, workspace],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load]);
  const release = async () => {
    if (!target || releasing.current || !connected) return;
    releasing.current = true;
    setBusy(true);
    try {
      const outcome = await actions.releaseSessionWorktree(target);
      if (!mounted.current) return;
      setResult(outcome);
      setUncertain(false);
      if (outcome.state === "removed") {
        setTargets((items) =>
          items.filter(
            (item) =>
              item.worktreePath !== target.worktreePath ||
              item.sessionId !== target.sessionId ||
              item.sessionPath !== target.sessionPath,
          ),
        );
      }
    } catch {
      if (mounted.current) {
        setUncertain(true);
        setResult(null);
      }
    } finally {
      releasing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (target && !busy) backButton.current?.focus();
  }, [target, busy]);
  const close = () => {
    if (!releasing.current) onClose();
  };
  return (
    <Dialog
      isOpen
      onOpenChange={(open: boolean) => {
        if (!open) close();
      }}
      purpose="form"
      width={560}
      aria-label={t("managedWorktrees")}
    >
      <div className="openpi-dialog">
        <strong>{t("managedWorktrees")}</strong>
        <p className="sidebar-dialog-path">{workspace}</p>
        <p>{t("managedWorktreesDescription")}</p>
        {target ? (
          <>
            <p className="sidebar-dialog-path">{target.worktreePath}</p>
            <p>{t("managedWorktreeConfirm")}</p>
            {(result || uncertain) && (
              <p
                role="status"
                className={
                  result?.state === "removed"
                    ? undefined
                    : "sidebar-dialog-error"
                }
              >
                {t(
                  result?.state === "removed"
                    ? "managedWorktreeRemoved"
                    : result?.state === "preserved"
                      ? "managedWorktreePreserved"
                      : result?.state === "uncertain"
                        ? "managedWorktreeUncertainTerminal"
                        : "managedWorktreeUncertain",
                )}
                {result?.reason && <> {result.reason}</>}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                data-autofocus
                ref={backButton}
                disabled={busy}
                onClick={() => {
                  setTarget(null);
                  setResult(null);
                  setUncertain(false);
                }}
              >
                {t("managedWorktreesBack")}
              </button>
              {result?.state !== "removed" && result?.state !== "uncertain" && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !connected}
                  onClick={() => void release()}
                >
                  {t(
                    busy
                      ? "managedWorktreeRemoving"
                      : result || uncertain
                        ? "managedWorktreesRetry"
                        : "managedWorktreeRemove",
                  )}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="managed-worktrees-list">
              {targets.map((item) => (
                <div
                  key={JSON.stringify([
                    item.worktreePath,
                    item.sessionId,
                    item.sessionPath,
                  ])}
                >
                  <p className="sidebar-dialog-path">{item.worktreePath}</p>
                  <button
                    type="button"
                    disabled={!connected || loading || Boolean(loadError)}
                    onClick={() => {
                      setTarget(item);
                      setResult(null);
                      setUncertain(false);
                    }}
                  >
                    {t("managedWorktreeReview")}
                  </button>
                </div>
              ))}
            </div>
            {!loading && !loadError && !targets.length && (
              <p>{t("managedWorktreesEmpty")}</p>
            )}
            {unavailable > 0 && (
              <p>{t("managedWorktreesUnavailable", { count: unavailable })}</p>
            )}
            {loadError && (
              <p role="alert">
                {t(
                  loadError === "changed"
                    ? "managedWorktreesChanged"
                    : "managedWorktreesLoadFailed",
                )}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" data-autofocus onClick={close}>
                {t("close")}
              </button>
              {loadError && (
                <button
                  type="button"
                  disabled={loading || !connected}
                  onClick={() =>
                    void load(loadError === "changed" ? undefined : cursor)
                  }
                >
                  {t(
                    loadError === "changed"
                      ? "managedWorktreesRefresh"
                      : "managedWorktreesRetry",
                  )}
                </button>
              )}
              {cursor && !loadError && (
                <button
                  type="button"
                  disabled={loading || !connected}
                  onClick={() => void load(cursor)}
                >
                  {t("managedWorktreesMore")}
                </button>
              )}
              {loading && <span role="status">{t("loading")}</span>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
