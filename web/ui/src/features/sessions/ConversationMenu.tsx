import { Dialog } from "@astryxdesign/core/Dialog";
import {
  DropdownMenu,
  type DropdownMenuOption,
} from "@astryxdesign/core/DropdownMenu";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Copy,
  Eye,
  GitBranch,
  Monitor,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  SquareArrowOutUpRight,
  Trash2,
  UnfoldVertical,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSessionSummary } from "../../../../protocol/types.ts";
import type { WebSessionForkOptions } from "../../../../runtime/types.ts";
import { copyText } from "../../lib/clipboard.ts";
import { sessionTitle } from "../../lib/format.ts";
import type { WebClient } from "../../protocol/client.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

type MenuSession = Pick<
  WebSessionSummary,
  | "path"
  | "id"
  | "cwd"
  | "name"
  | "firstMessage"
  | "pinOrder"
  | "unread"
  | "readRevision"
  | "execution"
  | "worktree"
>;

export function captureSidebarFocus(trigger: HTMLElement | null) {
  const row = trigger?.closest<HTMLElement>(".session-row, .workspace-group");
  const sidebar = trigger?.closest<HTMLElement>(".session-sidebar");
  const key = row?.dataset.sessionKey;
  const items = Array.from(
    sidebar?.querySelectorAll<HTMLElement>(
      ".session, .workspace-label, .workspace-heading-label",
    ) ?? [],
  );
  const index = items.findIndex((item) => row?.contains(item));
  const neighbors =
    index < 0
      ? items
      : [...items.slice(index + 1), ...items.slice(0, index).reverse()];
  return () =>
    requestAnimationFrame(() => {
      if (!sidebar?.isConnected || document.querySelector("dialog[open]"))
        return;
      const moved =
        key == null
          ? null
          : Array.from(sidebar.querySelectorAll<HTMLElement>(".session-row"))
              .find((item) => item.dataset.sessionKey === key)
              ?.querySelector<HTMLElement>(".menu-action-button");
      const target = [
        trigger,
        moved,
        ...neighbors,
        sidebar.querySelector<HTMLElement>(".new-session-button"),
      ].find(
        (item) =>
          item?.isConnected &&
          !item.closest("[hidden], [inert]") &&
          item.checkVisibility?.() !== false,
      );
      target?.focus({ preventScroll: true });
    });
}

