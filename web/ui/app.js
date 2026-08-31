const collapsedWorkspacesStorageKey = "openpi.collapsed-workspaces";
const archivedSessionsStorageKey = "openpi.archived-sessions";
function readCollapsedWorkspaces() {
  for (const storageName of ["localStorage", "sessionStorage"]) {
    try {
      const storage = window[storageName];
      const value = JSON.parse(storage.getItem(collapsedWorkspacesStorageKey) || "[]");
      if (Array.isArray(value)) return new Set(value.filter((path) => typeof path === "string"));
    } catch {}
  }
  return new Set();
}

function readArchivedSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(archivedSessionsStorageKey) || "[]");
    return new Set(Array.isArray(value) ? value.filter((path) => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

function persistArchivedSessions() {
  try { localStorage.setItem(archivedSessionsStorageKey, JSON.stringify([...state.archivedSessions])); } catch {}
}
function persistCollapsedWorkspaces(collapsed) {
  const value = JSON.stringify([...collapsed]);
  for (const storageName of ["localStorage", "sessionStorage"]) {
    try {
      const storage = window[storageName];
      storage.setItem(collapsedWorkspacesStorageKey, value);
      return;
    } catch {}
  }
}

const state = {
  snapshot: null,
  selectedPath: null,
  collapsed: readCollapsedWorkspaces(),
  archivedSessions: readArchivedSessions(),
  liveMessages: [],
  liveRunning: false,
  livePhase: "idle",
  liveRetry: null,
  query: "",
  selectedWorkspace: null,
  language: (() => {
    try { return localStorage.getItem("openpi.language") === "zh" ? "zh" : "en"; } catch { return "en"; }
  })(),
};

const translations = {
  en: {
    newSession: "New session",
    untitledSession: "New session",
    workspaces: "Workspaces",
    addWorkspace: "Add workspace",
    settings: "Settings",
    close: "Close",
    closeSettings: "Close settings",
    generalSettings: "General settings",
    language: "Language",
    languageHint: "Choose the language used by the OpenPI interface.",
    selectWorkspace: "Select workspace",
    describeTask: "Describe a task",
    chooseWorkspaceHint: "Choose a workspace and describe the work",
    promptStart: "Choose a workspace to begin.",
    promptTask: "Describe what you want to build.",
    promptMessage: "Send a message to the active Web session",
    promptReadonly: "This conversation is read-only",
    searchConversations: "Search conversations",
    closeSearch: "Close search",
    searchPlaceholder: "Search conversations...",
    noSessions: "No sessions",
    noMatching: "No matching conversations",
    noConversations: "No conversations yet",
    addWorkspaceMenu: "Add workspace...",
    renameConversation: "Rename conversation",
    archiveConversation: "Archive conversation",
    deleteWorkspace: "Delete workspace",
    cancel: "Cancel",
    workspaceDeleteConfirm: "The folder and conversation records will be kept. Its conversations will move to Ungrouped.",
    ungrouped: "Ungrouped",
    conversationName: "Conversation name",
    conversationOptions: "Conversation options",
    queuedHint: "The message will be queued after the current turn.",
    enterHint: "Enter to send, Shift+Enter for a new line.",
    activeOnlyHint: "Only the active Web session accepts messages.",
    acceptedHint: "Message accepted by OpenPI Web.",
    modelRunning: "Working...",
    modelPreparing: "Preparing task...",
    modelRetrying: "Retrying model request...",
  },
  zh: {
    newSession: "新建会话",
    untitledSession: "新会话",
    workspaces: "工作区",
    addWorkspace: "添加工作区",
    settings: "设置",
    close: "关闭",
    closeSettings: "关闭设置",
    generalSettings: "通用设置",
    language: "语言",
    languageHint: "选择 OpenPI 界面使用的语言。",
    selectWorkspace: "选择工作区",
    describeTask: "描述任务",
    chooseWorkspaceHint: "选择工作区并描述任务",
    promptStart: "选择一个工作区开始",
    promptTask: "描述你想要构建的任务",
    promptMessage: "向当前 Web 会话发送消息",
    promptReadonly: "此会话为只读",
    searchConversations: "搜索会话",
    closeSearch: "关闭搜索",
    searchPlaceholder: "搜索会话...",
    noSessions: "暂无会话",
    noMatching: "没有匹配的会话",
    noConversations: "暂无对话",
    addWorkspaceMenu: "添加工作区...",
    renameConversation: "重命名会话",
    archiveConversation: "归档会话",
    deleteWorkspace: "删除工作区",
    cancel: "取消",
    workspaceDeleteConfirm: "文件夹与会话记录会保留，其中的会话会被放到“未分组”；再次打开此目录时将是一个干净的工作区。",
    ungrouped: "未分组",
    conversationName: "会话名称",
    conversationOptions: "会话选项",
    queuedHint: "当前回合结束后将发送消息。",
    enterHint: "按 Enter 发送，Shift+Enter 换行。",
    activeOnlyHint: "只有当前 Web 会话可以接收消息。",
    acceptedHint: "OpenPI Web 已接收消息。",
    modelRunning: "正在运行...",
    modelPreparing: "正在准备任务...",
    modelRetrying: "模型请求重试中...",
  },
};
const t = (key) => translations[state.language][key] || translations.en[key] || key;
function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAria)); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.title = t(element.dataset.i18nTitle); });
  const search = $("search");
  if (search) search.placeholder = t("searchPlaceholder");
  const picker = $("language-picker-value");
  if (picker) picker.textContent = state.language === "zh" ? "中文" : "English";
  document.querySelectorAll("#language-menu [data-language]").forEach((option) => {
    option.setAttribute("aria-selected", option.dataset.language === state.language ? "true" : "false");
  });
  renderWorkspacePicker();
  if (state.snapshot) {
    renderWorkspaces();
    renderConversation();
  }
}

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get("token");
const headers = (json = false) => ({
  Authorization: `Bearer ${token}`,
  ...(json ? { "Content-Type": "application/json" } : {}),
});
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const markdownRenderer = (() => {
  const markdown = globalThis.marked;
  if (!markdown?.Renderer) return null;
  const renderer = new markdown.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = ({ href, title, tokens }) => {
    const safeHref = safeMarkdownUrl(href);
    const label = renderer.parser.parseInline(tokens);
    if (!safeHref) return label;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute} target="_blank" rel="noreferrer">${label}</a>`;
  };
  renderer.image = ({ href, title, text, tokens }) => {
    const safeHref = safeMarkdownUrl(href, true);
    const alt = tokens ? renderer.parser.parseInline(tokens, renderer.parser.textRenderer) : text;
    if (!safeHref) return escapeHtml(alt);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(alt)}"${titleAttribute} loading="lazy">`;
  };
  return renderer;
})();

