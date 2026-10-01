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
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebGitReviewBranches,
  WebGitReviewFile,
  WebGitReviewResult,
  WebGitReviewSnapshot,
  WebGitReviewSource,
} from "../../../../protocol/types.ts";
import { useWorkbarReadingState } from "../workbar/workbar-reading-state.ts";
import { DiffCodePreview, type DiffLineReference } from "./DiffCodePreview.tsx";
import { ReviewBasePicker } from "./ReviewBasePicker.tsx";
import { ReviewFileTree } from "./ReviewFileTree.tsx";

const FILE_PAGE_SIZE = 20;
const VIEWED_FILE_LIMIT = 200;
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
  if (result.reason === "base_branch_unavailable")
    return t("gitReviewBaseUnavailable");
  if (result.reason === "invalid_base_branch") return t("gitReviewBaseInvalid");
  return t("gitReviewFailed");
}

export interface GitReviewViewState {
  historical?: boolean;
  loadMore?: () => Promise<void>;
  result: WebGitReviewResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  source?: WebGitReviewSource;
  setSource?: (source: WebGitReviewSource) => void;
  baseRef?: string;
  setBaseRef?: (ref: string) => void;
  readFile?: (
    path: string,
    signal: AbortSignal,
    expectedRevision: string,
  ) => Promise<WebGitReviewFile | undefined>;
}

