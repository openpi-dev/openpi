import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import {
  ArrowLeft,
  FileCode2,
  FileDiff,
  GitBranch,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebGitReviewFile,
  WebGitReviewResult,
  WebGitReviewSource,
} from "../../../../protocol/types.ts";
import { DiffCodePreview } from "./DiffCodePreview.tsx";

const FILE_PAGE_SIZE = 20;
const REVIEW_SKELETON_ROWS = [0, 1, 2, 3] as const;

function fileName(path: string) {
  return path.split(/[\\/]/u).at(-1) || path;
}

function failureLabel(
  result: Extract<WebGitReviewResult, { ok: false }> | null,
  t: (key: string) => string,
) {
  if (!result) return null;
  if (result.reason === "not_git_repository")
    return t("gitReviewNotRepository");
  if (result.reason === "unborn_repository") return t("gitReviewUnborn");
  if (result.reason === "baseline_unavailable")
    return t("gitReviewBaselineUnavailable");
  return t("gitReviewFailed");
}

export interface GitReviewViewState {
  result: WebGitReviewResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  source?: WebGitReviewSource;
  setSource?: (source: WebGitReviewSource) => void;
  readFile?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<WebGitReviewFile | undefined>;
}

export function ReviewPanel({
  review,
  initialFilePath,
  onClose,
  onOpenTools,
  embedded = false,
  onOpenFiles,
}: {
  review: GitReviewViewState;
  initialFilePath?: string;
  onClose: () => void;
  onOpenTools?: () => void;
  embedded?: boolean;
  onOpenFiles?: () => void;
}) {
  const { t } = useTranslation();
  const listCloseButton = useRef<HTMLButtonElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const [visibleFiles, setVisibleFiles] = useState(FILE_PAGE_SIZE);
  const [selectedPath, setSelectedPath] = useState(initialFilePath ?? null);
  const [loadedFile, setLoadedFile] = useState<{
    revision: string;
    file: WebGitReviewFile;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileRetry, setFileRetry] = useState(0);
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
  useEffect(() => {
    setSelectedPath(initialFilePath ?? null);
  }, [initialFilePath]);
  const Surface = embedded ? "section" : narrow ? "main" : "aside";
  const snapshot = review.result?.ok ? review.result.snapshot : null;
  const failure = failureLabel(
    review.result && !review.result.ok ? review.result : null,
    t,
  );
  const fileSummary = snapshot?.files.find(
    (file) => file.path === selectedPath,
  );
  const selectedFile =
    loadedFile?.revision === snapshot?.revision &&
    loadedFile?.file.path === selectedPath
      ? loadedFile.file
      : fileSummary;
  useEffect(() => {
    void fileRetry;
    const path = fileSummary?.path;
    if (
      !path ||
      fileSummary?.diffLoaded !== false ||
      !review.readFile ||
      !snapshot
    )
      return;
    const revision = snapshot.revision;
    const controller = new AbortController();
    setFileError(null);
    void review.readFile(path, controller.signal).then(
      (file) => {
        if (!controller.signal.aborted) {
          if (file) setLoadedFile({ revision, file });
          else setFileError(t("gitReviewFileMissing"));
        }
      },
      (error) => {
        if (!controller.signal.aborted)
          setFileError(
            error instanceof Error ? error.message : t("gitReviewFailed"),
          );
      },
    );
    return () => controller.abort();
  }, [
    fileSummary?.path,
    fileSummary?.diffLoaded,
    snapshot,
    review.readFile,
    fileRetry,
    t,
  ]);
  const files = snapshot?.files.slice(0, visibleFiles) ?? [];
  const remaining = Math.max(0, (snapshot?.files.length ?? 0) - files.length);
  const comparison = snapshot
    ? snapshot.comparison === "session"
      ? t("gitReviewSessionSnapshot")
      : snapshot.comparison === "unstaged"
        ? t("gitReviewUnstaged")
        : snapshot.comparison === "staged"
          ? t("gitReviewStaged")
          : snapshot.baseBranch
            ? t("gitReviewComparison", {
                current: snapshot.currentBranch ?? t("gitReviewDetached"),
                base: snapshot.baseBranch,
              })
            : t("gitReviewWorkingTree")
    : null;

  const selectedFilePath = selectedFile?.path;
  useEffect(() => {
    if (selectedFilePath) preview.current?.focus();
    else if (embedded) listBody.current?.focus();
    else listCloseButton.current?.focus();
  }, [embedded, selectedFilePath]);

  const openFile = (path: string) => {
    setSelectedPath(path);
  };
  const showFileList = () => {
    setSelectedPath(null);
    requestAnimationFrame(() => {
      if (embedded) listBody.current?.focus();
      else listCloseButton.current?.focus();
    });
  };

  return (
    <Surface
      className={`review-panel${embedded ? " embedded" : ""}`}
      aria-label={t("changeEvidence")}
      aria-busy={review.loading || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (selectedFile) showFileList();
        else if (!embedded) onClose();
      }}
    >
      {review.setSource && (
        <div className="review-source-picker">
          <label>
            {t("gitReviewSource")}{" "}
            <select
              value={review.source ?? "unstaged"}
              onChange={(event) =>
                review.setSource?.(
                  event.currentTarget.value as WebGitReviewSource,
                )
              }
            >
              <option value="unstaged">{t("gitReviewUnstaged")}</option>
              <option value="staged">{t("gitReviewStaged")}</option>
              <option value="branch">{t("gitReviewBranch")}</option>
              <option value="session">{t("gitReviewSessionSnapshot")}</option>
            </select>
          </label>
          {onOpenFiles && (
            <button type="button" onClick={onOpenFiles}>
              {t("sessionFileRecords")}
            </button>
          )}
        </div>
      )}
      {selectedFile ? (
        <div className="review-file-screen">
          <header className="review-file-header">
            <Button
              label={t("gitReviewBackToFiles")}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<ArrowLeft aria-hidden="true" />}
              onClick={showFileList}
            />
            <div className="review-file-heading">
              <strong title={selectedFile.path}>
                {fileName(selectedFile.path)}
              </strong>
              <span title={selectedFile.path}>{selectedFile.path}</span>
            </div>
            {!embedded && (
              <div className="review-file-actions">
                {onOpenTools && (
                  <Button
                    label={t("openTools")}
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    icon={<Plus aria-hidden="true" />}
                    onClick={onOpenTools}
                  />
                )}
                <Button
                  label={t("close")}
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<X aria-hidden="true" />}
                  onClick={onClose}
                />
              </div>
            )}
          </header>
          <div className="review-file-toolbar">
            <div className="review-file-context">
              <span>{t(`gitFileStatus_${selectedFile.status}`)}</span>
              <code>{comparison}</code>
            </div>
            <HStack gap={2} align="center" className="session-review-stats">
              {selectedFile.additions > 0 && (
                <Text
                  type="supporting"
                  hasTabularNumbers
                  className="review-additions"
                >
                  +{selectedFile.additions}
                </Text>
              )}
              {selectedFile.deletions > 0 && (
                <Text
                  type="supporting"
                  hasTabularNumbers
                  className="review-deletions"
                >
                  -{selectedFile.deletions}
                </Text>
              )}
            </HStack>
            <span className="review-file-mode" aria-current="true">
              {t("diffView")}
            </span>
          </div>
          <section
            ref={preview}
            className="review-file-preview"
            aria-label={t("gitReviewFilePreview", {
              file: selectedFile.path,
            })}
            tabIndex={-1}
          >
            {fileError ? (
              <div role="alert">
                <p>{fileError}</p>
                <button
                  type="button"
                  onClick={() => setFileRetry((value) => value + 1)}
                >
                  {t("retryAdmissionCheck")}
                </button>
              </div>
            ) : selectedFile.diffLoaded === false && review.readFile ? (
              <p role="status">{t("gitReviewLoading")}</p>
            ) : selectedFile.diff ? (
              <DiffCodePreview file={selectedFile} />
            ) : (
              <EmptyState
                icon={<FileCode2 aria-hidden="true" />}
                title={t("gitReviewNoDiff")}
                description={
                  selectedFile.diffTruncated
                    ? t("gitReviewDiffTruncated")
                    : undefined
                }
                isCompact
              />
            )}
          </section>
        </div>
      ) : (
        <>
          {!embedded && (
            <header className="review-heading">
              <div>
                <h2>
                  <FileDiff aria-hidden="true" /> {t("changeEvidence")}
                </h2>
                <small>{t("changeEvidenceScope")}</small>
              </div>
              <div className="review-heading-actions">
                {onOpenTools && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("openTools")}
                    title={t("openTools")}
                    onClick={onOpenTools}
                  >
                    <Plus aria-hidden="true" />
                  </button>
                )}
                <button
                  ref={listCloseButton}
                  type="button"
                  className="icon-button review-close"
                  aria-label={t("close")}
                  title={t("close")}
                  onClick={onClose}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            </header>
          )}
          <div
            ref={listBody}
            className="review-body"
            tabIndex={embedded ? -1 : undefined}
          >
            {snapshot && (
              <VStack gap={1} align="stretch" className="review-summary">
                <HStack gap={3} align="center" justify="between">
                  <Text type="label">
                    {t("filesChanged", { count: snapshot.files.length })}
                  </Text>
                  {!snapshot.files.some(
                    (file) =>
                      file.status === "untracked" && file.diffLoaded === false,
                  ) && (
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
                  )}
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
                  <Skeleton
                    width="42%"
                    height={16}
                    radius="rounded"
                    index={0}
                  />
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
                <ul
                  aria-label={t("filesChanged", {
                    count: snapshot?.files.length ?? 0,
                  })}
                >
                  {files.map((file) => (
                    <li key={file.path}>
                      <button
                        className="session-review-file"
                        type="button"
                        title={file.path}
                        onClick={() => openFile(file.path)}
                      >
                        <FileCode2 aria-hidden="true" />
                        <span className="session-review-path">{file.path}</span>
                        <span
                          className="session-review-stats"
                          aria-hidden="true"
                        >
                          {file.additions > 0 && (
                            <span className="review-additions">
                              +{file.additions}
                            </span>
                          )}
                          {file.deletions > 0 && (
                            <span className="review-deletions">
                              -{file.deletions}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
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
        </>
      )}
    </Surface>
  );
}