function safeMarkdownUrl(value, image = false) {
  try {
    const url = new URL(String(value ?? ""), document.baseURI);
    const allowedProtocols = image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
    return allowedProtocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderMarkdown(value) {
  const content = String(value ?? "");
  if (!markdownRenderer || !globalThis.marked?.parse) return escapeHtml(content);
  try {
    return globalThis.marked.parse(content, {
      renderer: markdownRenderer,
      gfm: true,
      breaks: true,
    });
  } catch {
    return escapeHtml(content);
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function sessionTitle(session) {
  return session.name?.trim() || session.firstMessage?.trim() || t("untitledSession");
}

function compactSummary(value, limit = 96) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function relativeTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function visibleSessions(workspacePath) {
  const query = state.query.toLowerCase();
  return state.snapshot.sessions.filter(
    (session) =>
      session.cwd === workspacePath &&
      !session.ungrouped &&
      !session.archived &&
      !state.archivedSessions.has(session.path) &&
      (!query ||
        [sessionTitle(session), session.cwd]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
}

function visibleUngroupedSessions() {
  const query = state.query.toLowerCase();
  return state.snapshot.sessions.filter(
    (session) =>
      session.ungrouped &&
      !session.archived &&
      !state.archivedSessions.has(session.path) &&
      (!query ||
        [sessionTitle(session), session.cwd]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
}

const ICONS = {
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h5l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"></path>',
  chevronDown: '<path d="m6 9 6 6 6-6"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  more: '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>',
};

function icon(name, className = "icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

function renderWorkspaces() {
  if (!state.snapshot) return;
  const groups = state.snapshot.workspaces
    .map((workspace) => {
      const sessions = visibleSessions(workspace.path);
      if (state.query && sessions.length === 0) return "";
      const collapsed = state.collapsed.has(workspace.path);
      return `<section class="workspace-group ${collapsed ? "collapsed" : ""}" data-workspace="${escapeHtml(workspace.path)}">
        <div class="workspace-button" role="treeitem" aria-expanded="${!collapsed}" title="${escapeHtml(workspace.path)}">
          <button class="workspace-toggle" type="button" aria-label="Toggle ${escapeHtml(workspace.name)}" aria-expanded="${!collapsed}">
            ${icon("chevronDown", "workspace-chevron icon")}
          </button>
          <strong>${escapeHtml(workspace.name)}</strong>
          <span class="workspace-row-actions">
            <button class="workspace-action" type="button" data-workspace-action="more" aria-label="Workspace options" title="Workspace options">${icon("more", "icon")}</button>
            <button class="workspace-action" type="button" data-workspace-action="new" aria-label="New session in ${escapeHtml(workspace.name)}" title="New session">${icon("plus", "icon")}</button>
          </span>
        </div>
        <div class="workspace-sessions">
          ${
            sessions.length
              ? sessions
                  .map(
                    (session) => `<div class="session-row">
                      <button class="session ${session.path === state.selectedPath ? "active" : ""}" type="button" role="treeitem" aria-current="${session.path === state.selectedPath ? "page" : "false"}" data-session="${escapeHtml(session.path)}" title="${escapeHtml(sessionTitle(session))}">
                        <span class="session-title">${escapeHtml(sessionTitle(session))}</span>
                        <span class="session-time">${escapeHtml(relativeTime(session.modified))}</span>
                      </button>
                      <button class="session-action" type="button" data-session-action="menu" data-session-path="${escapeHtml(session.path)}" aria-label="${escapeHtml(t("conversationOptions"))}" title="${escapeHtml(t("conversationOptions"))}">${icon("more", "icon")}</button>
                    </div>`,
                  )
                  .join("")
              : `<div class="empty">${escapeHtml(t("noConversations"))}</div>`
          }
        </div>
      </section>`;
    })
    .join("");
  const ungrouped = visibleUngroupedSessions();
  const ungroupedGroup = ungrouped.length
    ? `<section class="workspace-group ungrouped ${state.collapsed.has("__ungrouped__") ? "collapsed" : ""}" data-workspace="__ungrouped__">
        <div class="workspace-button" role="treeitem" aria-expanded="${!state.collapsed.has("__ungrouped__")}">
          <button class="workspace-toggle" type="button" aria-label="${escapeHtml(t("ungrouped"))}" aria-expanded="${!state.collapsed.has("__ungrouped__")}">${icon("chevronDown", "workspace-chevron icon")}</button>
          <strong>${escapeHtml(t("ungrouped"))}</strong>
        </div>
        <div class="workspace-sessions">${ungrouped.map((session) => `<div class="session-row">
          <button class="session ${session.path === state.selectedPath ? "active" : ""}" type="button" role="treeitem" aria-current="${session.path === state.selectedPath ? "page" : "false"}" data-session="${escapeHtml(session.path)}" title="${escapeHtml(sessionTitle(session))}">
            <span class="session-title">${escapeHtml(sessionTitle(session))}</span><span class="session-time">${escapeHtml(relativeTime(session.modified))}</span>
          </button>
          <button class="session-action" type="button" data-session-action="menu" data-session-path="${escapeHtml(session.path)}" aria-label="${escapeHtml(t("conversationOptions"))}" title="${escapeHtml(t("conversationOptions"))}">${icon("more", "icon")}</button>
        </div>`).join("")}</div>
      </section>`
    : "";
  $("workspaces").innerHTML = groups + ungroupedGroup || `<div class="empty">${escapeHtml(state.query ? t("noMatching") : t("noSessions"))}</div>`;

  document.querySelectorAll(".workspace-toggle").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      toggleWorkspace(button.closest(".workspace-group").dataset.workspace);
    };
  });
  document.querySelectorAll(".workspace-button").forEach((button) => {
    button.onclick = () => toggleWorkspace(button.closest(".workspace-group").dataset.workspace);
  });
  document.querySelectorAll(".workspace-action").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const path = button.closest(".workspace-group").dataset.workspace;
      if (button.dataset.workspaceAction === "new") void createSession(path);
      else openWorkspaceMenu(path, button);
    };
  });
  document.querySelectorAll(".session").forEach((button) => {
    button.onclick = async () => {
      const previousPath = state.selectedPath;
      state.selectedPath = button.dataset.session;
      document.body.classList.remove("sidebar-open");
      renderWorkspaces();
      try {
        await api("/api/sessions/select", {
          method: "POST",
          body: JSON.stringify({ path: state.selectedPath }),
        });
        await refreshSnapshot();
      } catch (error) {
        state.selectedPath = previousPath;
        showNotice(error.message);
        await refreshSnapshot();
      }
    };
  });
  document.querySelectorAll(".session-action").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      openSessionMenu(button.dataset.sessionPath, button);
    };
  });
}

