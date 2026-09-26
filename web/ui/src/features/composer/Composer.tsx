import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Brain,
  Check,
  ChevronRight,
  Command,
  CornerDownRight,
  FileText,
  Folder,
  ImagePlus,
  KeyRound,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  WEB_PROMPT_IMAGE_MAX_COUNT,
  WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES,
  type WebCommandSummary,
  type WebPromptImage,
  type WebSnapshot,
} from "../../../../protocol/types.ts";
import {
  compactSummary,
  sessionTitle,
  workspaceName,
} from "../../lib/format.ts";
import { isControlledSession } from "../../lib/session-control.ts";
import type { WebStoreActions, WebStoreState } from "../../store/web-store.ts";
import { ActivityBar } from "../activity/ActivityBar.tsx";
import {
  type ComposerDraft,
  createComposerDraftMemory,
} from "./composer-drafts.ts";
import { FileReferenceDialog } from "./FileReferenceDialog.tsx";
import {
  type StagedPromptImage,
  stagePromptImage,
} from "./image-attachments.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import {
  filterWebCommands,
  SlashCommandMenu,
  slashCommandListId,
  slashCommandOptionId,
} from "./SlashCommandMenu.tsx";

interface ComposerProps {
  planSelectionPending?: boolean;
  workspaceDraft?: boolean;
  draftModel?: WebStoreState["draftModel"];
  createdSession?: WebStoreState["createdSession"];
  modelSelectionPending?: boolean;
  modelSearch?: WebStoreState["modelSearch"];
  thinkingPendingLevel: WebStoreState["thinkingPendingLevel"];
  onInspect?: (terminalId?: string) => void;
  onOpenProviders?: () => void;
  onCommandAction?: (
    action: NonNullable<WebCommandSummary["action"]>,
  ) => boolean;
  onInspectSubagent?: (id?: string) => void;
  snapshot: WebSnapshot | null;
  selectedPath?: string | null;
  selectedWorkspace: string | null;
  sessionSwitching: boolean;
  promptAdmissionPending: boolean;
  promptAdmissionRecovery?: WebStoreState["promptAdmissionRecovery"];
  promptAdmissionResolution?: WebStoreState["promptAdmissionResolution"];
  liveRunning: boolean;
  landing: boolean;
  actions: WebStoreActions;
  activeTurn: WebStoreState["activeTurn"];
  turnCancellationPending: boolean;
  turnTerminalStatus: string | null;
  pendingFollowUpsReceipt: number | null;
  commandDiscovery?: WebStoreState["commandDiscovery"];
  accessory?: ReactNode;
}

function workspaceDraftOwner(workspacePath: string | null) {
  return {
    key: JSON.stringify(["workspace", workspacePath]),
    kind: "workspace" as const,
    workspacePath,
  };
}

function sessionDraftOwner(
  session: NonNullable<WebSnapshot["selectedSession"]>,
) {
  return {
    key: JSON.stringify(["session", session.id, session.path]),
    kind: "session" as const,
    workspacePath: session.cwd,
    sessionId: session.id,
    sessionPath: session.path,
  };
}

type DraftOwner =
  | ReturnType<typeof workspaceDraftOwner>
  | ReturnType<typeof sessionDraftOwner>;

