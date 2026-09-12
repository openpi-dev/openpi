import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebWorkspaceChange,
  WebWorkspaceChanges,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

function statusLabel(
  status: WebWorkspaceChange["status"],
  translate: (key: string) => string,
) {
  return translate(`workspaceChangesStatus_${status}`);
}

export function WorkspaceChanges({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<WebWorkspaceChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    const read = async () => {
      try {
        const next = await client.workspaceChanges(
          sessionId,
          controller.signal,
        );
        if (next.sessionId !== sessionId || next.cwd !== cwd) {
          throw new Error(t("workspaceChangesChanged"));
        }
        if (controller.signal.aborted) return;
        setData(next);
        setSelectedPath((current) =>
          current && next.files.some((file) => file.path === current)
            ? current
            : (next.files[0]?.path ?? null),
        );
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error
              ? reason.message
              : t("workspaceChangesUnavailable"),
          );
        }
      }
    };
    void read();
    return () => controller.abort();
  }, [client, cwd, revision, sessionId, t]);

  const selected = data?.files.find((file) => file.path === selectedPath);
  const baseline = data?.baseline;
  const loading = data === null && error === null;

  return (
    <section className="workspace-changes" aria-label={t("workspaceChanges")}>
      <header className="workspace-changes-heading">
        <div>
          <h2>{t("workspaceChangesHeading")}</h2>
          <p className="workspace-changes-subtitle">{cwd}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t("workspaceChangesRefresh")}
          title={t("workspaceChangesRefresh")}
          disabled={loading}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw />
        </button>
      </header>
      {loading && <p role="status">{t("workspaceChangesLoading")}</p>}
      {error && (
        <p className="workspace-changes-warning" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <dl className="workspace-changes-meta">
            <dt>{t("workspaceChangesWorkspace")}</dt>
            <dd>{data.repositoryRoot ?? data.cwd}</dd>
            <dt>{t("workspaceChangesComparison")}</dt>
            <dd>
              {baseline?.kind === "head"
                ? t("workspaceChangesHead", { commit: baseline.commit })
                : baseline?.kind === "empty-tree"
                  ? t("workspaceChangesEmptyTree")
                  : t("unknownState")}
            </dd>
          </dl>
          {data.status === "clean" && (
            <p role="status">{t("workspaceChangesClean")}</p>
          )}
          {data.status === "not-repository" && (
            <p role="status">{t("workspaceChangesNotRepository")}</p>
          )}
          {data.status === "unavailable" && (
            <p className="workspace-changes-warning" role="alert">
              {data.error ?? t("workspaceChangesUnavailable")}
            </p>
          )}
          {data.truncation.truncated && (
            <p className="workspace-changes-warning" role="status">
              {data.truncation.statusTruncated
                ? t("workspaceChangesStatusTruncated")
                : t("workspaceChangesTruncated")}
              {data.truncation.filesOmitted > 0 &&
                ` ${t("workspaceChangesFilesOmitted", { count: data.truncation.filesOmitted })}`}
              {data.truncation.diffsTruncated > 0 &&
                ` ${t("workspaceChangesDiffsTruncated", { count: data.truncation.diffsTruncated })}`}
            </p>
          )}
          {data.files.length > 0 ? (
            <div className="workspace-changes-body">
              <nav
                className="workspace-changes-list"
                aria-label={t("workspaceChangesFiles")}
              >
                {data.files.map((file) => (
                  <button
                    type="button"
                    className="workspace-change-file"
                    aria-pressed={selectedPath === file.path}
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                  >
                    <span className="workspace-change-file-main">
                      <strong>{file.path}</strong>
                      {file.previousPath && (
                        <small>← {file.previousPath}</small>
                      )}
                    </span>
                    <span className="workspace-change-file-meta">
                      <span>{statusLabel(file.status, t)}</span>
                      <span>
                        {file.binary
                          ? t("workspaceChangesBinaryShort")
                          : `+${file.additions ?? "?"} -${file.deletions ?? "?"}`}
                      </span>
                    </span>
                  </button>
                ))}
              </nav>
              <section
                className="workspace-change-detail"
                aria-label={t("workspaceChangesDiff")}
              >
                {selected ? (
                  <>
                    <header>
                      <div>
                        <h3>{selected.path}</h3>
                        <p>
                          {statusLabel(selected.status, t)}
                          {selected.previousPath
                            ? ` · ${selected.previousPath}`
                            : ""}
                        </p>
                      </div>
                    </header>
                    {selected.diffStatus === "binary" ? (
                      <p>{t("workspaceChangesBinary")}</p>
                    ) : selected.diffStatus === "unavailable" ? (
                      <p className="workspace-changes-warning">
                        {selected.error ?? t("workspaceChangesDiffUnavailable")}
                      </p>
                    ) : (
                      <pre>{selected.diff || t("workspaceChangesNoDiff")}</pre>
                    )}
                    {selected.truncated && (
                      <p className="workspace-changes-warning">
                        {t("workspaceChangesDiffTruncated")}
                      </p>
                    )}
                  </>
                ) : (
                  <p>{t("workspaceChangesSelectFile")}</p>
                )}
              </section>
            </div>
          ) : (
            data.status === "changed" && (
              <p className="workspace-changes-warning" role="status">
                {t("workspaceChangesNoFiles")}
              </p>
            )
          )}
          <p className="workspace-changes-updated">
            {t("workspaceChangesCheckedAt", {
              time: new Date(data.checkedAt).toLocaleTimeString(),
            })}
          </p>
        </>
      )}
    </section>
  );
}