function messageMarkup(entry) {
  const message = entry.message;
  if (!message) return "";
  if (message.role === "user") {
    return `<article class="message-row user">
      <div class="message-content"><div class="message-body">${escapeHtml(message.content)}</div></div>
    </article>`;
  }
  if (message.role === "assistant") {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const detailItems = parts
      .filter((part) => part.type === "thinking" || part.type === "toolCall")
      .map((part) => {
        const title = part.type === "thinking" ? "Thinking" : `${part.name} · tool call`;
        const body = part.type === "thinking" ? part.text : part.arguments;
        return `<details class="message-details assistant-detail">
          <summary><span class="details-mark" aria-hidden="true"></span><span class="details-title">${escapeHtml(title)}</span></summary>
          <div class="details-body tool-evidence">${escapeHtml(body)}</div>
        </details>`;
      });
    const detailRows = detailItems
      .map(
        (detail) => `<article class="message-row assistant detail-only">
      <div class="message-content">${detail}</div>
    </article>`,
      )
      .join("");
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const contentRow = content
      ? `<article class="message-row assistant">
      <div class="message-content"><div class="message-body markdown">${renderMarkdown(content)}</div></div>
    </article>`
      : "";
    return detailRows + contentRow;
  }
  if (message.role === "toolResult") {
    const toolName = message.toolName || "tool";
    const summary = compactSummary(message.content || "completed");
    return `<article class="message-row assistant detail-only">
      <div class="message-content"><details class="message-details tool-details">
        <summary><span class="details-mark" aria-hidden="true"></span><span class="details-title">${escapeHtml(toolName)} · ${escapeHtml(summary)}</span></summary>
        <div class="details-body tool-evidence">${escapeHtml(message.content || "completed")}</div>
      </details></div>
    </article>`;
  }
  return "";
}

