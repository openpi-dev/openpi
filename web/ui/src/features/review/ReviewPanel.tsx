import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { FileDiff, GitBranch, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebGitReviewFile,
  WebGitReviewResult,
  WebSessionProjection,
} from "../../../../protocol/types.ts";
import { ArtifactProvider } from "../artifacts/Artifacts.tsx";

const FILE_PAGE_SIZE = 20;
const DIFF_LINE_CAP = 500;
const REVIEW_SKELETON_ROWS = [0, 1, 2, 3] as const;

function DiffPreview({ file }: { file: WebGitReviewFile }) {
  const { t } = useTranslation();
  const lines = file.diff.split("\n");
  const visible = lines.slice(0, DIFF_LINE_CAP);
  const occurrences = new Map<string, number>();
  const keyedLines = visible.map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { key: `${line}:${occurrence}`, line };
  });
  const hidden = Math.max(0, lines.length - visible.length);
  return (
    <>
      <figure className="session-review-diff" aria-label="Change diff">
        <pre className="evidence-lines">
          {keyedLines.map(({ key, line }) => (
            <span
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "diff-added"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "diff-removed"
                    : ""
              }
              key={key}
            >
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      </figure>
      {hidden > 0 && (
        <Text
          type="supporting"
          color="secondary"
          display="block"
          className="review-hidden-lines"
        >
          {t("gitReviewHiddenLines", { count: hidden })}
        </Text>
      )}
      {file.diffTruncated && (
        <Text
          type="supporting"
          color="secondary"
          display="block"
          className="review-hidden-lines"
        >
          {t("gitReviewDiffTruncated")}
        </Text>
      )}
    </>
  );
}

function failureLabel(
  result: Extract<WebGitReviewResult, { ok: false }> | null,
  t: (key: string) => string,
) {
  if (!result) return null;
  if (result.reason === "not_git_repository")
    return t("gitReviewNotRepository");
  if (result.reason === "unborn_repository") return t("gitReviewUnborn");
  return t("gitReviewFailed");
}

export interface GitReviewViewState {
  result: WebGitReviewResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function ReviewPanel({
  session,
  review,
  onClose,
}: {
  session: WebSessionProjection;
  review: GitReviewViewState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [visibleFiles, setVisibleFiles] = useState(FILE_PAGE_SIZE);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 1100px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1100px)");
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => closeButton.current?.focus(), []);
  const Surface = narrow ? "main" : "aside";
  const Heading = narrow ? "h1" : "h2";
  const snapshot = review.result?.ok ? review.result.snapshot : null;
  const failure = failureLabel(
    review.result && !review.result.ok ? review.result : null,
    t,
  );
  const files = snapshot?.files.slice(0, visibleFiles) ?? [];
  const remaining = Math.max(0, (snapshot?.files.length ?? 0) - files.length);
  const comparison = snapshot
    ? snapshot.baseBranch
      ? t("gitReviewComparison", {
          current: snapshot.currentBranch ?? t("gitReviewDetached"),
          base: snapshot.baseBranch,
        })
      : t("gitReviewWorkingTree")
    : null;

  return (
    <ArtifactProvider sessionId={session.id}>
      <Surface
        className="review-panel"
        aria-label={t("changeEvidence")}
        aria-busy={review.loading || undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="review-heading">
          <div>
            <Heading>
              <FileDiff aria-hidden="true" /> {t("changeEvidence")}
            </Heading>
            <small>{t("changeEvidenceScope")}</small>
          </div>
          <Button
            ref={closeButton}
            label={t("close")}
            variant="ghost"
            size="sm"
            icon={<X aria-hidden="true" />}
            isIconOnly
            className="review-close"
            onClick={onClose}
          />
        </header>
        <div className="review-body">
          {snapshot && (
            <VStack gap={1} align="stretch" className="review-summary">
              <HStack gap={3} align="center" justify="between">
                <Text type="label">
                  {t("filesChanged", { count: snapshot.files.length })}
                </Text>
                <HStack
                  gap={2}
                  align="center"
                  className="review-summary-counts"
                  aria-hidden="true"
                >
                  <Text
                    type="supporting"
                    hasTabularNumbers
                    className="review-additions"
                  >
                    +{snapshot.additions}
                  </Text>
                  <Text
                    type="supporting"
                    hasTabularNumbers
                    className="review-deletions"
                  >
                    -{snapshot.deletions}
                  </Text>
                </HStack>
              </HStack>
              <Text type="supporting" color="secondary" maxLines={1}>
                {comparison}
              </Text>
              <code title={snapshot.repositoryRoot}>
                {snapshot.repositoryRoot}
              </code>
            </VStack>
          )}
          {review.loading && !snapshot && (
            <div className="review-loading" role="status">
              <span className="sr-only">{t("gitReviewLoading")}</span>
              <VStack gap={2} align="stretch" aria-hidden="true">
                <Skeleton width="42%" height={16} radius="rounded" index={0} />
                <div className="review-loading-list">
                  {REVIEW_SKELETON_ROWS.map((index) => (
                    <Skeleton
                      key={index}
                      width="100%"
                      height={36}
                      radius={0}
                      index={index + 1}
                    />
                  ))}
                </div>
              </VStack>
            </div>
          )}
          {(review.error || failure) && (
            <Banner
              status="error"
              title={review.error || failure}
              className="review-banner"
              endContent={
                <Button
                  variant="ghost"
                  size="sm"
                  label={t("gitReviewRetry")}
                  isLoading={review.loading}
                  onClick={() => void review.refresh()}
                />
              }
            />
          )}
          {snapshot?.truncated && (
            <Banner
              status="info"
              title={t("gitReviewTruncated")}
              className="review-banner"
            />
          )}
          {snapshot && snapshot.files.length === 0 && (
            <EmptyState
              icon={<GitBranch aria-hidden="true" />}
              title={t("gitReviewEmpty")}
              isCompact
              className="review-empty"
            />
          )}
          {files.length > 0 && (
            <div className="session-review-list">
              <CollapsibleGroup
                type="single"
                hasDividers
                density="compact"
                role="list"
                aria-label={t("filesChanged", {
                  count: snapshot?.files.length ?? 0,
                })}
              >
                {files.map((file) => (
                  <Collapsible
                    className="session-review-file"
                    key={file.path}
                    value={file.path}
                    role="listitem"
                    trigger={
                      <HStack
                        as="span"
                        gap={2}
                        align="center"
                        justify="between"
                        width="100%"
                        className="session-review-file-trigger"
                      >
                        <Text
                          type="code"
                          maxLines={1}
                          className="session-review-path"
                        >
                          {file.path}
                        </Text>
                        <HStack
                          as="span"
                          gap={2}
                          align="center"
                          className="session-review-stats"
                          aria-hidden="true"
                        >
                          {file.additions > 0 && (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="review-additions"
                            >
                              +{file.additions}
                            </Text>
                          )}
                          {file.deletions > 0 && (
                            <Text
                              type="supporting"
                              hasTabularNumbers
                              className="review-deletions"
                            >
                              -{file.deletions}
                            </Text>
                          )}
                        </HStack>
                      </HStack>
                    }
                  >
                    <DiffPreview file={file} />
                  </Collapsible>
                ))}
              </CollapsibleGroup>
              {remaining > 0 && (
                <div className="session-review-more">
                  <Button
                    variant="ghost"
                    size="sm"
                    width="100%"
                    label={t("gitReviewShowMore", { count: remaining })}
                    onClick={() =>
                      setVisibleFiles((count) =>
                        Math.min(
                          count + FILE_PAGE_SIZE,
                          snapshot!.files.length,
                        ),
                      )
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </Surface>
    </ArtifactProvider>
  );
}
