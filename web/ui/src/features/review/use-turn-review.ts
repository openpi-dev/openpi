import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebGitReviewResult } from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

/** Read one native prompt's saved evidence; never substitute the live worktree. */
export function useTurnReview(
  sessionId: string,
  sessionPath: string,
  cwd: string,
  promptEntryId?: string,
) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    identity: string;
    result: WebGitReviewResult | null;
    error: string | null;
  }>({ identity: "", result: null, error: null });
  const identity = JSON.stringify([
    sessionId,
    sessionPath,
    promptEntryId,
    retry,
  ]);
  useEffect(() => {
    if (!promptEntryId) return;
    const controller = new AbortController();
    void client
      .turnChanges(sessionId, sessionPath, promptEntryId, controller.signal)
      .then(
        (response) => {
          if (controller.signal.aborted) return;
          if (
            !response.ok ||
            response.changes.sessionId !== sessionId ||
            response.changes.promptEntryId !== promptEntryId ||
            response.changes.state === "unavailable"
          ) {
            setState({
              identity,
              result: null,
              error: t("turnChangesUnavailable"),
            });
            return;
          }
          const changes = response.changes;
          setState({
            identity,
            error: null,
            result: {
              ok: true,
              snapshot: {
                ...(changes.source ? { evidenceSource: changes.source } : {}),
                ...(changes.fileCount !== null
                  ? { totalFiles: changes.fileCount, listComplete: true }
                  : {}),
                repositoryRoot: cwd,
                currentBranch: null,
                baseBranch: null,
                comparison: "session",
                revision: identity,
                files: changes.files,
                additions: changes.additions,
                deletions: changes.deletions,
                truncated: changes.state === "partial",
              },
            },
          });
        },
        () => {
          if (!controller.signal.aborted)
            setState({
              identity,
              result: null,
              error: t("turnChangesUnavailable"),
            });
        },
      );
    return () => controller.abort();
  }, [client, sessionId, sessionPath, promptEntryId, identity, cwd, t]);
  const refresh = useCallback(async () => setRetry((value) => value + 1), []);
  return {
    result: state.identity === identity ? state.result : null,
    error: state.identity === identity ? state.error : null,
    loading: Boolean(promptEntryId) && state.identity !== identity,
    refresh,
    historical: true,
  };
}