export function ConversationMenu({
  session,
  archived,
  connected,
  pinSaving,
  restoring,
  movementItems,
  client,
  actions,
  onRename,
  onPin,
  onRead,
  onArchive,
  onNotice,
}: {
  session: MenuSession;
  archived: boolean;
  connected: boolean;
  pinSaving: boolean;
  restoring: boolean;
  movementItems: DropdownMenuOption[];
  client: Pick<
    WebClient,
    | "sessionMarkdown"
    | "sessionOpenTargets"
    | "openSessionIn"
    | "sessionForkOptions"
  >;
  actions: Pick<WebStoreActions, "forkConversation" | "deleteSession">;
  onRename: () => void;
  onPin: () => Promise<unknown>;
  onRead: () => Promise<unknown>;
  onArchive: () => Promise<unknown>;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLSpanElement>(null);
  const mounted = useRef(true);
  const targetRequest = useRef(0);
  const deleting = useRef(false);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<
    { id: string; label: string }[] | null
  >(null);
  const [targetsError, setTargetsError] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkOptions, setForkOptions] = useState<WebSessionForkOptions | null>(
    null,
  );
  const [forkOptionsError, setForkOptionsError] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    commandId: string;
    path: string;
    id: string;
    name: string;
    restoreFocus: () => void;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const running =
    session.execution?.status === "running" ||
    session.execution?.waitingForInput;
  const queued =
    (session.execution?.pendingFollowUps ?? 0) +
      (session.execution?.pendingSteering ?? 0) >
    0;
  const busyReason = !connected
    ? t("sidebarActionDisconnected")
    : running || queued
      ? t("sidebarActionRunning")
      : undefined;
  const forkReason = archived
    ? t("sidebarForkArchived")
    : !connected
      ? t("sidebarActionDisconnected")
      : forkOptions?.local === false
        ? t("sidebarForkUnavailable")
        : undefined;
  const deleteTargetChanged =
    deleteTarget !== null &&
    (deleteTarget.path !== session.path || deleteTarget.id !== session.id);
  const pinned = session.pinOrder !== undefined;
  const restoreFocus = () =>
    captureSidebarFocus(root.current?.querySelector("button") ?? null);
  const link = () => {
    const url = new URL("/", window.location.origin);
    url.searchParams.set("sessionPath", session.path);
    url.searchParams.set("sessionId", session.id);
    return url.href;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      targetRequest.current++;
    };
  }, []);

  const menuIdentity = useRef({ id: session.id, path: session.path });
  useEffect(() => {
    if (
      menuIdentity.current.id === session.id &&
      menuIdentity.current.path === session.path
    )
      return;
    menuIdentity.current = { id: session.id, path: session.path };
    // A reused pathname with a new native identity is a different menu target.
    // Keep an existing delete confirmation frozen so its mismatch stays visible.
    setOpen(false);
    setTargets(null);
    setForkOptions(null);
  }, [session.id, session.path]);

  useEffect(() => {
    if (!open || !session.cwd || !connected) return;
    const request = ++targetRequest.current;
    setTargets(null);
    setTargetsError(false);
    void client
      .sessionOpenTargets(session.path, session.id)
      .then((response) => {
        if (mounted.current && targetRequest.current === request)
          setTargets(response.targets);
      })
      .catch(() => {
        if (mounted.current && targetRequest.current === request)
          setTargetsError(true);
      });
    return () => {
      targetRequest.current++;
    };
  }, [client, connected, open, session.cwd, session.id, session.path]);

  useEffect(() => {
    if (!open || archived || !connected) return;
    let cancelled = false;
    setForkOptions(null);
    setForkOptionsError(false);
    void Promise.resolve()
      .then(() => client.sessionForkOptions(session.path, session.id))
      .then((options) => {
        if (!cancelled) setForkOptions(options);
      })
      .catch(() => {
        if (!cancelled) setForkOptionsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [archived, client, connected, open, session.id, session.path]);

  const rename = () => {
    setOpen(false);
    queueMicrotask(onRename);
  };
  const pin = () => {
    const focus = restoreFocus();
    void onPin().then(focus, focus);
  };
  const archive = () => {
    const focus = restoreFocus();
    void onArchive().then(focus, focus);
  };

  const copy = async (kind: "link" | "markdown" | "cwd") => {
    try {
      const text =
        kind === "link"
          ? link()
          : kind === "cwd"
            ? session.cwd
            : (await client.sessionMarkdown(session.path, session.id)).markdown;
      const copied = await copyText(text);
      onNotice(t(copied ? "sidebarCopied" : "sidebarCopyFailed"), !copied);
    } catch {
      onNotice(t("sidebarCopyFailed"), true);
    }
  };
  const fork = async (environment: "local" | "worktree" = "local") => {
    if (forking || forkReason) return;
    if (environment === "worktree" && !forkOptions?.worktree) return;
    setForking(true);
    try {
      if (environment === "worktree") {
        await actions.forkConversation(session.path, session.id, environment);
      } else await actions.forkConversation(session.path, session.id);
    } catch {
      onNotice(t("sidebarForkFailed"), true);
    } finally {
      if (mounted.current) setForking(false);
    }
  };
  const closeDelete = () => {
    if (deleting.current) return;
    const focus = deleteTarget?.restoreFocus;
    setDeleteTarget(null);
    focus?.();
  };
  const remove = async () => {
    if (!deleteTarget || deleting.current || busyReason || deleteTargetChanged)
      return;
    deleting.current = true;
    setDeleteBusy(true);
    setDeleteError(false);
    try {
      const removed = await actions.deleteSession(
        deleteTarget.path,
        deleteTarget.id,
        deleteTarget.commandId,
      );
      if (removed) {
        if (mounted.current) setDeleteTarget(null);
        deleteTarget.restoreFocus();
      } else if (mounted.current) setDeleteError(true);
    } catch {
      if (mounted.current) setDeleteError(true);
    } finally {
      deleting.current = false;
      if (mounted.current) setDeleteBusy(false);
    }
  };
  const items: DropdownMenuOption[] = [
    {
      id: "rename",
      label: t("sidebarRename"),
      icon: <Pencil />,
      isDisabled: !connected,
      onClick: rename,
    },
    ...(!archived
      ? [
          {
            id: "pin",
            label: t(pinned ? "sidebarUnpin" : "sidebarPin"),
            icon: pinned ? <PinOff /> : <Pin />,
            isDisabled: pinSaving || !connected,
            onClick: pin,
          },
          {
            id: "read",
            label: t(
              session.unread
                ? "markConversationRead"
                : "markConversationUnread",
            ),
            icon: <Eye />,
            isDisabled: !session.readRevision || !connected,
            onClick: () => void onRead(),
          },
        ]
      : []),
    ...(movementItems.length
      ? [{ type: "divider" as const }, ...movementItems]
      : []),
    ...(!archived
      ? [
          { type: "divider" as const },
          {
            id: "fork",
            label: forkReason ? (
              <span className="sidebar-menu-unavailable">
                <span>{t("sidebarFork")}</span>
                <small>{forkReason}</small>
              </span>
            ) : (
              t("sidebarFork")
            ),
            icon: <GitBranch />,
            isDisabled: Boolean(forkReason) || forking,
            items: [
              {
                id: "fork-local",
                label: t(
                  forking
                    ? "forkSessionPending"
                    : session.worktree
                      ? "sidebarForkSameWorktree"
                      : "sidebarForkLocal",
                ),
                icon: <Monitor />,
                onClick: () => void fork(),
              },
              ...(forkOptions?.worktree
                ? [
                    {
                      id: "fork-worktree",
                      label: t("sidebarForkWorktree"),
                      icon: (
                        <UnfoldVertical className="sidebar-worktree-icon" />
                      ),
                      onClick: () => void fork("worktree"),
                    },
                  ]
                : forkOptions === null
                  ? [
                      {
                        id: "fork-worktree-loading",
                        label: t(
                          forkOptionsError
                            ? "sidebarForkOptionsFailed"
                            : "sidebarForkOptionsLoading",
                        ),
                        isDisabled: true,
                      },
                    ]
                  : []),
            ],
          },
        ]
      : []),
    { type: "divider" },
    {
      id: "copy",
      label: t("sidebarCopy"),
      icon: <Copy />,
      items: [
        {
          id: "copy-link",
          label: t("sidebarCopyLink"),
          onClick: () => void copy("link"),
        },
        {
          id: "copy-markdown",
          label: t("sidebarCopyMarkdown"),
          isDisabled: !connected,
          onClick: () => void copy("markdown"),
        },
        {
          id: "copy-cwd",
          label: t("sidebarCopyCwd"),
          isDisabled: !session.cwd,
          onClick: () => void copy("cwd"),
        },
      ],
    },
    { type: "divider" },
    {
      id: "new-window",
      label: t("sidebarNewWindow"),
      icon: <SquareArrowOutUpRight />,
      onClick: () => {
        window.open(link(), "_blank", "noopener,noreferrer");
      },
    },
    ...(session.cwd && connected && (targets == null || targets.length > 0)
      ? [
          {
            id: "open-in",
            label: t("sidebarOpenIn"),
            icon: <ArrowUpRight />,
            items: targets?.map((target) => ({
              id: target.id,
              label: target.label,
              onClick: () => {
                void client
                  .openSessionIn(session.path, session.id, target.id)
                  .catch(() => onNotice(t("sidebarOpenFailed"), true));
              },
            })) ?? [
              {
                id: "open-in-loading",
                label: t(
                  targetsError ? "sidebarAppsFailed" : "sidebarAppsLoading",
                ),
                isDisabled: true,
              },
            ],
          },
        ]
      : []),
    { type: "divider" },
    {
      id: archived ? "restore" : "archive",
      label: t(
        restoring
          ? "restoringConversation"
          : archived
            ? "sidebarRestore"
            : "sidebarArchive",
      ),
      icon: archived ? <ArchiveRestore /> : <Archive />,
      isDisabled: restoring || Boolean(busyReason),
      description: busyReason,
      onClick: archive,
    },
    {
      id: "delete",
      label: t("sidebarDelete"),
      icon: <Trash2 />,
      isDisabled: Boolean(busyReason),
      description: busyReason,
      onClick: () => {
        const focus = restoreFocus();
        queueMicrotask(() => {
          if (!mounted.current) return;
          setDeleteError(false);
          setDeleteTarget({
            commandId: crypto.randomUUID(),
            path: session.path,
            id: session.id,
            name: sessionTitle(session, t("untitledSession")),
            restoreFocus: focus,
          });
        });
      },
    },
  ];
  return (
    <>
      <span className="astryx-menu-trigger" ref={root}>
        <DropdownMenu
          className="sidebar-action-menu sidebar-conversation-menu"
          button={{
            label: t("conversationOptions"),
            icon: <MoreHorizontal />,
            isIconOnly: true,
            size: "sm",
            variant: "ghost",
            className: "menu-action-button",
          }}
          items={open ? items : []}
          menuWidth={248}
          placement="below"
          alignment="start"
          hasChevron={false}
          isMenuOpen={open}
          onOpenChange={setOpen}
        />
      </span>
      {deleteTarget && (
        <Dialog
          isOpen={deleteTarget !== null}
          onOpenChange={(value: boolean) => {
            if (!value) closeDelete();
          }}
          purpose="form"
          width={420}
          aria-label={t("sidebarDeleteTitle")}
        >
          <form
            className="openpi-dialog sidebar-delete-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            <strong>{t("sidebarDeleteTitle")}</strong>
            <p>
              {t("sidebarDeleteDescription", {
                name: deleteTarget?.name,
              })}
            </p>
            {(deleteError || deleteTargetChanged) && (
              <p className="sidebar-dialog-error" role="alert">
                {t(
                  deleteTargetChanged
                    ? "sessionLinkUnavailable"
                    : "sidebarDeleteFailed",
                )}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                data-autofocus
                disabled={deleteBusy}
                onClick={closeDelete}
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                className="danger"
                disabled={
                  deleteBusy || Boolean(busyReason) || deleteTargetChanged
                }
              >
                {t(deleteBusy ? "sidebarDeleting" : "sidebarDeleteConfirm")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
