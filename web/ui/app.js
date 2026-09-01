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
  lastEventSequence: 0,
  resyncRequired: false,
  thinkingStarts: {},
  thinkingDurations: {},
  query: "",
  selectedWorkspace: null,
  language: (() => {
    try { return localStorage.getItem("openpi.language") === "zh" ? "zh" : "en"; } catch { return "en"; }
  })(),
  theme: (() => {
    try {
      const saved = localStorage.getItem("openpi.web.theme");
      return ["pi", "white", "dark"].includes(saved) ? saved : "pi";
    } catch { return "pi"; }
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
    copyMessage: "Copy message",
    copiedMessage: "Copied",
    conversationTurns: "Conversation turns",
    stepsLabel: "steps",
    thinkingActive: "Thinking...",
    thinkingDone: "Thinking",
    noOutput: "no output",
    editMessage: "Resend as new message",
    confirmEdit: "Send",
    theme: "Theme",
    themePi: "PI Grid",
    themeWhite: "Clean White",
    themeDark: "Midnight",
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
    copyMessage: "复制消息",
    copiedMessage: "已复制",
    conversationTurns: "会话轮次",
    stepsLabel: "个步骤",
    thinkingActive: "思考中...",
    thinkingDone: "思考过程",
    noOutput: "无输出",
    editMessage: "作为新消息发送",
    confirmEdit: "发送",
    theme: "主题",
    themePi: "PI 网格",
    themeWhite: "简洁白",
    themeDark: "暗夜黑",
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

const THEME_KEYS = { pi: "themePi", white: "themeWhite", dark: "themeDark" };

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const value = $("theme-picker-value");
  if (value) value.textContent = t(THEME_KEYS[state.theme] || "themePi");
  document.querySelectorAll("#theme-menu [data-theme-value]").forEach((option) => {
    option.setAttribute("aria-selected", option.dataset.themeValue === state.theme ? "true" : "false");
  });
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
  // CommonMark flanking rules break **bold** next to CJK punctuation (（）等),
  // so handle double-star emphasis ourselves before the built-in tokenizer.
  const cjkStrong = {
    name: "cjkStrong",
    level: "inline",
    start(src) {
      const index = src.indexOf("**");
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^\*\*([^*\n]+)\*\*/.exec(src);
      if (!match) return undefined;
      return { type: "cjkStrong", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) {
      return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;
    },
  };
  markdown.use({ extensions: [cjkStrong] });
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

function formatTurnTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatElapsedMs(start, end) {
  if (typeof start !== "number") return "";
  const totalSeconds = Math.max(0, Math.round(((typeof end === "number" ? end : Date.now()) - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

const ACTIVITY_ICONS = {
  subagent: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8" width="14" height="10" rx="3"></rect><path d="M12 8V5"></path><circle cx="12" cy="4" r="1"></circle><circle cx="10" cy="13" r="1"></circle><circle cx="14" cy="13" r="1"></circle></svg>`,
  workflow: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><path d="M10 6.5h5.5a2 2 0 0 1 2 2V14"></path><path d="M14 17.5H8.5a2 2 0 0 1-2-2V10"></path></svg>`,
};
const ACTIVITY_STATUS_GLYPHS = { done: "✓", error: "✗", warn: "?" };

const TOOL_ICONS = {
  bash: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 8 4 4-4 4"></path><path d="M12 16h6"></path></svg>`,
  read: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path></svg>`,
  write: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
  edit: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
  grep: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`,
  glob: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`,
  ls: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"></path></svg>`,
  webfetch: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"></path></svg>`,
  websearch: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"></path></svg>`,
  thinking: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M12 3a6 6 0 0 0-4.2 10.3c.9.8 1.2 1.6 1.2 2.7h6c0-1.1.3-1.9 1.2-2.7A6 6 0 0 0 12 3z"></path></svg>`,
  default: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2z"></path></svg>`,
};

function toolIcon(name) {
  return TOOL_ICONS[name] || TOOL_ICONS.default;
}

/** Pull the one argument that identifies what the tool call actually did. */
function toolCallSummary(name, args) {
  if (!args) return "";
  const value =
    name === "bash" ? args.command :
    name === "read" || name === "write" || name === "edit" || name === "ls" ? args.path :
    name === "grep" || name === "glob" ? args.pattern :
    name === "webfetch" ? args.url :
    name === "websearch" ? args.query :
    "";
  if (typeof value !== "string" || !value) return "";
  const line = value.split("\n").find((part) => part.trim()) || "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/** Thinking row: "思考中..." with a live timer while active, "思考过程 · 1m03s" once settled. */
function thinkingLineMarkup(body, thinking) {
  const active = Boolean(thinking?.active);
  const label = active ? t("thinkingActive") : t("thinkingDone");
  let meta = "";
  if (active) {
    meta = `<span class="thinking-timer" data-thinking-start="${thinking.startedAt}">${formatElapsedMs(thinking.startedAt)}</span>`;
  } else if (thinking?.elapsedMs) {
    meta = `· ${formatElapsedMs(0, thinking.elapsedMs)}`;
  }
  return `<details class="message-details tool-line thinking-line${active ? " active" : ""}">
    <summary>
      <span class="details-mark" aria-hidden="true"></span>
      <span class="tool-icon" aria-hidden="true">${TOOL_ICONS.thinking}</span>
      <span class="details-title"><span class="tool-name">${escapeHtml(label)}</span>${meta ? `<span class="tool-summary thinking-meta">${meta}</span>` : ""}</span>
    </summary>
    <div class="details-body tool-evidence">${escapeHtml(body || "")}</div>
  </details>`;
}

let thinkingTimerInterval = null;

function syncThinkingTimer(hasActive) {
  if (hasActive && thinkingTimerInterval === null) {
    thinkingTimerInterval = window.setInterval(() => {
      document.querySelectorAll("[data-thinking-start]").forEach((element) => {
        element.textContent = formatElapsedMs(Number(element.dataset.thinkingStart));
      });
    }, 1000);
  } else if (!hasActive && thinkingTimerInterval !== null) {
    window.clearInterval(thinkingTimerInterval);
    thinkingTimerInterval = null;
  }
}

/** Compact collapsible row for ordinary tool calls/results, with an icon. */
function toolLineMarkup(name, summary, body, isError, extraClass) {
  return `<details class="message-details tool-line${isError ? " error" : ""}${extraClass ? ` ${extraClass}` : ""}">
    <summary>
      <span class="details-mark" aria-hidden="true"></span>
      <span class="tool-icon" aria-hidden="true">${toolIcon(name)}</span>
      <span class="details-title"><span class="tool-name">${escapeHtml(name)}</span>${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}</span>
    </summary>
    <div class="details-body tool-evidence">${escapeHtml(body || "")}</div>
  </details>`;
}

function activityCardMarkup(family, title, meta, body, status) {
  const glyph = ACTIVITY_STATUS_GLYPHS[status];
  const indicator =
    status === "running"
      ? `<span class="activity-status running" aria-label="running"><i class="activity-chip-dot" aria-hidden="true"></i></span>`
      : glyph
        ? `<span class="activity-status ${status}" aria-hidden="true">${glyph}</span>`
        : "";
  return `<details class="message-details activity-card ${family}">
    <summary>
      <span class="activity-icon" aria-hidden="true">${ACTIVITY_ICONS[family]}</span>
      <span class="activity-main"><span class="activity-title">${escapeHtml(title)}</span>${meta ? `<span class="activity-meta">${escapeHtml(meta)}</span>` : ""}</span>
      ${indicator}
      <span class="details-mark" aria-hidden="true"></span>
    </summary>
    <div class="details-body tool-evidence">${escapeHtml(body || "")}</div>
  </details>`;
}

function parseToolArguments(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Card status: merged tool result wins; a family call without one is running. */
function canonicalActivityStatus(value) {
  if (value === "running") return "running";
  if (value === "done" || value === "completed") return "done";
  if (value === "error" || value === "failed" || value === "aborted" || value === "killed" || value === "timed_out") return "error";
  if (value === "uncertain") return "warn";
  return "unknown";
}

function cardStatus(result) {
  if (!result) return "running";
  if (result.isError === true) return "error";
  const details = result.details && typeof result.details === "object" ? result.details : null;
  const status = canonicalActivityStatus(details?.status);
  if (status !== "unknown") return status;
  if (result.isError === false) return "done";
  return "unknown";
}

/** Rich cards for the two headline capabilities instead of a generic tool row. */
function familyToolCallCard(part, result) {
  const name = part.name || "";
  const args = parseToolArguments(part.arguments) || {};
  const details = result?.details && typeof result.details === "object" ? result.details : undefined;
  const status = cardStatus(result);
  if (name === "subagent_spawn") {
    const meta = [args.agent_type, args.model, args.working_dir].filter(Boolean).join(" · ");
    const title = `Spawn Subagent · ${details?.title || args.name || "subagent"}`;
    return activityCardMarkup("subagent", title, meta || details?.cwd, result?.content || args.prompt || part.arguments, status);
  }
  if (name === "subagent_wait") {
    const results = Array.isArray(details?.results) ? details.results : [];
    const failed = results.filter((item) => item && item.status !== "done").length;
    const meta = results.length > 0 ? `${results.length} settled${failed ? ` · ${failed} failed` : ""}` : (args.ids || []).join(" · ") || undefined;
    return activityCardMarkup("subagent", "Wait for Subagents", meta, result?.content || part.arguments, status);
  }
  if (name === "subagent_cancel") return activityCardMarkup("subagent", "Cancel Subagents", (args.ids || []).join(" · ") || undefined, result?.content || part.arguments, status);
  if (name === "subagent_send") return activityCardMarkup("subagent", `Send to Subagent · ${args.id || ""}`.trim(), undefined, result?.content || args.text || part.arguments, status);
  if (name === "subagent_check") return activityCardMarkup("subagent", `Check Subagent · ${args.id || ""}`.trim(), undefined, result?.content || part.arguments, status);
  if (name === "subagent_list") return activityCardMarkup("subagent", "List Subagents", undefined, result?.content || part.arguments, status);
  if (name === "workflow") {
    const script = typeof args.script === "string" ? args.script : "";
    const workflowName = details?.name || script.match(/\bname:\s*["'`]([^"'`]+)["'`]/)?.[1];
    const description = script.match(/\bdescription:\s*["'`]([^"'`]+)["'`]/)?.[1];
    const agents = Array.isArray(details?.agents) ? details.agents : [];
    const settled = agents.filter((agent) => agent && agent.state !== "running").length;
    const meta = details
      ? [details.runId, details.status, agents.length > 0 ? `${settled}/${agents.length} agents` : ""].filter(Boolean).join(" · ")
      : description;
    return activityCardMarkup("workflow", `Workflow · ${workflowName || "unnamed"}`, meta, result?.content || script || part.arguments, status);
  }
  if (name === "workflow_stop") return activityCardMarkup("workflow", `Stop Workflow · ${args.runId || ""}`.trim(), undefined, result?.content || part.arguments, status);
  if (name === "workflow_status") return activityCardMarkup("workflow", "Workflow Status", args.runId, result?.content || part.arguments, status);
  return "";
}

function familyToolResultCard(message) {
  const toolName = message.toolName || "";
  const family = toolName.startsWith("subagent") ? "subagent" : toolName.startsWith("workflow") ? "workflow" : "";
  if (!family) return "";
  const content = message.content || "";
  const status = canonicalActivityStatus(message.details?.status);
  const resolvedStatus = status === "unknown"
    ? (message.isError === true ? "error" : message.isError === false ? "done" : "unknown")
    : status;
  const title = `${toolName.replace(/_/g, " ")}${content ? ` · ${compactSummary(content)}` : ""}`;
  return activityCardMarkup(family, title, undefined, content, resolvedStatus);
}

/** Background delivery messages (subagent-result / workflow-result). */
function customMessageMarkup(message) {
  const details = message.details && typeof message.details === "object" ? message.details : {};
  if (message.customType === "subagent-result") {
    const status = canonicalActivityStatus(details.status);
    const meta = [details.id, details.outcome, details.elapsed].filter(Boolean).join(" · ");
    const card = activityCardMarkup("subagent", `Subagent ${details.id || ""} · ${details.title || "result"}`, meta || undefined, message.content, status);
    return `<article class="message-row assistant detail-only">
      <div class="message-content">${card}</div>
    </article>`;
  }
  if (message.customType === "workflow-result") {
    const entries = Array.isArray(details.entries) ? details.entries : [];
    const entryStatuses = entries.map((item) => canonicalActivityStatus(item?.status));
    const status = entryStatuses.some((item) => item === "error")
      ? "error"
      : entryStatuses.some((item) => item === "warn")
        ? "warn"
        : entryStatuses.length > 0 && entryStatuses.every((item) => item === "done")
          ? "done"
          : entryStatuses.some((item) => item === "running")
            ? "running"
            : "unknown";
    const title = entries.length > 1
      ? `Workflow results · ${entries.length} runs`
      : `Workflow ${entries[0]?.runId || "result"} · ${entries[0]?.status || "delivered"}`;
    const body = entries.length > 0
      ? entries
          .map((item) => {
            const glyph = item.status === "completed" ? "✓" : "✗";
            const alerts = Array.isArray(item.alerts) && item.alerts.length > 0 ? ` (${item.alerts.join("; ")})` : "";
            const preview = item.resultPreview ? `\nResult: ${item.resultPreview}` : "";
            return `${glyph} ${item.summary || item.runId || "run"}${alerts}${preview}`;
          })
          .join("\n")
      : message.content;
    const card = activityCardMarkup("workflow", title, undefined, body, status);
    return `<article class="message-row assistant detail-only">
      <div class="message-content">${card}</div>
    </article>`;
  }
  return "";
}

function turnTitle(content) {
  const line = String(content || "").split("\n").map((part) => part.trim()).find(Boolean) || "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Empty tool outputs like "", "[]", "{}" carry no information. */
function isEmptyToolOutput(content) {
  const text = String(content ?? "").trim();
  return text === "" || text === "[]" || text === "{}" || text === "null";
}

function messageActionsMarkup(entry, canEdit = false) {
  const time = formatTurnTime(entry.timestamp);
  const editButton = canEdit
    ? `<button class="message-edit" type="button" aria-label="${escapeHtml(t("editMessage"))}" title="${escapeHtml(t("editMessage"))}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>`
    : "";
  return `<div class="message-actions">${time ? `<time datetime="${escapeHtml(String(entry.timestamp))}">${time}</time>` : ""}${editButton}<button class="message-copy" type="button" aria-label="${escapeHtml(t("copyMessage"))}" title="${escapeHtml(t("copyMessage"))}"><svg class="icon icon-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 14V6a2 2 0 0 1 2-2h8"></path></svg><svg class="icon icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"></path></svg></button></div>`;
}

let messageEditActive = false;

function enterMessageEdit(row) {
  const body = row.querySelector(".message-body");
  const content = row.querySelector(".message-content");
  if (!body || !content || row.classList.contains("editing")) return;
  const original = body.textContent || "";
  row.classList.add("editing");
  messageEditActive = true;
  content.innerHTML = `<textarea class="message-edit-input" rows="1">${escapeHtml(original)}</textarea>
    <div class="message-edit-actions">
      <button type="button" class="message-edit-cancel">${escapeHtml(t("cancel"))}</button>
      <button type="button" class="message-edit-confirm">${escapeHtml(t("confirmEdit"))}</button>
    </div>`;
  const textarea = content.querySelector(".message-edit-input");
  if (!textarea) return;
  const grow = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  };
  grow();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.addEventListener("input", grow);
  textarea.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      messageEditActive = false;
      renderConversation();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void confirmMessageEdit(textarea.value);
    }
  });
}

/** Confirming an edit resends the text as a new prompt (queued if running). */
async function confirmMessageEdit(value) {
  messageEditActive = false;
  const content = value.trim();
  if (!content) {
    renderConversation();
    return;
  }
  await sendPrompt(content);
}

/** Render one entry to a list of row objects: { kind: "user"|"assistant"|"detail", icon?, error?, activeThinking?, html }. */
function messageMarkup(entry, turn, resultsByCallId, familyCallIds, context, showActions = true) {
  const message = entry.message;
  if (!message) return [];
  if (message.role === "custom") {
    const html = customMessageMarkup(message);
    if (!html) return [];
    const icon = message.customType === "workflow-result" ? ACTIVITY_ICONS.workflow : ACTIVITY_ICONS.subagent;
    return [{ kind: "detail", icon, html }];
  }
  if (message.role === "user") {
    return [{ kind: "user", html: `<article class="message-row user"${turn ? ` data-turn="${turn}"` : ""}>
      <div class="message-content"><div class="message-body">${escapeHtml(message.content)}</div></div>
      ${messageActionsMarkup(entry, Boolean(context?.showEdit))}
    </article>` }];
  }
  if (message.role === "assistant") {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const rows = [];
    for (const part of parts) {
      if (part.type !== "thinking" && part.type !== "toolCall") continue;
      let detail;
      let icon;
      let groupable = false;
      if (part.type === "toolCall") {
        const card = familyToolCallCard(part, part.id ? resultsByCallId?.get(part.id) : undefined);
        if (card) {
          detail = card;
          icon = /^workflow/.test(part.name || "") ? ACTIVITY_ICONS.workflow : ACTIVITY_ICONS.subagent;
        } else {
          const args = parseToolArguments(part.arguments);
          const body = part.name === "bash" && typeof args?.command === "string" ? args.command : part.arguments;
          detail = toolLineMarkup(part.name || "tool", toolCallSummary(part.name, args), body, false);
          icon = toolIcon(part.name || "tool");
          groupable = true;
        }
      } else {
        detail = thinkingLineMarkup(part.text, context?.thinking);
        icon = TOOL_ICONS.thinking;
      }
      rows.push({ kind: "detail", icon, groupable, activeThinking: part.type === "thinking" && Boolean(context?.thinking?.active), html: `<article class="message-row assistant detail-only">
      <div class="message-content">${detail}</div>
    </article>` });
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (content) {
      rows.push({ kind: "assistant", html: `<article class="message-row assistant">
      <div class="message-content"><div class="message-body markdown">${renderMarkdown(content)}</div></div>
      ${showActions ? messageActionsMarkup(entry) : ""}
    </article>` });
    }
    return rows;
  }
  if (message.role === "toolResult") {
    // Family results merged into their call card do not get a separate row.
    if (message.toolCallId && familyCallIds?.has(message.toolCallId)) return [];
    const family = (message.toolName || "").startsWith("subagent") ? "subagent" : (message.toolName || "").startsWith("workflow") ? "workflow" : "";
    const card = family ? familyToolResultCard(message) : "";
    const toolName = message.toolName || "tool";
    const icon = family ? ACTIVITY_ICONS[family] : toolIcon(toolName);
    if (!card && isEmptyToolOutput(message.content)) {
      return [{ kind: "detail", icon, groupable: true, html: `<article class="message-row assistant detail-only">
      <div class="message-content"><div class="tool-line-empty"><span class="tool-icon" aria-hidden="true">${icon}</span><span class="tool-name">${escapeHtml(toolName)}</span><span class="tool-summary">${escapeHtml(t("noOutput"))}</span></div></div>
    </article>` }];
    }
    const detail = card || toolLineMarkup(toolName, compactSummary(message.content || "completed"), message.content || "completed", message.isError);
    return [{ kind: "detail", icon, groupable: !family, error: Boolean(message.isError), html: `<article class="message-row assistant detail-only">
      <div class="message-content">${detail}</div>
    </article>` }];
  }
  return [];
}

/** Collapse runs of 4+ consecutive ordinary tool rows into one expandable
    group. Thinking, subagent, and workflow rows always stay visible. */
function groupRows(rows) {
  const blocks = [];
  for (const row of rows) {
    const groupable = row.kind === "detail" && row.groupable;
    const last = blocks[blocks.length - 1];
    if (groupable && last?.kind === "group") last.rows.push(row);
    else if (groupable) blocks.push({ kind: "group", rows: [row] });
    else blocks.push({ kind: "row", rows: [row] });
  }
  return blocks
    .map((block) => {
      if (block.kind !== "group" || block.rows.length < 4) {
        return block.rows.map((row) => row.html).join("");
      }
      const icons = [...new Set(block.rows.map((row) => row.icon))].filter(Boolean).slice(0, 4).join("");
      const hasError = block.rows.some((row) => row.error);
      return `<details class="tool-group${hasError ? " error" : ""}">
      <summary><span class="details-mark" aria-hidden="true"></span><span class="tool-group-icons" aria-hidden="true">${icons}</span><span class="tool-group-title">${block.rows.length} ${escapeHtml(t("stepsLabel"))}</span></summary>
      <div class="tool-group-body">${block.rows.map((row) => row.html).join("")}</div>
    </details>`;
    })
    .join("");
}

function landingMarkup() {
  return `<div class="landing-welcome">
    <div class="landing-brand"><strong><span class="brand-word">Open</span><span class="pixel-mark" aria-label="OpenPI"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></strong></div>
  </div>`;
}

const ACTIVITY_CHIP_LIMIT = 5;

function activityChipMarkup(kind, status, text) {
  const glyph = ACTIVITY_STATUS_GLYPHS[status === "completed" || status === "done" ? "done" : status];
  const indicator =
    status === "running"
      ? `<i class="activity-chip-dot" aria-hidden="true"></i>`
      : glyph
        ? `<i class="activity-chip-glyph" aria-hidden="true">${glyph}</i>`
        : "";
  return `<span class="activity-chip ${kind} ${status}">${indicator}<span class="activity-chip-text">${escapeHtml(text)}</span></span>`;
}

function activityBarMarkup() {
  const capabilities = state.snapshot?.runtime?.capabilities || {};
  const subagents = Array.isArray(capabilities.subagents) ? capabilities.subagents : [];
  const workflows = Array.isArray(capabilities.workflows) ? capabilities.workflows : [];
  const chips = [];
  for (const run of workflows) {
    const agents = Array.isArray(run.agents) ? run.agents : [];
    const settled = agents.filter((agent) => agent.state !== "running").length;
    const progress = agents.length > 0 ? ` · ${settled}/${agents.length} agents` : "";
    const phase = run.status === "running" && run.currentPhase ? ` · ${run.currentPhase}` : "";
    const elapsed = run.status === "running" ? formatElapsedMs(run.startedAt) : formatElapsedMs(run.startedAt, run.finishedAt);
    const status = canonicalActivityStatus(run.status);
    const label = `${run.name || run.runId || "workflow"}${run.status === "running" ? phase + progress : progress}${elapsed ? ` · ${elapsed}` : ""}`;
    chips.push({ status, markup: activityChipMarkup("workflow", status, label) });
  }
  for (const snap of subagents) {
    const elapsed = formatElapsedMs(snap.createdAt, snap.settledAt);
    const status = canonicalActivityStatus(snap.status);
    chips.push({ status, markup: activityChipMarkup("subagent", status, `${snap.title || snap.id}${elapsed ? ` · ${elapsed}` : ""}`) });
  }
  chips.sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1));
  const visible = chips.slice(0, ACTIVITY_CHIP_LIMIT).map((chip) => chip.markup);
  const overflow = chips.length - visible.length;
  if (overflow > 0) visible.push(`<span class="activity-chip more">+${overflow}</span>`);
  return visible.join("");
}

function renderActivityBar() {
  const bar = $("activity-bar");
  if (!bar) return;
  const markup = activityBarMarkup();
  bar.hidden = !markup;
  bar.innerHTML = markup;
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
  const isCurrentSession = Boolean(selected && snapshot && selected.id === snapshot.currentSessionId);
  const persistedEntries = selected?.entries || [];
  const persistedMessageKeys = new Set(
    persistedEntries.map((entry) => `${entry.message?.role || ""}:${entry.message?.content || ""}`),
  );
  const liveEntries = selected
    ? state.liveMessages
        .filter(({ message }) => !persistedMessageKeys.has(`${message.role || ""}:${message.content || ""}`))
        .map(({ key, message }) => ({ type: "message", key, message }))
    : [];
  const allEntries = selected ? [...persistedEntries, ...liveEntries] : [];
  const resultsByCallId = new Map();
  const familyCallIds = new Set();
  for (const entry of allEntries) {
    const message = entry.message;
    if (!message) continue;
    if (message.role === "toolResult" && message.toolCallId) {
      resultsByCallId.set(message.toolCallId, message);
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (part.type === "toolCall" && part.id && /^(subagent|workflow)/.test(part.name || "")) {
          familyCallIds.add(part.id);
        }
      }
    }
  }
  const turns = [];
  let turnCounter = 0;
  let prevEntryTime = 0;
  const lastEntryIndex = allEntries.length - 1;
  // Only the final assistant answer gets the copy/time action bar.
  let lastAssistantIndex = -1;
  let lastUserIndex = -1;
  allEntries.forEach((entry, index) => {
    const message = entry.message;
    if (message?.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      lastAssistantIndex = index;
    }
    if (message?.role === "user") lastUserIndex = index;
  });
  const rows = allEntries.flatMap((entry, index) => {
    let turn = 0;
    if (entry.message?.role === "user") {
      turn = ++turnCounter;
      turns.push({ turn, title: turnTitle(entry.message.content) });
    }
    // Thinking duration: live entries time it precisely; persisted entries
    // fall back to the gap since the previous entry's timestamp.
    const context = {};
    if (isCurrentSession && index === lastUserIndex) context.showEdit = true;
    const hasThinking = Array.isArray(entry.message?.parts) && entry.message.parts.some((part) => part.type === "thinking");
    if (hasThinking) {
      const startMs = entry.key ? state.thinkingStarts[entry.key] : undefined;
      const storedMs = entry.key ? state.thinkingDurations[entry.key] : undefined;
      if (startMs && state.liveRunning && index === lastEntryIndex) {
        context.thinking = { active: true, startedAt: startMs };
      } else if (storedMs) {
        context.thinking = { elapsedMs: storedMs };
      } else {
        const endMs = new Date(entry.timestamp).getTime();
        const gap = endMs - prevEntryTime;
        if (endMs && gap > 999 && gap < 30 * 60 * 1000) context.thinking = { elapsedMs: gap };
      }
    }
    const entryTime = new Date(entry.timestamp).getTime();
    if (entryTime) prevEntryTime = entryTime;
    return messageMarkup(entry, turn, resultsByCallId, familyCallIds, context, index === lastAssistantIndex || entry.message?.role === "user");
  });
  const messages = groupRows(rows);
  syncThinkingTimer(rows.some((row) => row.activeThinking));
  const landing = !selected || !summary || !messages;
  shell.classList.toggle("landing", landing);
  renderActivityBar();

  if (landing) {
    $("conversation").innerHTML = landingMarkup();
    const landingRail = $("turn-rail");
    if (landingRail) {
      landingRail.hidden = true;
      landingRail.innerHTML = "";
    }
    $("session-header").innerHTML = `<strong>${escapeHtml(t("newSession"))}</strong><small>${escapeHtml(t("chooseWorkspaceHint"))}</small>`;
    updateComposer();
    return;
  }

  $("session-header").innerHTML = `<strong>${escapeHtml(sessionTitle(summary))}</strong><small>${escapeHtml(selected.cwd)}</small>`;
  const isRunning = isCurrentSession && (snapshot.runtime.status === "running" || state.liveRunning);
  const runningLabel = state.liveRetry
    ? `${t("modelRetrying")} (${state.liveRetry.attempt}/${state.liveRetry.maxAttempts})`
    : state.livePhase === "preparing" ? t("modelPreparing") : t("modelRunning");
  const conversation = $("conversation");
  // While a sent message is being edited inline, keep the editor intact:
  // streaming updates resume on the next render after confirm/cancel.
  if (messageEditActive) {
    updateComposer();
    return;
  }
  // Stick-to-bottom: only follow the stream when the user is already near the
  // bottom; anyone scrolling up to read keeps their position. Session switches
  // and first loads always land at the bottom.
  const sessionPath = selected?.path || null;
  const forceBottom = sessionPath !== lastRenderedSessionPath || scrollToBottomOnNextRender;
  scrollToBottomOnNextRender = false;
  const pinnedToBottom =
    conversation.scrollTop + conversation.clientHeight >= conversation.scrollHeight - 48;
  conversation.innerHTML = `${messages}${isRunning ? `<div class="conversation-running" role="status" aria-live="polite"><span class="conversation-running-dot" aria-hidden="true"></span><span>${escapeHtml(runningLabel)}</span></div>` : ""}`;
  const rail = $("turn-rail");
  if (rail) {
    rail.hidden = turns.length < 2;
    rail.setAttribute("aria-label", t("conversationTurns"));
    rail.innerHTML = turns
      .map(
        ({ turn, title }) => `<button class="turn-tick" type="button" data-turn="${turn}" title="${escapeHtml(title)}"><span class="turn-tick-mark" aria-hidden="true"></span><span class="turn-tick-label">${escapeHtml(title)}</span></button>`,
      )
      .join("");
  }
  if (forceBottom || pinnedToBottom) {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: "instant" });
  }
  lastRenderedSessionPath = sessionPath;
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
    state.lastEventSequence = state.snapshot.cursor || 0;
    state.resyncRequired = false;
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
let lastRenderedSessionPath = null;
let scrollToBottomOnNextRender = false;

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

async function sendPrompt(overrideContent) {
  if (!state.selectedWorkspace) {
    await chooseWorkspace();
    return;
  }
  const content = (overrideContent ?? $("prompt-input").value).trim();
  const sessionId = state.snapshot?.selectedSession?.id;
  if (!content || !sessionId) return;
  const optimisticKey = `optimistic-${Date.now()}`;
  state.liveMessages = [
    ...state.liveMessages,
    { key: optimisticKey, message: { role: "user", content } },
  ].slice(-8);
  state.liveRunning = true;
  scrollToBottomOnNextRender = true;
  renderConversation();
  $("send-prompt").disabled = true;
  $("composer-hint").classList.remove("error");
  try {
    await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ sessionId, content }),
    });
    if (overrideContent === undefined) {
      $("prompt-input").value = "";
      resizePrompt();
    }
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
    const cursor = state.lastEventSequence || 0;
    const response = await fetch(`/events?cursor=${encodeURIComponent(cursor)}`, {
      headers: { ...headers(), "Last-Event-ID": String(cursor) },
    });
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      if (body.code === "RESYNC_REQUIRED" || body.error === "RESYNC_REQUIRED") {
        state.resyncRequired = true;
        await refreshSnapshot();
        setTimeout(connectEvents, 0);
        return;
      }
    }
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
          const sequence = Number(event.sequence);
          if (!Number.isSafeInteger(sequence) || sequence <= state.lastEventSequence) continue;
          if (sequence > state.lastEventSequence + 1) {
            state.resyncRequired = true;
            await refreshSnapshot();
            continue;
          }
          state.lastEventSequence = sequence;
          if (event.type === "session_start" || event.type === "session_switched") {
            state.liveMessages = [];
            state.liveRunning = false;
            state.livePhase = "idle";
            state.liveRetry = null;
            state.thinkingStarts = {};
            state.thinkingDurations = {};
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
            if (event.detail.message.parts?.some((part) => part.type === "thinking")) {
              if (!state.thinkingStarts[key]) state.thinkingStarts[key] = Date.now();
              if (event.type === "message_end") {
                state.thinkingDurations[key] = Date.now() - state.thinkingStarts[key];
              }
            }
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
              "runtime_changed",
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
    throw new Error("event stream closed");
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
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

$("conversation")?.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const editButton = target.closest(".message-edit");
  if (editButton) {
    const row = editButton.closest(".message-row");
    if (row) enterMessageEdit(row);
    return;
  }
  const confirmButton = target.closest(".message-edit-confirm");
  if (confirmButton) {
    const input = confirmButton.closest(".message-content")?.querySelector(".message-edit-input");
    if (input) await confirmMessageEdit(input.value);
    return;
  }
  if (target.closest(".message-edit-cancel")) {
    messageEditActive = false;
    renderConversation();
    return;
  }
  const copyButton = target.closest(".message-copy");
  if (copyButton) {
    const body = copyButton.closest(".message-row")?.querySelector(".message-body");
    const text = body?.textContent?.trim() || "";
    if (text && (await copyText(text))) {
      copyButton.classList.add("copied");
      copyButton.title = t("copiedMessage");
      setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.title = t("copyMessage");
      }, 1200);
    }
    return;
  }
  // Replay the landing brand animation when the logo is clicked: swapping in a
  // fresh clone restarts its CSS animations.
  const brand = target.closest(".landing-brand");
  if (brand) brand.replaceWith(brand.cloneNode(true));
});
$("turn-rail")?.addEventListener("click", (event) => {
  const tick = event.target instanceof Element ? event.target.closest(".turn-tick") : null;
  if (!tick) return;
  document.querySelectorAll(".turn-tick.active").forEach((el) => el.classList.remove("active"));
  tick.classList.add("active");
  document.querySelector(`.message-row[data-turn="${tick.dataset.turn}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
});
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
$("theme-picker-trigger")?.addEventListener("click", () => {
  const menu = $("theme-menu");
  const trigger = $("theme-picker-trigger");
  if (!menu || !trigger) return;
  menu.hidden = !menu.hidden;
  trigger.setAttribute("aria-expanded", String(!menu.hidden));
});
document.querySelectorAll("#theme-menu [data-theme-value]").forEach((option) => {
  option.addEventListener("click", () => {
    state.theme = option.dataset.themeValue in THEME_KEYS ? option.dataset.themeValue : "pi";
    try { localStorage.setItem("openpi.web.theme", state.theme); } catch {}
    applyTheme();
    $("theme-menu").hidden = true;
    $("theme-picker-trigger")?.setAttribute("aria-expanded", "false");
  });
});
document.addEventListener("pointerdown", (event) => {
  const picker = document.querySelector(".language-picker");
  if (picker && !picker.contains(event.target)) {
    $("language-menu").hidden = true;
    $("language-picker-trigger")?.setAttribute("aria-expanded", "false");
  }
  const themeTrigger = $("theme-picker-trigger");
  const themeMenu = $("theme-menu");
  if (themeMenu && !themeMenu.hidden && event.target instanceof Element && !themeMenu.contains(event.target) && event.target !== themeTrigger && !themeTrigger?.contains(event.target)) {
    themeMenu.hidden = true;
    themeTrigger?.setAttribute("aria-expanded", "false");
  }
});

applyLanguage();
applyTheme();
void refreshSnapshot().then(() => connectEvents());
