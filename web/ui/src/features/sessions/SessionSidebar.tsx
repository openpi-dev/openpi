import { Dialog } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import type { DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Archive,
  ChevronsLeft,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { OpenPiLogo } from "../../components/OpenPiLogo.tsx";
import { relativeTime, sessionTitle } from "../../lib/format.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

interface SessionSidebarProps {
  snapshot: WebSnapshot | null;
  selectedPath: string | null;
  selectedWorkspace: string | null;
  collapsed: Set<string>;
  query: string;
  searchOpen: boolean;
  mobileOpen: boolean;
  actions: WebStoreActions;
}

type EditTarget = { kind: "workspace" | "session"; path: string; name: string };
type DeleteTarget = { path: string; name: string };

function ActionMenu({
  items,
  label,
}: {
  items: DropdownMenuOption[];
  label: string;
}) {
  return (
    <span className="astryx-menu-trigger">
      <DropdownMenu
        button={{
          label,
          icon: <MoreHorizontal />,
          isIconOnly: true,
          size: "sm",
          variant: "ghost",
          className: "menu-action-button",
        }}
        items={items}
        menuWidth={190}
        placement="below"
        alignment="end"
        hasChevron={false}
      />
    </span>
  );
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t } = useTranslation();
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [draft, setDraft] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const snapshot = props.snapshot;

  useEffect(() => {
    if (props.searchOpen) searchInput.current?.focus();
  }, [props.searchOpen]);
  useEffect(() => {
    if (!editTarget) return;
    editInput.current?.focus();
    editInput.current?.select();
  }, [editTarget]);

  const grouped = useMemo(() => {
    const query = props.query.trim().toLowerCase();
    const visible = (workspacePath?: string) =>
      (snapshot?.sessions ?? []).filter(
        (session) =>
          !session.archived &&
          (workspacePath === "__ungrouped__"
            ? session.ungrouped
            : session.cwd === workspacePath && !session.ungrouped) &&
          (!query ||
            `${sessionTitle(session, t("untitledSession"))} ${session.cwd}`
              .toLowerCase()
              .includes(query)),
      );
    return [
      ...(snapshot?.workspaces ?? []).map((workspace) => ({
        ...workspace,
        sessions: visible(workspace.path),
        ungrouped: false,
      })),
      {
        path: "__ungrouped__",
        name: t("ungrouped"),
        current: false,
        sessions: visible("__ungrouped__"),
        ungrouped: true,
      },
    ].filter(
      (group) => group.sessions.length > 0 || (!group.ungrouped && !query),
    );
  }, [props.query, snapshot, t]);

  const openEdit = (target: EditTarget) => {
    setDraft(target.name);
    setEditTarget(target);
  };
  const saveEdit = async () => {
    const name = draft.trim();
    if (!editTarget || !name) return;
    if (editTarget.kind === "workspace")
      await props.actions.renameWorkspace(editTarget.path, name);
    else await props.actions.renameSession(editTarget.path, name);
    setEditTarget(null);
  };

  return (
    <aside className="session-sidebar" aria-label="Session navigation">
      <div className="sidebar-brand">
        <OpenPiLogo compact />
        <Tooltip content={t("collapseSidebar")} placement="end">
          <button
            className="collapse-button"
            type="button"
            aria-label={t("collapseSidebar")}
            onClick={() =>
              props.mobileOpen
                ? props.actions.closeMobileSidebar()
                : props.actions.toggleSidebar(false)
            }
          >
            <ChevronsLeft />
          </button>
        </Tooltip>
      </div>

      <button
        className="new-session-button"
        type="button"
        onClick={() =>
          props.selectedWorkspace
            ? void props.actions.createSession(props.selectedWorkspace)
            : void props.actions.chooseWorkspace()
        }
      >
        <SquarePen />
        <span>{t("newSession")}</span>
      </button>

      <div
        className={`workspace-heading ${props.searchOpen ? "is-searching" : ""}`}
      >
        <span className="workspace-heading-label">{t("workspaces")}</span>
        <div className="session-search">
          <Search />
          <input
            ref={searchInput}
            type="search"
            value={props.query}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchConversations")}
            onChange={(event) => props.actions.setQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label={t("closeSearch")}
            onClick={() => props.actions.setSearchOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="workspace-actions">
          <Tooltip content={t("searchConversations")}>
            <button
              className="icon-button"
              type="button"
              aria-label={t("searchConversations")}
              onClick={() => props.actions.setSearchOpen(true)}
            >
              <Search />
            </button>
          </Tooltip>
          <Tooltip content={t("addWorkspace")}>
            <button
              className="icon-button"
              type="button"
              aria-label={t("addWorkspace")}
              onClick={() => void props.actions.chooseWorkspace()}
            >
              <Plus />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="workspace-tree">
        {grouped.length ? (
          grouped.map((group) => {
            const collapsed = props.collapsed.has(group.path);
            return (
              <section
                className={`workspace-group ${collapsed ? "collapsed" : ""}`}
                key={group.path}
              >
                <div className="workspace-button">
                  <button
                    className="workspace-label"
                    type="button"
                    aria-expanded={!collapsed}
                    title={
                      group.path === "__ungrouped__" ? undefined : group.path
                    }
                    onClick={() => props.actions.toggleWorkspace(group.path)}
                  >
                    <span className="workspace-toggle" aria-hidden="true">
                      <span className="workspace-chevron">⌄</span>
                    </span>
                    <strong>{group.name}</strong>
                  </button>
                  {!group.ungrouped && (
                    <span className="workspace-row-actions">
                      <ActionMenu
                        label="Workspace options"
                        items={[
                          {
                            id: "rename",
                            label: t("renameWorkspace"),
                            icon: <SquarePen />,
                            onClick: () =>
                              openEdit({
                                kind: "workspace",
                                path: group.path,
                                name: group.name,
                              }),
                          },
                          {
                            id: "remove",
                            label: t("removeWorkspace"),
                            icon: <Trash2 />,
                            variant: "destructive",
                            onClick: () =>
                              setDeleteTarget({
                                path: group.path,
                                name: group.name,
                              }),
                          },
                        ]}
                      />
                      <Tooltip content={t("newSession")}>
                        <button
                          className="workspace-action"
                          type="button"
                          aria-label={`${t("newSession")} ${group.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void props.actions.createSession(group.path);
                          }}
                        >
                          <Plus />
                        </button>
                      </Tooltip>
                    </span>
                  )}
                </div>
                <div className="workspace-sessions">
                  {group.sessions.length ? (
                    group.sessions.map((session) => (
                      <div className="session-row" key={session.path}>
                        <button
                          className={`session ${session.path === props.selectedPath ? "active" : ""}`}
                          type="button"
                          aria-current={
                            session.path === props.selectedPath
                              ? "page"
                              : undefined
                          }
                          title={sessionTitle(session, t("untitledSession"))}
                          onClick={() =>
                            void props.actions.selectSession(session.path)
                          }
                        >
                          <span className="session-title">
                            {sessionTitle(session, t("untitledSession"))}
                          </span>
                          <span className="session-time">
                            {relativeTime(session.modified)}
                          </span>
                        </button>
                        <ActionMenu
                          label={t("conversationOptions")}
                          items={[
                            {
                              id: "rename",
                              label: t("renameConversation"),
                              icon: <SquarePen />,
                              onClick: () =>
                                openEdit({
                                  kind: "session",
                                  path: session.path,
                                  name: sessionTitle(
                                    session,
                                    t("untitledSession"),
                                  ),
                                }),
                            },
                            {
                              id: "archive",
                              label: t("archiveConversation"),
                              icon: <Archive />,
                              onClick: () =>
                                void props.actions.archiveSession(session.path),
                            },
                          ]}
                        />
                      </div>
                    ))
                  ) : (
                    <div className="empty">{t("noConversations")}</div>
                  )}
                </div>
              </section>
            );
          })
        ) : (
          <div className="empty">
            {props.query ? t("noMatching") : t("noSessions")}
          </div>
        )}
      </div>

      <Dialog
        isOpen={Boolean(editTarget)}
        onOpenChange={(open: boolean) => !open && setEditTarget(null)}
        purpose="form"
        width={400}
        aria-label={
          editTarget?.kind === "workspace"
            ? t("renameWorkspace")
            : t("renameConversation")
        }
      >
        <form
          className="openpi-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <strong>
            {editTarget?.kind === "workspace"
              ? t("renameWorkspace")
              : t("renameConversation")}
          </strong>
          <input
            ref={editInput}
            value={draft}
            maxLength={80}
            aria-label={
              editTarget?.kind === "workspace"
                ? t("workspaceName")
                : t("conversationName")
            }
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" onClick={() => setEditTarget(null)}>
              {t("cancel")}
            </button>
            <button type="submit" className="primary">
              {t("save")}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(open: boolean) => !open && setDeleteTarget(null)}
        purpose="form"
        width={440}
        aria-label={t("deleteWorkspace")}
      >
        <div className="openpi-dialog">
          <strong>{t("deleteWorkspace")}</strong>
          <p>
            {deleteTarget?.name}：{t("workspaceDeleteConfirm")}
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!deleteTarget) return;
                void props.actions.removeWorkspace(deleteTarget.path);
                setDeleteTarget(null);
              }}
            >
              {t("deleteWorkspace")}
            </button>
          </div>
        </div>
      </Dialog>
    </aside>
  );
}