function landingMarkup() {
  return `<div class="landing-welcome">
    <div class="landing-brand"><strong>Open<span class="pixel-mark" aria-label="OpenPI"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></strong></div>
  </div>`;
}

function renderConversation() {
  const snapshot = state.snapshot;
  const selected = snapshot?.selectedSession;
  const shell = document.querySelector(".conversation-shell");
  if (!shell) {
    updateComposer();
    return;
  }
  const summary = snapshot?.sessions.find((session) => session.path === state.selectedPath);
  const persistedEntries = selected?.entries || [];
  const persistedMessageKeys = new Set(
    persistedEntries.map((entry) => `${entry.message?.role || ""}:${entry.message?.content || ""}`),
  );
  const liveEntries = selected
    ? state.liveMessages
        .filter(({ message }) => !persistedMessageKeys.has(`${message.role || ""}:${message.content || ""}`))
        .map(({ message }) => messageMarkup({ type: "message", message }))
    : [];
  const messages = selected
    ? [...persistedEntries.map(messageMarkup).filter(Boolean), ...liveEntries].join("")
    : "";
  const landing = !selected || !summary || !messages;
  shell.classList.toggle("landing", landing);

  if (landing) {
    $("conversation").innerHTML = landingMarkup();
    $("session-header").innerHTML = `<strong>${escapeHtml(t("newSession"))}</strong><small>${escapeHtml(t("chooseWorkspaceHint"))}</small>`;
    updateComposer();
    return;
  }

  $("session-header").innerHTML = `<strong>${escapeHtml(sessionTitle(summary))}</strong><small>${escapeHtml(selected.cwd)}</small>`;
  const isCurrentSession = selected.id === snapshot.currentSessionId;
  const isRunning = isCurrentSession && (snapshot.runtime.status === "running" || state.liveRunning);
  const runningLabel = state.liveRetry
    ? `${t("modelRetrying")} (${state.liveRetry.attempt}/${state.liveRetry.maxAttempts})`
    : state.livePhase === "preparing" ? t("modelPreparing") : t("modelRunning");
  $("conversation").innerHTML = `${messages}${isRunning ? `<div class="conversation-running" role="status" aria-live="polite"><span class="conversation-running-dot" aria-hidden="true"></span><span>${escapeHtml(runningLabel)}</span></div>` : ""}`;
  $("conversation").scrollTop = $("conversation").scrollHeight;
  updateComposer();
}

function updateComposer() {
  const selected = state.snapshot?.selectedSession;
  const active = selected?.id === state.snapshot?.currentSessionId;
  $("prompt-input").disabled = !active && Boolean(state.selectedWorkspace);
  $("send-prompt").disabled = !active || !state.selectedWorkspace || state.liveRunning;
  const modelPicker = $("model-picker");
  const modelPickerValue = $("model-picker-value");
  const modelMenu = $("model-menu");
  const models = state.snapshot?.models || [];
  if (modelPicker && models.length > 0) {
    const current = models.find((model) => model.current) || models[0];
    if (modelPickerValue) modelPickerValue.textContent = current.label;
    if (modelMenu) {
      modelMenu.innerHTML = models
        .map((model) => `<button type="button" role="option" data-model="${escapeHtml(`${model.provider}/${model.id}`)}" aria-selected="${model.current ? "true" : "false"}"><span>${escapeHtml(model.label)}</span><span class="model-menu-check">✓</span></button>`)
        .join("");
      modelMenu.querySelectorAll("[data-model]").forEach((option) => {
        option.onclick = () => {
          modelMenu.hidden = true;
          modelPicker.setAttribute("aria-expanded", "false");
          void selectModel(option.dataset.model);
        };
      });
    }
    modelPicker.disabled = !active || !state.selectedWorkspace || state.liveRunning;
  } else if (modelPicker) {
    if (modelPickerValue) modelPickerValue.textContent = "No models available";
    if (modelMenu) modelMenu.innerHTML = "";
    modelPicker.disabled = true;
  }
  const shell = document.querySelector(".conversation-shell");
  const landing = !shell || shell.classList.contains("landing");
  $("prompt-input").placeholder = !state.selectedWorkspace
    ? t("promptStart")
    : landing
      ? t("promptTask")
      : active
        ? t("promptMessage")
        : t("promptReadonly");
  $("composer-hint").textContent = active
    ? state.snapshot.runtime.status === "running"
      ? t("queuedHint")
      : t("enterHint")
    : t("activeOnlyHint");
}