export function Composer(props: ComposerProps) {
  const { t } = useTranslation();
  const selected = props.snapshot?.selectedSession;
  const selectedPath =
    props.selectedPath === undefined
      ? (selected?.path ?? null)
      : props.selectedPath;
  const sessionPath = selected?.path === selectedPath ? selected.path : null;
  const canonicalOwner =
    !props.workspaceDraft && !props.sessionSwitching && selected && sessionPath
      ? sessionDraftOwner(selected)
      : null;
  const [draftMemory] = useState(createComposerDraftMemory);
  const draftOwner = useRef<DraftOwner>(
    canonicalOwner ?? workspaceDraftOwner(props.selectedWorkspace),
  );
  const nextOwner =
    props.workspaceDraft || (!selected && !props.snapshot?.currentSessionId)
      ? workspaceDraftOwner(props.selectedWorkspace)
      : (canonicalOwner ?? draftOwner.current);
  const [draft, setDraft] = useState<ComposerDraft>(() =>
    draftMemory.read(draftOwner.current.key),
  );
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const { prompt, images, caret: cursor } = draft;
  const renderedOwnerKey = nextOwner.key;
  const submissions = useRef(
    new Map<
      string,
      { owner: DraftOwner; revision: number; pending: boolean }
    >(),
  );
  const recoveryRevision = useRef<{
    commandId: string;
    key: string;
    revision: number;
  } | null>(null);
  const restoreCaret = useRef(false);
  const modelSearch =
    props.modelSearch ??
    ({
      query: "",
      status: "idle",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: null,
    } satisfies WebStoreState["modelSearch"]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [expandedQueuedMessage, setExpandedQueuedMessage] = useState<
    string | null
  >(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const attachmentImport = useRef<{
    ownerKey: string;
    files: File[];
    staged: StagedPromptImage[];
  } | null>(null);
  const restoreFileReferenceFocus = useRef(false);
  const fileReferenceTarget = useRef<{
    ownerKey: string;
    revision: number;
    start: number;
    end: number;
  } | null>(null);
  useLayoutEffect(() => {
    // Programmatic clears and recovered drafts need the same sizing as typing.
    void prompt;
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    element.style.overflowY = element.scrollHeight > 220 ? "auto" : "hidden";
    if (restoreCaret.current) {
      restoreCaret.current = false;
      element.setSelectionRange(cursor, cursor);
    }
  }, [prompt, cursor]);
  useEffect(() => {
    if (fileReferenceOpen || !restoreFileReferenceFocus.current) return;
    restoreFileReferenceFocus.current = false;
    const timer = window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cursor, fileReferenceOpen]);
  const restoredRecoveryCommandId = useRef<string | null>(null);
  const commandMenuWasOpen = useRef(false);
  useLayoutEffect(() => {
    const previous = draftOwner.current;
    if (previous.key === nextOwner.key) return;
    let nextDraft = draftMemory.read(nextOwner.key);
    let limit = false;
    const handoff =
      previous.kind === "workspace" &&
      nextOwner.kind === "session" &&
      previous.workspacePath === nextOwner.workspacePath &&
      props.createdSession?.sessionId === nextOwner.sessionId &&
      props.createdSession.sessionPath === nextOwner.sessionPath &&
      props.createdSession.workspacePath === nextOwner.workspacePath &&
      draftMemory.move(previous.key, nextOwner.key);
    if (handoff) {
      nextDraft = currentDraft.current;
      const importing = attachmentImport.current;
      if (importing?.ownerKey === previous.key)
        importing.ownerKey = nextOwner.key;
      const submission = submissions.current.get(previous.key);
      if (submission) {
        submissions.current.delete(previous.key);
        submission.owner = nextOwner;
        submissions.current.set(nextOwner.key, submission);
      }
    } else {
      // An explicit same-workspace creation may copy operator intent, not move
      // it out of the original Session or replace an existing workspace draft.
      if (
        previous.kind === "session" &&
        nextOwner.kind === "workspace" &&
        previous.workspacePath === nextOwner.workspacePath &&
        props.workspaceDraft &&
        props.sessionSwitching &&
        !nextDraft.prompt &&
        nextDraft.images.length === 0
      ) {
        const { prompt, images, caret } = currentDraft.current;
        const copied = draftMemory.edit(nextOwner.key, nextDraft, {
          prompt,
          images,
          caret,
        });
        if (copied) nextDraft = copied;
        else limit = true;
      }
      attachmentImport.current = null;
      setAttachmentBusy(false);
    }
    draftOwner.current = nextOwner;
    currentDraft.current = nextDraft;
    restoreCaret.current = true;
    restoreFileReferenceFocus.current = false;
    setDraft(nextDraft);
    setAttachmentError(limit ? t("draftLimit") : null);
    setCommandError(null);
    setDragActive(false);
    setFileReferenceOpen(false);
    setMenuDismissed(true);
  }, [
    draftMemory,
    nextOwner,
    props.workspaceDraft,
    props.sessionSwitching,
    props.createdSession,
    t,
  ]);
  useLayoutEffect(
    () => () => {
      attachmentImport.current = null;
    },
    [],
  );
  const updateDraft = (
    patch: Partial<Pick<ComposerDraft, "prompt" | "images" | "caret">>,
    ownerKey = renderedOwnerKey,
  ) => {
    if (draftOwner.current.key !== ownerKey) return false;
    const current = currentDraft.current;
    const next = draftMemory.edit(ownerKey, current, patch);
    if (!next) {
      setAttachmentError(t("draftLimit"));
      return false;
    }
    if (next.revision !== current.revision) {
      if (!submissions.current.get(ownerKey)?.pending)
        submissions.current.delete(ownerKey);
      setAttachmentError((error) => (error === t("draftLimit") ? null : error));
    }
    currentDraft.current = next;
    setDraft(next);
    return true;
  };
  const active = Boolean(
    !props.workspaceDraft &&
      selected?.id &&
      isControlledSession(props.snapshot, selected) &&
      selectedPath === selected.path,
  );
  const draftSession = Boolean(
    props.selectedWorkspace &&
      (props.workspaceDraft ||
        (!selected && !props.snapshot?.currentSessionId)),
  );
  const canCompose = active || draftSession;
  const running =
    !props.workspaceDraft &&
    (props.snapshot?.runtime.status === "running" || props.liveRunning);
  const canStop =
    active &&
    running &&
    Boolean(props.activeTurn ?? props.snapshot?.runtime.activeTurn);
  const disabled =
    props.sessionSwitching || (!canCompose && Boolean(props.selectedWorkspace));
  const commandDiscovery = props.commandDiscovery ?? {
    sessionId: null,
    status: "idle" as const,
    commands: [],
    totalAvailable: 0,
    commandsOmitted: 0,
    error: null,
  };
  const slashStage = /^\/[^\s/]*$/u.test(prompt) && cursor > 0;
  const commandMenuOpen =
    composerFocused &&
    slashStage &&
    !menuDismissed &&
    canCompose &&
    !props.sessionSwitching;
  const commandSessionId = active ? selected?.id : null;
  const commandQuery = slashStage ? prompt.slice(1) : "";
  const filteredCommands = useMemo(
    () => filterWebCommands(commandDiscovery.commands, commandQuery),
    [commandQuery, commandDiscovery.commands],
  );
  const commandListVisible =
    commandMenuOpen &&
    !props.workspaceDraft &&
    commandDiscovery.status === "ready" &&
    filteredCommands.length > 0;
  const commandEntryAvailable =
    active && !prompt.trim() && !props.sessionSwitching;
  const contextEntryAvailable =
    canCompose && Boolean(props.selectedWorkspace) && !props.sessionSwitching;

  useEffect(() => {
    if (contextEntryAvailable) return;
    restoreFileReferenceFocus.current = false;
    setFileReferenceOpen(false);
  }, [contextEntryAvailable]);

  const stageFiles = async (files: Iterable<File>) => {
    if (!contextEntryAvailable || draftOwner.current.key !== renderedOwnerKey)
      return;
    const selectedFiles = [...files];
    if (selectedFiles.length === 0) return;
    const pending = attachmentImport.current;
    if (
      currentDraft.current.images.length +
        (pending?.files.length ?? 0) +
        selectedFiles.length >
      WEB_PROMPT_IMAGE_MAX_COUNT
    ) {
      setAttachmentError(
        t("imageAttachmentCount", { count: WEB_PROMPT_IMAGE_MAX_COUNT }),
      );
      return;
    }
    if (pending) {
      pending.files.push(...selectedFiles);
      return;
    }
    const importing = {
      ownerKey: draftOwner.current.key,
      files: selectedFiles,
      staged: [] as StagedPromptImage[],
    };
    attachmentImport.current = importing;
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      // This bounded list also accepts later pastes while its current file reads.
      for (const file of importing.files) {
        try {
          const image = await stagePromptImage(file);
          if (
            attachmentImport.current !== importing ||
            draftOwner.current.key !== importing.ownerKey
          )
            return;
          const totalBytes = [
            ...currentDraft.current.images,
            ...importing.staged,
          ].reduce((sum, item) => sum + item.size, image.size);
          if (totalBytes > WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES)
            throw new Error("image-total-size");
          importing.staged.push(image);
        } catch (error) {
          if (attachmentImport.current !== importing) return;
          const code = error instanceof Error ? error.message : "image-type";
          const reason =
            code === "image-size"
              ? t("imageAttachmentTooLarge")
              : code === "image-total-size"
                ? t("imageAttachmentTotalTooLarge")
                : t("imageAttachmentUnsupported");
          setAttachmentError(`${file.name || t("attachedImage")}: ${reason}`);
        }
      }
      if (importing.staged.length > 0) {
        updateDraft(
          { images: [...currentDraft.current.images, ...importing.staged] },
          importing.ownerKey,
        );
      }
    } finally {
      if (attachmentImport.current === importing) {
        attachmentImport.current = null;
        setAttachmentBusy(false);
        if (imagePicker.current) imagePicker.current.value = "";
      }
    }
  };

  useEffect(() => {
    const opened = commandMenuOpen && !commandMenuWasOpen.current;
    commandMenuWasOpen.current = commandMenuOpen;
    if (
      !commandMenuOpen ||
      props.workspaceDraft ||
      !commandSessionId ||
      (commandDiscovery.status !== "idle" &&
        !(opened && commandDiscovery.status === "error"))
    ) {
      return;
    }
    void props.actions.discoverCommands();
  }, [
    commandDiscovery.status,
    commandMenuOpen,
    props.actions,
    props.workspaceDraft,
    commandSessionId,
  ]);

  useEffect(() => {
    const firstAvailable = filteredCommands.findIndex(
      (command) => command.availability === "available",
    );
    setActiveCommand(firstAvailable);
  }, [filteredCommands]);

  useEffect(() => {
    const recovery = props.promptAdmissionRecovery;
    if (!recovery || restoredRecoveryCommandId.current === recovery.commandId)
      return;
    restoredRecoveryCommandId.current = recovery.commandId;
    recoveryRevision.current = null;
    const key = JSON.stringify([
      "session",
      recovery.sessionId,
      recovery.sessionPath,
    ]);
    const submission = submissions.current.get(key);
    if (submission) {
      recoveryRevision.current = {
        commandId: recovery.commandId,
        key,
        revision: submission.revision,
      };
      return;
    }
    const current =
      draftOwner.current.key === key
        ? currentDraft.current
        : draftMemory.read(key);
    if (current.prompt || current.images.length > 0) return;
    const restoredImages = (recovery.images ?? []).map((image) => ({
      ...image,
      id:
        globalThis.crypto?.randomUUID?.() ??
        `${recovery.commandId}-${image.name}`,
      name: image.name ?? t("attachedImage"),
      size: atob(image.data).length,
      previewUrl: `data:${image.mimeType};base64,${image.data}`,
    }));
    const restored = draftMemory.edit(key, current, {
      prompt: recovery.content,
      images: restoredImages,
      caret: recovery.content.length,
    });
    if (!restored) {
      if (draftOwner.current.key === key) setAttachmentError(t("draftLimit"));
      return;
    }
    recoveryRevision.current = {
      commandId: recovery.commandId,
      key,
      revision: restored.revision,
    };
    if (draftOwner.current.key === key) {
      currentDraft.current = restored;
      setDraft(restored);
    }
  }, [draftMemory, props.promptAdmissionRecovery, t]);

  useEffect(() => {
    const resolution = props.promptAdmissionResolution;
    if (!resolution) return;
    const captured = recoveryRevision.current;
    const key = JSON.stringify([
      "session",
      resolution.sessionId,
      resolution.sessionPath,
    ]);
    if (captured?.key === key && captured.commandId === resolution.commandId) {
      const cleared = draftMemory.clear(key, captured.revision);
      if (cleared && draftOwner.current.key === key) {
        currentDraft.current = cleared;
        setDraft(cleared);
      }
    }
    if (captured?.commandId === resolution.commandId)
      recoveryRevision.current = null;
    props.actions.acknowledgePromptAdmissionResolution(resolution.commandId);
  }, [draftMemory, props.actions, props.promptAdmissionResolution]);

  const sendDraft = async (
    sendPrompt: (
      content: string,
      images?: readonly WebPromptImage[],
    ) => Promise<boolean>,
    explicitImages = false,
  ) => {
    if (
      submissions.current.get(draftOwner.current.key)?.pending ||
      attachmentImport.current ||
      props.planSelectionPending
    )
      return;
    if (!props.selectedWorkspace) {
      await props.actions.chooseWorkspace();
      return;
    }
    if (renderedOwnerKey !== draftOwner.current.key) return;
    const captured = currentDraft.current;
    const submission = {
      revision: captured.revision,
      owner: draftOwner.current,
      pending: true,
    };
    submissions.current.set(submission.owner.key, submission);
    let accepted = false;
    try {
      accepted =
        explicitImages || captured.images.length > 0
          ? await sendPrompt(captured.prompt, captured.images)
          : await sendPrompt(captured.prompt);
      if (accepted) {
        const cleared = draftMemory.clear(
          submission.owner.key,
          submission.revision,
        );
        if (cleared && draftOwner.current.key === submission.owner.key) {
          currentDraft.current = cleared;
          setDraft(cleared);
          setAttachmentError(null);
        }
      }
    } finally {
      submission.pending = false;
      const retained = draftMemory.read(submission.owner.key);
      if (
        (accepted || (!retained.prompt && retained.images.length === 0)) &&
        submissions.current.get(submission.owner.key) === submission
      ) {
        submissions.current.delete(submission.owner.key);
      }
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !canCompose ||
      props.sessionSwitching ||
      props.modelSelectionPending ||
      props.planSelectionPending ||
      props.thinkingPendingLevel !== null ||
      props.promptAdmissionPending ||
      props.promptAdmissionRecovery ||
      props.promptAdmissionResolution ||
      (!prompt.trim() && images.length === 0)
    )
      return;
    if (attachmentImport.current) return;
    const commandName = /^\/([^\s/]+)/u.exec(prompt.trim())?.[1];
    const command = commandDiscovery.commands.find(
      (item) => item.name === commandName,
    );
    if (command?.availability === "unsupported") {
      setCommandError(
        `/${command.name}: ${t(`commandUnavailable_${command.unavailableReason ?? "not_integrated"}`)}`,
      );
      return;
    }
    if (command?.action) {
      if (prompt.trim() !== `/${command.name}` || images.length > 0) {
        setCommandError(t("commandPanelArguments"));
        return;
      }
      if (props.onCommandAction?.(command.action) !== true) {
        setCommandError(t("commandPanelUnavailable"));
        return;
      }
      updateDraft({ prompt: "", caret: 0 });
      setCommandError(null);
      return;
    }
    setCommandError(null);
    await sendDraft(props.actions.sendPrompt);
  };

  const sendAsNew = () => {
    if (
      !active ||
      props.sessionSwitching ||
      props.modelSelectionPending ||
      props.thinkingPendingLevel !== null
    )
      return;
    return sendDraft(props.actions.sendPromptAsNew, true);
  };

  const completeCommand = (command: (typeof filteredCommands)[number]) => {
    if (command.availability !== "available") return;
    const value = `/${command.name} `;
    if (!updateDraft({ prompt: value, caret: value.length })) return;
    setCommandError(null);
    setMenuDismissed(true);
    queueMicrotask(() => {
      if (draftOwner.current.key !== renderedOwnerKey) return;
      textarea.current?.focus();
      textarea.current?.setSelectionRange(value.length, value.length);
    });
  };

  const moveCommand = (offset: number) => {
    if (!filteredCommands.length) return;
    let next = activeCommand;
    for (let index = 0; index < filteredCommands.length; index++) {
      next =
        (next + offset + filteredCommands.length) % filteredCommands.length;
      if (filteredCommands[next]?.availability === "available") {
        setActiveCommand(next);
        return;
      }
    }
  };

  const insertFileReference = (reference: string) => {
    const target = fileReferenceTarget.current;
    const current = currentDraft.current;
    if (
      !target ||
      target.ownerKey !== renderedOwnerKey ||
      target.ownerKey !== draftOwner.current.key ||
      target.revision !== current.revision
    )
      return t("fileReferenceDraftChanged");
    const before = current.prompt.slice(0, target.start);
    const after = current.prompt.slice(target.end);
    const formatted = `\`${reference.replaceAll("`", "\\`")}\``;
    const leading = before && !/\s$/u.test(before) ? " " : "";
    const trailing = after && !/^\s/u.test(after) ? " " : "";
    const value = `${before}${leading}${formatted}${trailing}${after}`;
    const nextCursor = before.length + leading.length + formatted.length;
    if (!updateDraft({ prompt: value, caret: nextCursor }))
      return t("draftLimit");
    restoreFileReferenceFocus.current = true;
  };

  const openFileReference = () => {
    const current = currentDraft.current;
    const input = textarea.current;
    const start = Math.min(
      Math.max(input?.selectionStart ?? current.caret, 0),
      current.prompt.length,
    );
    fileReferenceTarget.current = {
      ownerKey: renderedOwnerKey,
      revision: current.revision,
      start,
      end: Math.min(
        Math.max(input?.selectionEnd ?? start, start),
        current.prompt.length,
      ),
    };
    setFileReferenceOpen(true);
  };

  const workspaceItems = [
    ...(props.snapshot?.workspaces ?? []).map((workspace) => ({
      id: workspace.path,
      label: workspace.name,
      icon: <Folder />,
      endContent:
        workspace.path === props.selectedWorkspace ? <Check /> : undefined,
      onClick: () => props.actions.setWorkspace(workspace.path),
    })),
    { type: "divider" as const },
    {
      id: "add",
      label: t("addWorkspaceMenu"),
      icon: <Plus />,
      onClick: () => void props.actions.chooseWorkspace(),
    },
  ];
  const currentModel =
    props.draftModel ??
    props.snapshot?.models.find((model) => model.current) ??
    props.snapshot?.models[0];
  const workspaceLabel =
    props.snapshot?.workspaces.find(
      (workspace) => workspace.path === props.selectedWorkspace,
    )?.name ??
    (props.selectedWorkspace
      ? workspaceName(props.selectedWorkspace)
      : t("selectWorkspace"));
  const sessionSummary = props.snapshot?.sessions.find(
    (session) => session.path === sessionPath,
  );
  const targetLabel = active
    ? sessionTitle(sessionSummary ?? {}, selected?.id ?? t("untitledSession"))
    : draftSession
      ? t("newSession")
      : selected
        ? sessionTitle(sessionSummary ?? {}, selected.id)
        : t("newSession");
  const targetSummary = compactSummary(targetLabel, 48);
  const placeholder = !props.selectedWorkspace
    ? t("promptStart")
    : active &&
        props.snapshot?.runtime.planHasPrompt &&
        ["planning", "ready"].includes(props.snapshot.runtime.plan ?? "")
      ? t("promptPlanMessage")
      : props.landing
        ? t("promptTask")
        : active
          ? t("promptMessage")
          : t("promptReadonly");
  const thinking = props.snapshot?.thinking;
  const confirmed = thinking?.level ?? null;
  const pending = props.thinkingPendingLevel ?? null;
  const shown = pending ?? confirmed;
  const supported = thinking?.supported ?? false;
  const thinkingNeedsSession = !active && (draftSession || !selected);
  const weak = thinking ? !thinking.available.includes(confirmed ?? "") : false;
  const thinkingItems = (thinking?.available ?? []).map((lvl) => ({
    id: lvl,
    label: lvl,
    endContent: lvl === shown ? <Check /> : undefined,
    onClick: () => void props.actions.selectThinking(lvl),
  }));
  const thinkingDisabledReason = !thinking
    ? null
    : !supported && !thinkingNeedsSession
      ? "thinkingUnsupportedHint"
      : !active && !thinkingNeedsSession
        ? "thinkingInactiveHint"
        : running
          ? "thinkingLockedRunning"
          : props.modelSelectionPending
            ? "thinkingModelPendingHint"
            : null;
  const thinkingAria =
    !supported && !thinkingNeedsSession
      ? t("thinkingUnsupported")
      : `${t("thinkingLevel")}: ${shown ?? t("unknownState")}${pending !== null ? `. ${t("thinkingPendingHint")}` : ""}`;
  const thinkingMenuItems = thinking
    ? [
        ...(weak
          ? [
              {
                id: "thinking-level-mismatch",
                label: t("thinkingLevelMismatch"),
                isDisabled: true,
              },
              { type: "divider" as const },
            ]
          : []),
        {
          type: "section" as const,
          id: "thinking-level",
          title: t("thinkingLevel"),
          items: thinkingItems,
        },
      ]
    : [];
  const execution = props.snapshot?.selectedExecution;
  const observedQueue =
    selected &&
    execution &&
    execution.sessionId === selected.id &&
    execution.sessionPath === selected.path
      ? execution.pendingFollowUps
      : undefined;
  const pendingCount = observedQueue ?? props.pendingFollowUpsReceipt;
  const queuedMessages =
    observedQueue !== undefined ? (execution?.queuedMessages ?? []) : [];
  const queueOccurrences = new Map<string, number>();
  const queuedRows = queuedMessages.map((message) => {
    const occurrence = queueOccurrences.get(message) ?? 0;
    queueOccurrences.set(message, occurrence + 1);
    return { message, key: `${message}:${occurrence}` };
  });
  const showingQueue =
    !props.workspaceDraft &&
    !props.sessionSwitching &&
    observedQueue !== undefined &&
    queuedMessages.length > 0;
  const hint =
    props.promptAdmissionPending && !canStop
      ? t("promptPending")
      : props.modelSelectionPending
        ? t("thinkingModelPendingHint")
        : props.thinkingPendingLevel !== null
          ? t("thinkingPendingHint")
          : props.workspaceDraft
            ? t("enterHint")
            : props.turnCancellationPending
              ? t("stoppingTurn")
              : props.turnTerminalStatus === "cancelled"
                ? t("stoppedTurn")
                : !showingQueue &&
                    (props.pendingFollowUpsReceipt !== null ||
                      (pendingCount ?? 0) > 0)
                  ? (pendingCount ?? 0) > 0
                    ? t("pendingFollowUpsHint", {
                        count: pendingCount ?? 0,
                      })
                    : t("acceptedHint")
                  : canCompose
                    ? running
                      ? t("queuedHint")
                      : t("enterHint")
                    : t("activeOnlyHint");
  const showHint =
    canCompose &&
    ((props.promptAdmissionPending && !canStop) ||
      props.modelSelectionPending ||
      props.thinkingPendingLevel !== null ||
      props.turnCancellationPending ||
      props.turnTerminalStatus === "cancelled" ||
      (!showingQueue && props.pendingFollowUpsReceipt !== null) ||
      (!showingQueue && (pendingCount ?? 0) > 0) ||
      (running && Boolean(prompt.trim() || images.length)));

  return (
    <div className="composer-dock">
      {!active &&
        !props.workspaceDraft &&
        !props.sessionSwitching &&
        selected &&
        selectedPath === selected.path && (
          <div className="composer-session-notice">
            <span>{t("activateViewedSessionHint")}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => void props.actions.selectSession(selected.path)}
            >
              {t("activateViewedSession")}
            </button>
          </div>
        )}
      {active && props.snapshot?.runtime.plan && !props.sessionSwitching && (
        <div className="plan-mode-bar">
          <span>{t(`planMode_${props.snapshot.runtime.plan}`)}</span>
          <button
            type="button"
            disabled={
              running ||
              props.planSelectionPending ||
              props.promptAdmissionPending ||
              Boolean(props.promptAdmissionRecovery)
            }
            onClick={() =>
              void props.actions.selectPlanMode(
                props.snapshot?.runtime.plan === "inactive",
              )
            }
          >
            {t(
              props.snapshot.runtime.plan === "inactive"
                ? "planModeEnter"
                : "planModeExit",
            )}
          </button>
        </div>
      )}
      {active && (
        <ActivityBar
          snapshot={props.snapshot}
          onInspectTerminal={props.onInspect}
          onInspectSubagent={props.onInspectSubagent}
        />
      )}
      {props.accessory}
      {props.landing && (
        <div className="workspace-picker-row">
          <DropdownMenu
            className="workspace-picker-menu"
            button={{
              label: props.selectedWorkspace
                ? workspaceName(props.selectedWorkspace)
                : t("selectWorkspace"),
              icon: <Folder />,
              size: "md",
              variant: "ghost",
              className: "workspace-picker",
            }}
            items={workspaceItems}
            menuWidth={240}
            placement="above"
            alignment="start"
            hasChevron
          />
        </div>
      )}
      {props.promptAdmissionRecovery && (
        <section className="prompt-recovery" role="alert">
          <div>
            <strong>{t("promptAdmissionUnknown")}</strong>
            <span>
              {props.promptAdmissionRecovery.phase === "checking"
                ? t("promptAdmissionCheckingDetail")
                : props.promptAdmissionRecovery.phase === "verification-failed"
                  ? t("promptAdmissionVerificationFailedDetail")
                  : t("promptAdmissionUnknownDetail")}
            </span>
          </div>
          <div className="prompt-recovery-actions">
            <button
              type="button"
              disabled={props.promptAdmissionRecovery.phase === "submitting"}
              onClick={props.actions.abandonPromptAdmission}
            >
              {t("abandonAdmission")}
            </button>
            {props.promptAdmissionRecovery.phase === "verification-failed" && (
              <button
                type="button"
                onClick={() =>
                  void props.actions.checkPromptAdmissionRecovery()
                }
              >
                {t("retryAdmissionCheck")}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                attachmentBusy ||
                !active ||
                props.sessionSwitching ||
                props.modelSelectionPending ||
                props.thinkingPendingLevel !== null ||
                props.promptAdmissionRecovery.phase !== "ready" ||
                (!prompt.trim() && images.length === 0)
              }
              onClick={() => void sendAsNew()}
            >
              {props.promptAdmissionRecovery.phase === "submitting"
                ? t("sendingAsNew")
                : t("sendAsNew")}
            </button>
          </div>
        </section>
      )}
      <form
        className={`composer composer-m02 ${props.selectedWorkspace ? "" : "dormant"} ${dragActive ? "is-dragging" : ""}`}
        onSubmit={(event) => void send(event)}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!contextEntryAvailable) return;
          setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!contextEntryAvailable) return;
          event.dataTransfer.dropEffect = "copy";
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next))
            return;
          setDragActive(false);
        }}
        onDrop={(event) => {
          setDragActive(false);
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          if (!contextEntryAvailable) return;
          void stageFiles(event.dataTransfer.files);
        }}
      >
        {!props.selectedWorkspace && (
          <button
            className="dormant-overlay"
            type="button"
            aria-label={t("selectWorkspace")}
            onClick={() => void props.actions.chooseWorkspace()}
          />
        )}
        {props.selectedWorkspace && (
          <div
            className="composer-target"
            title={`${workspaceLabel} / ${targetLabel}`}
          >
            <Folder aria-hidden="true" />
            <span>{workspaceLabel}</span>
            <ChevronRight aria-hidden="true" />
            <strong>{targetSummary}</strong>
          </div>
        )}
        {showingQueue && (
          <section
            className="composer-queue"
            aria-label={t("pendingFollowUpsHint", { count: observedQueue })}
          >
            <ul>
              {queuedRows.map(({ message, key }) => {
                const rowKey = `${selected?.id}\0${selected?.path}\0${key}`;
                const expanded = expandedQueuedMessage === rowKey;
                const text = message || t("queuedImage");
                const action = t(
                  expanded ? "queuedMessageCollapse" : "queuedMessageExpand",
                );
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`composer-queue-row ${expanded ? "expanded" : ""}`}
                      aria-expanded={expanded}
                      aria-label={`${action}: ${expanded ? text : compactSummary(text, 80)}`}
                      title={action}
                      onClick={() =>
                        setExpandedQueuedMessage(expanded ? null : rowKey)
                      }
                    >
                      <CornerDownRight aria-hidden="true" />
                      <span>{text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {observedQueue > queuedMessages.length && (
              <small>
                {t("queuedMore", {
                  count: observedQueue - queuedMessages.length,
                })}
              </small>
            )}
          </section>
        )}
        <input
          ref={imagePicker}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            if (event.currentTarget.files)
              void stageFiles(event.currentTarget.files);
          }}
        />
        {images.length > 0 && (
          <section
            className="composer-attachments"
            aria-label={t("imageAttachments")}
          >
            {images.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <img src={image.previewUrl} alt="" />
                <span title={image.name}>{image.name}</span>
                <button
                  type="button"
                  aria-label={`${t("removeAttachment")} ${image.name}`}
                  title={t("removeAttachment")}
                  onClick={() => {
                    if (
                      updateDraft({
                        images: currentDraft.current.images.filter(
                          (item) => item.id !== image.id,
                        ),
                      })
                    )
                      setAttachmentError(null);
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </section>
        )}
        {attachmentError && (
          <p className="composer-attachment-error" role="alert">
            {attachmentError}
          </p>
        )}
        {attachmentBusy && <p role="status">{t("imageAttachmentsLoading")}</p>}
        {commandError && (
          <p className="composer-attachment-error" role="alert">
            {commandError}
          </p>
        )}
        {dragActive && (
          <div className="composer-drop-overlay" aria-hidden="true">
            <ImagePlus />
            <span>{t("dropImagesHere")}</span>
          </div>
        )}
        <textarea
          ref={textarea}
          value={prompt}
          rows={1}
          disabled={disabled}
          readOnly={!props.selectedWorkspace}
          aria-label={t("describeTask")}
          aria-autocomplete="list"
          aria-controls={commandListVisible ? slashCommandListId : undefined}
          aria-activedescendant={
            commandListVisible && filteredCommands[activeCommand]
              ? slashCommandOptionId(activeCommand)
              : undefined
          }
          placeholder={placeholder}
          onChange={(event) => {
            if (
              !updateDraft({
                prompt: event.target.value,
                caret: event.target.selectionStart,
              })
            )
              return;
            setCommandError(null);
            setMenuDismissed(false);
          }}
          onClick={(event) =>
            updateDraft({ caret: event.currentTarget.selectionStart })
          }
          onSelect={(event) =>
            updateDraft({ caret: event.currentTarget.selectionStart })
          }
          onFocus={() => {
            setComposerFocused(true);
            setMenuDismissed(false);
          }}
          onBlur={() => setComposerFocused(false)}
          onPaste={(event) => {
            if (!contextEntryAvailable) return;
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) {
              // Some clipboards expose the image only through their items.
              for (const item of Array.from(event.clipboardData.items ?? [])) {
                const file = item.kind === "file" ? item.getAsFile() : null;
                if (file) files.push(file);
              }
            }
            if (files.length === 0) return;
            // Let native text insertion retain its caret and undo transaction.
            if (!event.clipboardData.getData("text/plain"))
              event.preventDefault();
            void stageFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (commandMenuOpen) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveCommand(event.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMenuDismissed(true);
                return;
              }
              if (event.key === "Tab") {
                const command = filteredCommands[activeCommand];
                if (
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  command?.availability === "available"
                ) {
                  event.preventDefault();
                  completeCommand(command);
                }
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                const command = filteredCommands[activeCommand];
                if (command) {
                  event.preventDefault();
                  completeCommand(command);
                  return;
                }
                if (filteredCommands.length > 0) {
                  event.preventDefault();
                  return;
                }
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {commandMenuOpen && (
          <SlashCommandMenu
            activeIndex={activeCommand}
            commandDiscovery={commandDiscovery}
            commands={filteredCommands}
            draft={Boolean(props.workspaceDraft)}
            preferBelow={props.landing}
            onComplete={completeCommand}
            onSelect={setActiveCommand}
          />
        )}
        <div
          className="composer-toolbar"
          hidden={Boolean(selected && !active && !props.workspaceDraft)}
        >
          <div className="composer-toolbar-context">
            {contextEntryAvailable ? (
              <DropdownMenu
                className="composer-context-menu"
                button={{
                  label: t("addContext"),
                  icon: <Plus />,
                  isIconOnly: true,
                  size: "sm",
                  variant: "ghost",
                  className: "composer-context-trigger",
                }}
                items={[
                  {
                    id: "image-attachment",
                    label: t("addImages"),
                    description: t("imageAttachmentDescription"),
                    icon: <ImagePlus />,
                    isDisabled:
                      attachmentBusy ||
                      images.length >= WEB_PROMPT_IMAGE_MAX_COUNT,
                    onClick: () => imagePicker.current?.click(),
                  },
                  {
                    id: "file-reference",
                    label: t("fileReference"),
                    icon: <FileText />,
                    onClick: openFileReference,
                  },
                  {
                    id: "slash-commands",
                    label: t("commands"),
                    description: !active
                      ? t("commandsSessionRequired")
                      : prompt.trim()
                        ? t("commandsEmptyDraftOnly")
                        : undefined,
                    icon: <Command />,
                    isDisabled: !commandEntryAvailable,
                    onClick: () => {
                      if (!updateDraft({ prompt: "/", caret: 1 })) return;
                      setMenuDismissed(false);
                      requestAnimationFrame(() => {
                        if (draftOwner.current.key !== renderedOwnerKey) return;
                        textarea.current?.focus();
                        textarea.current?.setSelectionRange(1, 1);
                      });
                    },
                  },
                ]}
                menuWidth={200}
                placement="above"
                alignment="start"
                hasChevron={false}
              />
            ) : (
              <span className="composer-context-placeholder" />
            )}
          </div>
          <div className="composer-toolbar-controls">
            {props.onInspect && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("runtimeStatus")}
                title={t("runtimeStatus")}
                disabled={!active || props.sessionSwitching}
                onClick={() => props.onInspect?.()}
              >
                <SlidersHorizontal />
              </button>
            )}
            {props.onOpenProviders && (
              <Tooltip content={t("providerAvailability")} placement="above">
                <button
                  type="button"
                  className="icon-button"
                  data-provider-settings-trigger
                  aria-label={t("providerAvailability")}
                  onClick={props.onOpenProviders}
                >
                  <KeyRound />
                </button>
              </Tooltip>
            )}
            <div className="model-picker-wrap">
              <ModelPicker
                snapshot={props.snapshot}
                currentModel={currentModel}
                draftModel={props.draftModel}
                modelSearch={modelSearch}
                modelSelectionPending={Boolean(props.modelSelectionPending)}
                promptAdmissionPending={props.promptAdmissionPending}
                sessionSwitching={props.sessionSwitching}
                liveRunning={running}
                workspaceDraft={Boolean(props.workspaceDraft)}
                actions={props.actions}
              />
            </div>
            {thinking && (
              <div
                className="thinking-picker-wrap"
                data-level={confirmed ?? "none"}
                data-pending={pending !== null}
                data-warning={weak}
                title={
                  thinkingDisabledReason ? t(thinkingDisabledReason) : undefined
                }
              >
                <DropdownMenu
                  className="thinking-menu"
                  isMenuOpen={
                    thinkingMenuOpen &&
                    thinkingDisabledReason === null &&
                    !props.sessionSwitching
                  }
                  onOpenChange={(open: boolean) => {
                    if (!open) {
                      setThinkingMenuOpen(false);
                      return;
                    }
                    if (!thinkingNeedsSession) {
                      setThinkingMenuOpen(true);
                      return;
                    }
                    void props.actions.prepareSession().then((target) => {
                      if (target) setThinkingMenuOpen(true);
                    });
                  }}
                  button={{
                    label: thinkingAria,
                    icon: <Brain />,
                    isIconOnly: true,
                    size: "sm",
                    variant: "ghost",
                    className: "thinking-picker",
                    isDisabled:
                      props.sessionSwitching ||
                      thinkingDisabledReason !== null ||
                      (thinkingItems.length === 0 && !thinkingNeedsSession),
                  }}
                  items={thinkingMenuItems}
                  menuWidth={220}
                  placement="above"
                  alignment="end"
                  hasChevron={false}
                />
              </div>
            )}
            {canStop && (
              <Tooltip content={t("stopTurn")} placement="above">
                <button
                  className="send-button"
                  type="button"
                  aria-label={t("stopTurn")}
                  disabled={
                    props.turnCancellationPending || props.sessionSwitching
                  }
                  onClick={() => void props.actions.cancelActiveTurn()}
                >
                  <Square />
                </button>
              </Tooltip>
            )}
            {(!canStop || Boolean(prompt.trim() || images.length)) && (
              <Tooltip content={t("send")} placement="above">
                <button
                  className="send-button"
                  type="submit"
                  aria-label={t("send")}
                  disabled={
                    attachmentBusy ||
                    props.sessionSwitching ||
                    props.modelSelectionPending ||
                    props.thinkingPendingLevel !== null ||
                    !canCompose ||
                    !props.selectedWorkspace ||
                    props.promptAdmissionPending ||
                    props.planSelectionPending ||
                    Boolean(props.promptAdmissionRecovery) ||
                    Boolean(props.promptAdmissionResolution) ||
                    (!prompt.trim() && images.length === 0)
                  }
                >
                  <Send />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div
          className="composer-hint"
          data-visible={showHint}
          aria-live="polite"
        >
          {canCompose ? hint : null}
        </div>
      </form>
      <FileReferenceDialog
        open={fileReferenceOpen}
        sessionId={active ? selected?.id : undefined}
        onClose={() => setFileReferenceOpen(false)}
        onInsert={insertFileReference}
      />
    </div>
  );
}
