import { Toast } from "@astryxdesign/core/Toast";
import { Archive, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArchiveNotice, WebStoreActions } from "../../store/web-store.ts";

type ArchiveActions = Pick<
  WebStoreActions,
  "selectSession" | "unarchiveSession" | "dismissArchiveNotice"
>;

function ArchiveNotification({
  notice,
  actions,
}: {
  notice: ArchiveNotice;
  actions: ArchiveActions;
}) {
  const { t } = useTranslation();
  const inFlight = useRef(false);
  const [pending, setPending] = useState<"view" | "undo" | null>(null);
  const [failed, setFailed] = useState(false);
  const dismiss = () => actions.dismissArchiveNotice(notice.key);
  const run = async (action: "view" | "undo") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setFailed(false);
    try {
      const result =
        action === "undo"
          ? await actions.unarchiveSession(notice.path)
          : await actions.selectSession(notice.path, notice.sessionId);
      if (result !== false) dismiss();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return (
    <div className="archive-notification" data-session-path={notice.path}>
      <Toast
        type="info"
        body={t("archiveNoticeTitle")}
        isAutoHide={!pending && !failed}
        autoHideDuration={8000}
        onDismiss={dismiss}
        renderContent={() => (
          <>
            <Archive className="archive-notification-icon" aria-hidden="true" />
            <div className="archive-notification-copy">
              <strong>{t("archiveNoticeTitle")}</strong>
              <span title={notice.title}>{notice.title}</span>
              {failed && (
                <span className="archive-notification-error" role="alert">
                  {t("archiveNoticeFailed")}
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void run("view")}
            >
              {t("archiveNoticeView")}
            </button>
            <button
              type="button"
              className="archive-notification-undo"
              disabled={pending !== null}
              onClick={() => void run("undo")}
            >
              {pending === "undo" && (
                <LoaderCircle
                  className="archive-notification-spinner"
                  aria-hidden="true"
                />
              )}
              {t("archiveNoticeUndo")}
            </button>
            <button
              type="button"
              className="archive-notification-close"
              aria-label={t("close")}
              onClick={dismiss}
            >
              <X aria-hidden="true" />
            </button>
          </>
        )}
      />
    </div>
  );
}

export function ArchiveNotifications({
  notices,
  actions,
}: {
  notices: ArchiveNotice[];
  actions: ArchiveActions;
}) {
  if (!notices.length) return null;
  return (
    <div className="archive-notifications">
      {notices.map((notice) => (
        <ArchiveNotification
          key={notice.key}
          notice={notice}
          actions={actions}
        />
      ))}
    </div>
  );
}