async function selectModel(value) {
  const [provider, ...idParts] = value.split("/");
  const modelId = idParts.join("/");
  if (!provider || !modelId) return;
  const picker = $("model-picker");
  if (picker) picker.disabled = true;
  try {
    await api("/api/model", {
      method: "POST",
      body: JSON.stringify({ provider, modelId }),
    });
    await refreshSnapshot();
  } catch (error) {
    showNotice(error.message);
    await refreshSnapshot();
  }
}

async function refreshSnapshot() {
  try {
    const suffix = state.selectedPath
      ? `?path=${encodeURIComponent(state.selectedPath)}`
      : "";
    state.snapshot = await api(`/api/snapshot${suffix}`);
    const availableWorkspaces = state.snapshot.workspaces;
    const selectedSessionWorkspace = state.snapshot.selectedSession?.cwd;
    const activeWorkspace = availableWorkspaces.find((workspace) => workspace.current)?.path;
    const readyWorkspace = availableWorkspaces.some((workspace) => workspace.path === selectedSessionWorkspace)
      ? selectedSessionWorkspace
      : activeWorkspace;
    setWorkspaceReady(readyWorkspace);
    if (!state.selectedPath) {
      const current = state.snapshot.sessions.find(
        (session) => session.id === state.snapshot.currentSessionId,
      );
      state.selectedPath = current?.path || state.snapshot.sessions[0]?.path || null;
      if (state.selectedPath && state.snapshot.selectedSession?.path !== state.selectedPath) {
        return refreshSnapshot();
      }
    }
    renderWorkspaces();
    renderConversation();
  } catch (error) {
    $("connection-state").textContent = "Unavailable";
    $("connection-state").classList.add("reconnecting");
    $("composer-hint").textContent = error.message;
    $("composer-hint").classList.add("error");
  }
}

let refreshTimer = null;
let refreshInFlight = false;
let refreshPending = false;

function scheduleSnapshotRefresh(delay = 160) {
  if (refreshInFlight) {
    refreshPending = true;
    return;
  }
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null;
    refreshInFlight = true;
    try {
      await refreshSnapshot();
    } finally {
      refreshInFlight = false;
      if (refreshPending) {
        refreshPending = false;
        scheduleSnapshotRefresh();
      }
    }
  }, delay);
}

async function sendPrompt() {
  if (!state.selectedWorkspace) {
    await chooseWorkspace();
    return;
  }
  const content = $("prompt-input").value.trim();
  const sessionId = state.snapshot?.selectedSession?.id;
  if (!content || !sessionId) return;
  const optimisticKey = `optimistic-${Date.now()}`;
  state.liveMessages = [
    ...state.liveMessages,
    { key: optimisticKey, message: { role: "user", content } },
  ].slice(-8);
  state.liveRunning = true;
  renderConversation();
  $("send-prompt").disabled = true;
  $("composer-hint").classList.remove("error");
  try {
    await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, content }),
    });
    $("prompt-input").value = "";
    resizePrompt();
    $("composer-hint").textContent = t("acceptedHint");
    scheduleSnapshotRefresh(120);
  } catch (error) {
    state.liveRunning = false;
    state.livePhase = "idle";
    state.liveRetry = null;
    state.liveMessages = state.liveMessages.filter(
      (entry) => entry.key !== optimisticKey,
    );
    $("composer-hint").textContent = error.message;
    $("composer-hint").classList.add("error");
    renderConversation();
  } finally {
    updateComposer();
  }
}