export function ReviewPanel({
  review,
  initialFilePath,
  onClose,
  onOpenTools,
  embedded = false,
  active = true,
  onOpenFiles,
  readingScope,
  onReferenceLine,
}: {
  review: GitReviewViewState;
  initialFilePath?: string;
  onClose: () => void;
  onOpenTools?: () => void;
  embedded?: boolean;
  active?: boolean;
  onOpenFiles?: () => void;
  readingScope?: string;
  onReferenceLine?: (reference: DiffLineReference) => void;
}) {
  const { t } = useTranslation();
  const reading = useWorkbarReadingState();
  // Workbar's exact Session key owns this component. Retain only branch
  // choices during a base switch so its focused trigger survives loading;
  // previous comparison contents still clear at the existing scope seam.
  const branchChoices = useRef<WebGitReviewBranches | undefined>(undefined);
  if (review.result?.branches) branchChoices.current = review.result.branches;
  else if (review.result && !review.loading) branchChoices.current = undefined;
  const branches =
    review.result?.branches ??
    (review.loading ? branchChoices.current : undefined);
  const scope = `${readingScope ?? review.source ?? "unstaged"}:${review.baseRef ?? ""}`;
  const savedReading =
    reading?.review?.scope === scope ? reading.review : undefined;
  const previousScope = useRef(JSON.stringify([scope, initialFilePath]));
  const panel = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const [collapsedDirectories, setCollapsedDirectories] = useState<
    ReadonlySet<string>
  >(new Set(savedReading?.collapsedDirectories));
  useEffect(() => {
    const element = panel.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= 720);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const listCloseButton = useRef<HTMLButtonElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const focusRequested = useRef(true);
  const wasActive = useRef(false);
  const listScrollTop = useRef<number | null>(savedReading?.listScroll ?? null);
  const returnFocusPath = useRef<string | null>(null);
  const [visibleFiles, setVisibleFiles] = useState(
    savedReading?.visibleFiles ?? FILE_PAGE_SIZE,
  );
  const [query, setQuery] = useState(savedReading?.query ?? "");
  const [pinnedSnapshot, setPinnedSnapshot] =
    useState<WebGitReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState(
    savedReading ? savedReading.selected : (initialFilePath ?? null),
  );
  // Operator reading memory only: opening a diff is not a viewed decision.
  // Workbar owns the exact Session; this one bounded record adds scope and
  // displayed-summary identity so new evidence cannot inherit old marks.
  const [viewedState, setViewedState] = useState<{
    scope: string;
    revision: string;
    paths: ReadonlySet<string>;
  } | null>(() =>
    savedReading?.viewed
      ? {
          scope,
          revision: savedReading.viewed.revision,
          paths: new Set(savedReading.viewed.paths.slice(0, VIEWED_FILE_LIMIT)),
        }
      : null,
  );
  const restoreScroll = useRef(
    savedReading
      ? { list: savedReading.listScroll, preview: savedReading.previewScroll }
      : null,
  );
  useLayoutEffect(() => {
    if (reading)
      reading.review = {
        source: review.source ?? "unstaged",
        baseRef: review.baseRef,
        scope,
        selected: selectedPath,
        query,
        collapsedDirectories: [...collapsedDirectories],
        visibleFiles,
        listScroll:
          reading.review?.scope === scope ? reading.review.listScroll : 0,
        previewScroll:
          reading.review?.scope === scope ? reading.review.previewScroll : 0,
        viewed:
          viewedState?.scope === scope
            ? {
                revision: viewedState.revision,
                paths: [...viewedState.paths].slice(0, VIEWED_FILE_LIMIT),
              }
            : undefined,
      };
  }, [
    reading,
    review.source,
    review.baseRef,
    scope,
    selectedPath,
    query,
    collapsedDirectories,
    visibleFiles,
    viewedState,
  ]);
  const [loadedFile, setLoadedFile] = useState<{
    source: WebGitReviewSource;
    revision: string;
    file: WebGitReviewFile;
  } | null>(null);
  const [fileError, setFileError] = useState<{
    source: WebGitReviewSource;
    path: string;
    revision: string;
    message: string;
  } | null>(null);
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
    // Scope changes invalidate the pinned comparison even for the same path.
    const next = JSON.stringify([scope, initialFilePath]);
    if (previousScope.current === next) return;
    previousScope.current = next;
    focusRequested.current =
      Boolean(initialFilePath) ||
      !(
        document.activeElement instanceof Element &&
        document.activeElement.closest(
          ".review-base-picker, .review-base-popup",
        )
      );
    listScrollTop.current = null;
    setSelectedPath(initialFilePath ?? null);
    setQuery("");
    setCollapsedDirectories(new Set());
    setPinnedSnapshot(null);
    setViewedState(null);
  }, [initialFilePath, scope]);
  const Surface = embedded ? "section" : narrow ? "main" : "aside";
  const latestSnapshot = review.result?.ok ? review.result.snapshot : null;
  const snapshot =
    !review.historical &&
    selectedPath &&
    pinnedSnapshot &&
    pinnedSnapshot.comparison === (review.source ?? latestSnapshot?.comparison)
      ? latestSnapshot?.revision === pinnedSnapshot.revision
        ? latestSnapshot
        : pinnedSnapshot
      : latestSnapshot;
  const updated = Boolean(
    selectedPath &&
      snapshot &&
      latestSnapshot &&
      snapshot.revision !== latestSnapshot.revision,
  );
  useEffect(() => {
    if (selectedPath && !pinnedSnapshot && latestSnapshot)
      setPinnedSnapshot(latestSnapshot);
  }, [selectedPath, pinnedSnapshot, latestSnapshot]);
  const source = review.source ?? snapshot?.comparison ?? "unstaged";
  const failure = failureLabel(
    review.result && !review.result.ok ? review.result : null,
    t,
  );
  const fileSummary = snapshot?.files.find(
    (file) => file.path === selectedPath,
  );
  const selectedFile =
    loadedFile?.source === source &&
    loadedFile?.revision === snapshot?.revision &&
    loadedFile?.file.path === selectedPath
      ? loadedFile.file
      : fileSummary;
  const revision = snapshot?.revision;
  const viewed =
    viewedState?.scope === scope && viewedState.revision === revision
      ? viewedState.paths
      : new Set<string>();
  const viewedCount =
    snapshot?.files.filter((file) => viewed.has(file.path)).length ?? 0;
  useEffect(() => {
    if (
      revision &&
      viewedState &&
      (viewedState.scope !== scope || viewedState.revision !== revision)
    )
      setViewedState(null);
  }, [revision, scope, viewedState]);
  const markViewed = (path: string, checked: boolean) => {
    if (!revision || !snapshot?.files.some((file) => file.path === path))
      return;
    setViewedState((current) => {
      const paths = new Set(
        current?.scope === scope && current.revision === revision
          ? current.paths
          : [],
      );
      if (checked) {
        if (paths.size >= VIEWED_FILE_LIMIT) return current;
        paths.add(path);
      } else paths.delete(path);
      return { scope, revision, paths };
    });
  };
  useLayoutEffect(() => {
    if (!active || !snapshot || !restoreScroll.current) return;
    if (selectedPath && selectedFile?.diffLoaded === false) return;
    if (listBody.current)
      listBody.current.scrollTop = restoreScroll.current.list;
    if (preview.current)
      preview.current.scrollTop = restoreScroll.current.preview;
    restoreScroll.current = null;
  }, [active, snapshot, selectedPath, selectedFile?.diffLoaded]);
  const detailError =
    fileError?.source === source &&
    fileError?.path === selectedPath &&
    fileError?.revision === revision &&
    fileSummary?.diffLoaded === false
      ? fileError.message
      : null;
  useEffect(() => {
    void fileRetry;
    const path = fileSummary?.path;
    if (
      !active ||
      !path ||
      fileSummary?.diffLoaded !== false ||
      !review.readFile ||
      !revision
    )
      return;
    const controller = new AbortController();
    setFileError(null);
    void review.readFile(path, controller.signal, revision).then(
      (file) => {
        if (!controller.signal.aborted) {
          if (file) setLoadedFile({ source, revision, file });
          else
            setFileError({
              source,
              path,
              revision,
              message: t("gitReviewFileMissing"),
            });
        }
      },
      (error) => {
        if (!controller.signal.aborted)
          setFileError({
            source,
            path,
            revision,
            message:
              error instanceof Error ? error.message : t("gitReviewFailed"),
          });
      },
    );
    return () => controller.abort();
  }, [
    fileSummary?.path,
    active,
    fileSummary?.diffLoaded,
    revision,
    source,
    review.readFile,
    fileRetry,
    t,
  ]);
  const matchingFiles = useMemo(
    () =>
      (snapshot?.files ?? [])
        .filter((file) =>
          file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true })),
    [snapshot?.files, query],
  );
  const files = wide ? matchingFiles : matchingFiles.slice(0, visibleFiles);
  useEffect(() => {
    if (!wide || selectedPath || !snapshot?.files.length) return;
    // Opening a wide review selects a file without moving focus out of the chat.
    focusRequested.current = false;
    setSelectedPath(snapshot.files[0]!.path);
  }, [wide, selectedPath, snapshot]);
  const remaining = Math.max(0, matchingFiles.length - files.length);
  const partialList =
    snapshot?.listComplete === false ||
    (snapshot?.listComplete === undefined && snapshot?.truncated);
  const partialSearch = partialList || snapshot?.nextOffset !== undefined;
  const comparison = review.historical
    ? t(
        snapshot?.evidenceSource === "file-tools"
          ? "turnEditsScope"
          : "turnChangesScope",
      )
    : snapshot
      ? snapshot.comparison === "session"
        ? t("gitReviewSessionSnapshot")
        : snapshot.comparison === "unstaged"
          ? t("gitReviewUnstaged")
          : snapshot.comparison === "staged"
            ? t("gitReviewStaged")
            : snapshot.baseBranch
              ? t("gitReviewComparison", {
                  current: snapshot.currentBranch ?? t("gitReviewDetached"),
                  base: snapshot.baseBranch.replace(
                    /^refs\/(?:heads|remotes)\//u,
                    "",
                  ),
                })
              : t("gitReviewWorkingTree")
      : null;

  useEffect(() => {
    // Snapshot refreshes can remove a preview without a navigation intent.
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    if (!activated && !focusRequested.current) return;
    focusRequested.current = false;
    if (selectedPath) preview.current?.focus();
    else if (embedded) listBody.current?.focus();
    else listCloseButton.current?.focus();
  }, [active, embedded, selectedPath]);

  const openFile = (path: string) => {
    listScrollTop.current = listBody.current?.scrollTop ?? null;
    if (path !== selectedPath) {
      restoreScroll.current = {
        list: listScrollTop.current ?? 0,
        preview: 0,
      };
      if (preview.current) preview.current.scrollTop = 0;
      if (reading?.review?.scope === scope) reading.review.previewScroll = 0;
    }
    focusRequested.current = !wide;
    setPinnedSnapshot(snapshot);
    setSelectedPath(path);
  };
  useLayoutEffect(() => {
    const path = returnFocusPath.current;
    if (selectedPath || !path || !active) return;
    returnFocusPath.current = null;
    const body = listBody.current;
    if (!body?.isConnected || body.closest("[hidden], [inert]")) return;
    const row = [
      ...body.querySelectorAll<HTMLButtonElement>("[data-review-file]"),
    ].find((button) => button.dataset.reviewFile === path);
    if (listScrollTop.current !== null) body.scrollTop = listScrollTop.current;
    if (row) row.focus({ preventScroll: listScrollTop.current !== null });
    else if (embedded) body.focus();
    else listCloseButton.current?.focus();
  }, [active, embedded, selectedPath]);

  const showFileList = () => {
    const path = selectedPath;
    const index = matchingFiles.findIndex((file) => file.path === path);
    if (index >= visibleFiles)
      setVisibleFiles(Math.ceil((index + 1) / FILE_PAGE_SIZE) * FILE_PAGE_SIZE);
    focusRequested.current = false;
    returnFocusPath.current = path;
    setSelectedPath(null);
    setPinnedSnapshot(null);
  };

  return (
    <Surface
      ref={panel}
      className={`review-panel${embedded ? " embedded" : ""}${wide ? " review-wide" : ""}`}
      aria-label={t("changeEvidence")}
      aria-busy={review.loading || undefined}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          event.defaultPrevented
        )
          return;
        if ((!selectedPath || wide) && embedded) return;
        event.preventDefault();
        event.stopPropagation();
        if (selectedPath && !wide) showFileList();
        else if (!embedded) onClose();
      }}
    >
      <div className="review-source-picker">
        {review.setSource && (
          <label>
            {t("gitReviewSource")}{" "}
            <select
              value={review.historical ? "turn" : (review.source ?? "unstaged")}
              onChange={(event) =>
                review.setSource?.(
                  event.currentTarget.value as WebGitReviewSource,
                )
              }
            >
              {review.historical && (
                <option value="turn">{t("turnChangesReview")}</option>
              )}
              <option value="unstaged">{t("gitReviewUnstaged")}</option>
              <option value="staged">{t("gitReviewStaged")}</option>
              <option value="branch">{t("gitReviewBranch")}</option>
              <option value="session">{t("gitReviewSessionSnapshot")}</option>
            </select>
          </label>
        )}
        {review.source === "branch" && review.setBaseRef && branches && (
          <ReviewBasePicker
            branches={branches}
            value={
              review.baseRef ??
              (review.result?.ok
                ? (review.result.snapshot.baseBranch ?? undefined)
                : undefined)
            }
            loading={review.loading}
            onChange={review.setBaseRef}
          />
        )}
        <div className="review-source-actions">
          {onOpenFiles && (
            <button type="button" onClick={onOpenFiles}>
              {t("sessionFileRecords")}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t("gitReviewRefresh")}
            title={t("gitReviewRefresh")}
            disabled={review.loading}
            aria-busy={review.loading || undefined}
            onClick={() => {
              if (!review.loading) void review.refresh();
            }}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>
      {updated && (
        <div className="review-update" role="status">
          <span>{t("gitReviewNewVersion")}</span>
          <button
            type="button"
            onClick={() => {
              preview.current?.focus();
              setPinnedSnapshot(latestSnapshot);
              setLoadedFile(null);
            }}
          >
            {t("gitReviewShowLatest")}
          </button>
        </div>
      )}
      {(review.error || failure) && (
        <Banner
          status="error"
          container="section"
          title={review.error || failure}
          description={snapshot ? t("gitReviewOlderResult") : undefined}
          className="review-banner"
          endContent={
            <Button
              variant="ghost"
              size="sm"
              label={t("gitReviewRetry")}
              isDisabled={review.loading}
              isLoading={review.loading}
              onClick={() => {
                if (!review.loading) void review.refresh();
              }}
            />
          }
        />
      )}
      <div className="review-workspace">
        {selectedPath && (
          <div className="review-file-screen">
            <header className="review-file-header">
              {!wide && (
                <Button
                  label={t("gitReviewBackToFiles")}
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<ArrowLeft aria-hidden="true" />}
                  onClick={showFileList}
                />
              )}
              <div className="review-file-heading">
                <strong title={selectedPath}>{fileName(selectedPath)}</strong>
                <span title={selectedPath}>{selectedPath}</span>
              </div>
              {selectedFile && revision && (
                <label className="review-file-viewed">
                  <input
                    type="checkbox"
                    aria-label={t("gitReviewMarkCurrentViewed", {
                      path: selectedPath,
                    })}
                    checked={viewed.has(selectedPath)}
                    disabled={
                      viewed.size >= VIEWED_FILE_LIMIT &&
                      !viewed.has(selectedPath)
                    }
                    onChange={(event) =>
                      markViewed(selectedPath, event.currentTarget.checked)
                    }
                  />
                  <span>{t("gitReviewViewedLabel")}</span>
                </label>
              )}
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
                {selectedFile && (
                  <span>{t(`gitFileStatus_${selectedFile.status}`)}</span>
                )}
                <code>{comparison}</code>
              </div>
              <HStack gap={2} align="center" className="session-review-stats">
                {selectedFile &&
                  !selectedFile.binary &&
                  !selectedFile.statsUnavailable &&
                  selectedFile.additions > 0 && (
                    <Text
                      type="supporting"
                      hasTabularNumbers
                      className="review-additions"
                    >
                      +{selectedFile.additions}
                    </Text>
                  )}
                {selectedFile &&
                  !selectedFile.binary &&
                  !selectedFile.statsUnavailable &&
                  selectedFile.deletions > 0 && (
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
                file: selectedPath,
              })}
              tabIndex={-1}
              onScroll={(event) => {
                if (reading?.review)
                  reading.review.previewScroll = event.currentTarget.scrollTop;
              }}
            >
              {!selectedFile ? (
                <p role="status">
                  {t(
                    review.loading
                      ? "gitReviewLoading"
                      : "gitReviewFileMissing",
                  )}
                </p>
              ) : detailError ? (
                <div role="alert">
                  <p>{detailError}</p>
                  <button
                    type="button"
                    onClick={() => setFileRetry((value) => value + 1)}
                  >
                    {t("retryAdmissionCheck")}
                  </button>
                </div>
              ) : selectedFile.diffLoaded === false && review.readFile ? (
                <p role="status">{t("gitReviewLoading")}</p>
              ) : selectedFile.binary ? (
                <EmptyState
                  icon={<FileCode2 aria-hidden="true" />}
                  title={t("gitReviewBinary")}
                  isCompact
                />
              ) : selectedFile.statsUnavailable ? (
                <EmptyState
                  icon={<FileCode2 aria-hidden="true" />}
                  title={t("turnEditStatsUnknown")}
                  description={t(
                    `turnEditReason_${selectedFile.statsUnavailable}`,
                  )}
                  isCompact
                />
              ) : selectedFile.diff ? (
                <>
                  {selectedFile.diffTruncated && (
                    <p className="review-hidden-lines">
                      {t("gitReviewDiffTruncated")}
                    </p>
                  )}
                  <DiffCodePreview
                    file={selectedFile}
                    onReferenceLine={onReferenceLine}
                  />
                </>
              ) : (
                <EmptyState
                  icon={<FileCode2 aria-hidden="true" />}
                  title={t(
                    selectedFile.diffTruncated
                      ? "gitReviewDiffTruncated"
                      : "gitReviewNoDiff",
                  )}
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
        )}
        {(!selectedPath || wide) && (
          <div className="review-navigation">
            {!embedded && !wide && (
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
              onScroll={(event) => {
                if (reading?.review)
                  reading.review.listScroll = event.currentTarget.scrollTop;
              }}
              className="review-body"
              tabIndex={embedded ? -1 : undefined}
            >
              {snapshot && (
                <VStack gap={1} align="stretch" className="review-summary">
                  <HStack gap={3} align="center" justify="between">
                    <Text type="label">
                      {t(
                        partialList ? "gitReviewLoadedCount" : "filesChanged",
                        {
                          count: partialList
                            ? snapshot.files.length
                            : (snapshot.totalFiles ?? snapshot.files.length),
                        },
                      )}
                    </Text>
                    {!snapshot.truncated &&
                      snapshot.nextOffset === undefined &&
                      !snapshot.files.some(
                        (file) =>
                          file.binary ||
                          file.statsUnavailable ||
                          (file.status === "untracked" &&
                            file.diffLoaded === false),
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
                  <Text type="supporting" color="secondary">
                    {t("gitReviewViewedProgress", {
                      viewed: viewedCount,
                      loaded: snapshot.files.length,
                    })}
                  </Text>
                  {viewed.size >= VIEWED_FILE_LIMIT && (
                    <Text type="supporting" color="secondary">
                      {t("gitReviewViewedLimit", { count: VIEWED_FILE_LIMIT })}
                    </Text>
                  )}
                  {snapshot.nextOffset !== undefined && (
                    <Text type="supporting" color="secondary">
                      {t("gitReviewLoadedCount", {
                        count: snapshot.files.length,
                      })}
                    </Text>
                  )}
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
              {snapshot?.truncated && (
                <Banner
                  status="info"
                  title={t("gitReviewTruncated")}
                  className="review-banner"
                />
              )}
              {snapshot && snapshot.files.length > 0 && (
                <label className="review-search">
                  <Search aria-hidden="true" />
                  <span className="sr-only">
                    {t(
                      partialSearch
                        ? "gitReviewSearchLoaded"
                        : "gitReviewSearch",
                    )}
                  </span>
                  <input
                    type="search"
                    value={query}
                    placeholder={t(
                      partialSearch
                        ? "gitReviewSearchLoaded"
                        : "gitReviewSearch",
                    )}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setVisibleFiles(FILE_PAGE_SIZE);
                    }}
                  />
                </label>
              )}
              {query && matchingFiles.length === 0 && (
                <p className="review-search-empty" role="status">
                  {t(
                    partialSearch
                      ? "gitReviewNoLoadedMatch"
                      : "gitReviewNoMatch",
                  )}
                </p>
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
                <>
                  <ReviewFileTree
                    files={files}
                    selectedPath={selectedPath}
                    collapsed={collapsedDirectories}
                    searching={Boolean(query)}
                    onToggle={(path) =>
                      setCollapsedDirectories((current) => {
                        const next = new Set(current);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onSelect={openFile}
                    viewed={viewed}
                    onViewedChange={markViewed}
                    viewedLimitReached={viewed.size >= VIEWED_FILE_LIMIT}
                  />
                  {remaining > 0 && (
                    <div className="session-review-more">
                      <Button
                        variant="ghost"
                        size="sm"
                        width="100%"
                        label={t("gitReviewShowMore", {
                          count: Math.min(FILE_PAGE_SIZE, remaining),
                        })}
                        onClick={() =>
                          setVisibleFiles((count) =>
                            Math.min(
                              count + FILE_PAGE_SIZE,
                              matchingFiles.length,
                            ),
                          )
                        }
                      />
                    </div>
                  )}
                </>
              )}
              {snapshot?.nextOffset !== undefined && review.loadMore && (
                <div className="session-review-more">
                  <Button
                    variant="ghost"
                    size="sm"
                    width="100%"
                    label={t("gitReviewLoadNext")}
                    isLoading={review.loading}
                    isDisabled={review.loading}
                    onClick={() => {
                      void review.loadMore?.();
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Surface>
  );
}