function resizePrompt() {
  const input = $("prompt-input");
  const maxHeight = 220;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function workspaceName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function setWorkspaceReady(path) {
  state.selectedWorkspace = path || null;
  const composer = $("composer");
  const input = $("prompt-input");
  composer?.classList.toggle("dormant", !state.selectedWorkspace);
  if (input) input.readOnly = !state.selectedWorkspace;
  $("selected-workspace").textContent = state.selectedWorkspace
    ? workspaceName(state.selectedWorkspace)
    : t("selectWorkspace");
  renderWorkspacePicker();
}

function renderWorkspacePicker() {
  const menu = $("workspace-picker-menu");
  const picker = $("select-workspace");
  if (!menu || !picker) return;
  const workspaces = state.snapshot?.workspaces || [];
  if (workspaces.length === 0) {
    menu.hidden = true;
    picker.setAttribute("aria-expanded", "false");
    $("selected-workspace").textContent = t("selectWorkspace");
    return;
  }
  menu.innerHTML = `${workspaces.map((workspace) => `<button type="button" role="option" data-workspace-path="${escapeHtml(workspace.path)}" aria-selected="${workspace.path === state.selectedWorkspace ? "true" : "false"}">${icon("folder", "workspace-menu-icon icon")}<span>${escapeHtml(workspace.name)}</span><span class="workspace-menu-check">✓</span></button>`).join("")}<button type="button" class="workspace-menu-add" data-workspace-add="true">${icon("plus", "workspace-menu-icon icon")}<span>${escapeHtml(t("addWorkspaceMenu"))}</span></button>`;
  picker.setAttribute("aria-expanded", String(!menu.hidden));
  menu.querySelectorAll("[data-workspace-path]").forEach((button) => {
    button.onclick = () => {
      const path = button.dataset.workspacePath;
      menu.hidden = true;
      picker.setAttribute("aria-expanded", "false");
      if (!path) return;
      setWorkspaceReady(path);
      void refreshSnapshot();
    };
  });
  menu.querySelector("[data-workspace-add]")?.addEventListener("click", () => {
    menu.hidden = true;
    picker.setAttribute("aria-expanded", "false");
    void chooseWorkspace();
  });
}

function toggleWorkspace(path) {
  if (state.collapsed.has(path)) state.collapsed.delete(path);
  else state.collapsed.add(path);
  persistCollapsedWorkspaces(state.collapsed);
  renderWorkspaces();
}

function closeSearch({ restoreFocus = true } = {}) {
  const search = $("search");
  const heading = search?.closest(".workspace-heading");
  if (!search || !heading) return;
  heading.classList.remove("is-searching");
  search.value = "";
  state.query = "";
  renderWorkspaces();
  if (restoreFocus) $("search-toggle")?.focus();
}

async function createSession(workspacePath) {
  try {
    const result = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspacePath }),
    });
    if (!result.cancelled) {
      state.selectedPath = null;
      document.body.classList.remove("sidebar-open");
      await refreshSnapshot();
      $("prompt-input")?.focus();
    }
  } catch (error) {
    showNotice(error.message);
  }
}

function showNotice(message) {
  $("composer-hint").textContent = message;
  $("composer-hint").classList.add("error");
}

function openWorkspaceMenu(path, anchor) {
  const menu = $("workspace-menu");
  menu.dataset.workspace = path;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.right - 178)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.show();
}

function openSessionMenu(path, anchor) {
  const menu = $("session-menu");
  if (!menu || !path) return;
  menu.dataset.session = path;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.right - 178)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.show();
}

function openWorkspaceRename(path) {
  const workspace = state.snapshot.workspaces.find((item) => item.path === path);
  const dialog = $("workspace-rename-dialog");
  $("workspace-name-input").value = workspace?.name || workspaceName(path);
  dialog.dataset.workspace = path;
  $("workspace-menu").close();
  dialog.showModal();
  $("workspace-name-input").focus();
  $("workspace-name-input").select();
}

async function removeWorkspace(path) {
  $("workspace-menu").close();
  try {
    await api(`/api/workspaces?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    if (state.selectedWorkspace === path) setWorkspaceReady(null);
    state.selectedPath = null;
    await refreshSnapshot();
  } catch (error) {
    showNotice(error.message);
  }
}

function requestRemoveWorkspace(path) {
  const workspace = state.snapshot?.workspaces.find((item) => item.path === path);
  if (!workspace) return;
  $("workspace-menu").close();
  const dialog = $("workspace-delete-dialog");
  const message = $("workspace-delete-message");
  if (!dialog || !message) return;
  dialog.dataset.workspace = path;
  message.textContent = `${workspace.name}：${t("workspaceDeleteConfirm")}`;
  dialog.showModal();
}

function openSessionRename(path) {
  const session = state.snapshot?.sessions.find((item) => item.path === path);
  const dialog = $("session-rename-dialog");
  if (!dialog) return;
  $("session-name-input").value = sessionTitle(session || {});
  dialog.dataset.session = path;
  $("session-menu")?.close();
  dialog.showModal();
  $("session-name-input").focus();
  $("session-name-input").select();
}

async function archiveSession(path) {
  if (!path) return;
  $("session-menu")?.close();
  try {
    await api(`/api/sessions/archive?path=${encodeURIComponent(path)}`, { method: "POST" });
    state.archivedSessions.add(path);
    persistArchivedSessions();
    await refreshSnapshot();
  } catch (error) {
    showNotice(error.message);
  }
}

async function chooseWorkspace() {
  try {
    const result = await api("/api/workspaces/select", { method: "POST" });
    if (result.cancelled || !result.path) return;
    setWorkspaceReady(result.path);
    await refreshSnapshot();
  } catch (error) {
    const selectedWorkspace = $("selected-workspace");
    if (selectedWorkspace) selectedWorkspace.textContent = error.message;
  }
}

async function connectEvents() {
  try {
    const response = await fetch("/events", { headers: headers() });
    if (!response.ok || !response.body) throw new Error("event connection failed");
    $("connection-state").textContent = "Connected";
    $("connection-state").classList.remove("reconnecting");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split("\n\n");
      buffer = records.pop() || "";
      for (const record of records) {
        const line = record.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "session_start" || event.type === "session_switched") {
            state.liveMessages = [];
            state.liveRunning = false;
            state.livePhase = "idle";
            state.liveRetry = null;
            scheduleSnapshotRefresh();
          } else if (event.type === "prompt_accepted") {
            state.liveRunning = true;
            state.livePhase = "preparing";
            state.liveRetry = null;
            renderConversation();
          } else if (event.type === "agent_start") {
            state.liveRunning = true;
            state.livePhase = "running";
            state.liveRetry = null;
            renderConversation();
          } else if (event.type === "agent_settled") {
            state.liveRunning = false;
            state.livePhase = "idle";
            state.liveRetry = null;
            renderConversation();
          } else if (event.detail?.message) {
            if (event.detail.message.role === "user") {
              state.liveMessages = state.liveMessages.filter(
                (entry) =>
                  !entry.key.startsWith("optimistic-") ||
                  entry.message.content !== event.detail.message.content,
              );
            }
            const key = event.detail.messageKey || `${event.detail.message.role || "message"}-${event.sequence}`;
            const index = state.liveMessages.findIndex((entry) => entry.key === key);
            const live = { key, message: event.detail.message };
            if (index >= 0) state.liveMessages[index] = live;
            else state.liveMessages = [...state.liveMessages, live].slice(-8);
            renderConversation();
          }
          if (
            [
              "agent_start",
              "agent_settled",
              "message_end",
              "tool_execution_end",
              "session_start",
              "session_switched",
              "session_progress",
              "prompt_failed",
              "model_select",
              "workspace_imported",
              "workspace_removed",
              "workspace_renamed",
              "session_created",
              "prompt_accepted",
            ].includes(event.type)
          ) {
            scheduleSnapshotRefresh();
          }
          if (event.type === "prompt_failed") {
            state.liveRunning = false;
            state.livePhase = "idle";
            state.liveRetry = null;
            state.liveMessages = state.liveMessages.filter(
              (entry) => !entry.key.startsWith("optimistic-"),
            );
            showNotice(event.detail?.error || "Prompt failed");
            renderConversation();
          }
          if (event.type === "auto_retry_start") {
            state.liveRunning = true;
            state.livePhase = "running";
            state.liveRetry = {
              attempt: event.detail?.attempt || 0,
              maxAttempts: event.detail?.maxAttempts || 0,
            };
            renderConversation();
          }
        } catch {}
      }
    }
  } catch {
    $("connection-state").textContent = "Reconnecting";
    $("connection-state").classList.add("reconnecting");
    setTimeout(connectEvents, 1500);
  }
}

const collapseButton = $("collapse-sidebar");
const collapsedStorageKey = "openpi.sidebar-collapsed";
const setSidebarCollapsed = (collapsed) => {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  collapseButton?.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  collapseButton?.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
  try { localStorage.setItem(collapsedStorageKey, String(collapsed)); } catch {}
};
try { setSidebarCollapsed(localStorage.getItem(collapsedStorageKey) === "true"); } catch {}
collapseButton?.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.body.classList.remove("sidebar-open");
    return;
  }
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
});

$("search-toggle")?.addEventListener("click", () => {
  const search = $("search");
  const heading = search?.closest(".workspace-heading");
  if (!search || !heading) return;
  if (heading.classList.contains("is-searching")) {
    closeSearch();
    return;
  }
  heading.classList.add("is-searching");
  search.focus();
});
$("search")?.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderWorkspaces();
});
$("search")?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeSearch();
});
$("search-clear")?.addEventListener("click", () => {
  closeSearch();
});
$("workspace-menu")?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const path = $("workspace-menu").dataset.workspace;
  if (!action || !path) return;
  if (action === "rename") openWorkspaceRename(path);
  else requestRemoveWorkspace(path);
});
$("session-menu")?.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const path = $("session-menu").dataset.session;
  if (!action || !path) return;
  if (action === "rename") openSessionRename(path);
  else if (action === "archive") void archiveSession(path);
});
$("workspace-rename-form")?.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const dialog = $("workspace-rename-dialog");
  const path = dialog.dataset.workspace;
  const name = $("workspace-name-input").value.trim();
  if (!path || !name) return;
  try {
    await api("/api/workspaces", {
      method: "PATCH",
      body: JSON.stringify({ path, name }),
    });
    dialog.close();
    await refreshSnapshot();
  } catch (error) {
    showNotice(error.message);
  }
});
$("workspace-delete-form")?.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "delete") return;
  const dialog = $("workspace-delete-dialog");
  const path = dialog?.dataset.workspace;
  if (path) await removeWorkspace(path);
});
$("session-rename-form")?.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const dialog = $("session-rename-dialog");
  const path = dialog.dataset.session;
  const name = $("session-name-input").value.trim();
  if (!path || !name) return;
  try {
    await api("/api/sessions", {
      method: "PATCH",
      body: JSON.stringify({ path, name }),
    });
    dialog.close();
    await refreshSnapshot();
  } catch (error) {
    showNotice(error.message);
  }
});
document.addEventListener("pointerdown", (event) => {
  const menu = $("workspace-menu");
  if (menu?.open && !menu.contains(event.target) && !event.target.closest('[data-workspace-action="more"]')) menu.close();
  const sessionMenu = $("session-menu");
  if (sessionMenu?.open && !sessionMenu.contains(event.target) && !event.target.closest('[data-session-action="menu"]')) sessionMenu.close();
  const heading = document.querySelector(".workspace-heading");
  if (heading?.classList.contains("is-searching") && !heading.contains(event.target)) {
    closeSearch({ restoreFocus: false });
  }
  const picker = document.querySelector(".workspace-picker-row");
  if (picker && !picker.contains(event.target)) {
    $("workspace-picker-menu").hidden = true;
    $("select-workspace")?.setAttribute("aria-expanded", "false");
  }
  const modelPicker = document.querySelector(".model-picker-wrap");
  if (modelPicker && !modelPicker.contains(event.target)) {
    $("model-menu").hidden = true;
    $("model-picker")?.setAttribute("aria-expanded", "false");
  }
});
document.querySelector(".new-session-button")?.addEventListener("click", async () => {
  if (!state.selectedWorkspace) await chooseWorkspace();
  if (state.selectedWorkspace) await createSession(state.selectedWorkspace);
});
$("import-workspace")?.addEventListener("click", chooseWorkspace);
$("select-workspace")?.addEventListener("click", () => {
  const menu = $("workspace-picker-menu");
  const picker = $("select-workspace");
  if (!menu || !picker) return;
  if ((state.snapshot?.workspaces || []).length === 0) {
    void chooseWorkspace();
    return;
  }
  menu.hidden = !menu.hidden;
  picker.setAttribute("aria-expanded", String(!menu.hidden));
  if (!menu.hidden) renderWorkspacePicker();
});
$("model-picker")?.addEventListener("click", () => {
  const picker = $("model-picker");
  const menu = $("model-menu");
  if (!picker || !menu || picker.disabled) return;
  menu.hidden = !menu.hidden;
  picker.setAttribute("aria-expanded", String(!menu.hidden));
});
$("mobile-sidebar")?.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
document.querySelector(".sidebar-scrim")?.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
$("composer")?.addEventListener("pointerdown", (event) => {
  if (state.selectedWorkspace) return;
  event.preventDefault();
  void chooseWorkspace();
}, true);
$("composer")?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.selectedWorkspace) void sendPrompt();
  else void chooseWorkspace();
});
$("prompt-input")?.addEventListener("input", resizePrompt);
$("prompt-input")?.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (state.selectedWorkspace) void sendPrompt();
    else void chooseWorkspace();
  }
});

$("open-settings")?.addEventListener("click", () => $("settings-dialog")?.showModal());
$("close-settings")?.addEventListener("click", () => $("settings-dialog")?.close());
$("settings-dialog")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("language-picker-trigger")?.addEventListener("click", () => {
  const menu = $("language-menu");
  const trigger = $("language-picker-trigger");
  if (!menu || !trigger) return;
  menu.hidden = !menu.hidden;
  trigger.setAttribute("aria-expanded", String(!menu.hidden));
});
document.querySelectorAll("#language-menu [data-language]").forEach((option) => {
  option.addEventListener("click", () => {
    state.language = option.dataset.language === "zh" ? "zh" : "en";
    try { localStorage.setItem("openpi.language", state.language); } catch {}
    applyLanguage();
    renderConversation();
    $("language-menu").hidden = true;
    $("language-picker-trigger")?.setAttribute("aria-expanded", "false");
  });
});
document.addEventListener("pointerdown", (event) => {
  const picker = document.querySelector(".language-picker");
  if (picker && !picker.contains(event.target)) {
    $("language-menu").hidden = true;
    $("language-picker-trigger")?.setAttribute("aria-expanded", "false");
  }
});

applyLanguage();
refreshSnapshot();
connectEvents();
