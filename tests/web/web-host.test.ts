import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerWebCapability } from "../../extensions/shared/web-observer-registry.ts";
import { WebHost } from "../../web/host/web-host.ts";
import type {
  WebRuntimeController,
  WebRuntimeEvent,
} from "../../web/runtime/types.ts";

test("serves workspaces through a runtime isolated from terminal sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-host-"));
  const imported = await mkdtemp(join(tmpdir(), "openpi-web-import-"));
  let runtimeCwd = cwd;
  let sessionManager = SessionManager.inMemory(cwd);
  const unregister = registerWebCapability({
    kind: "workflows",
    sessionId: sessionManager.getSessionId(),
    snapshot: () => [{ runId: "wf-test", status: "running" }],
  });
  const prompts: string[] = [];
  let newSessions = 0;
  let disposed = false;
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    sessionDirectory: cwd,
    get cwd() {
      return runtimeCwd;
    },
    get sessionManager() {
      return sessionManager;
    },
    isIdle: () => false,
    sendPrompt: async (content) => {
      prompts.push(content);
    },
    newSession: async (workspacePath) => {
      newSessions++;
      runtimeCwd = workspacePath;
      sessionManager = SessionManager.inMemory(workspacePath);
      for (const listener of listeners) listener({ type: "session_start" });
      return { cancelled: false };
    },
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      disposed = true;
    },
  };
  const host = new WebHost({ runtime });

  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const authorized = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const page = await fetch(`${launched.origin}/`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /<script src="\/marked\.js"><\/script>/);
    assert.match(pageHtml, /<script src="\/app\.js" defer><\/script>/);
    assert.match(
      pageHtml,
      /aria-label="New session"|class="new-session-button"/,
    );
    assert.match(
      pageHtml,
      /id="import-workspace"[^>]*aria-label="Add workspace"/,
    );
    assert.match(pageHtml, /id="workspaces"/);
    assert.match(pageHtml, /id="connection-state"/);
    assert.match(pageHtml, /id="composer"/);
    assert.match(pageHtml, /id="prompt-input"/);
    assert.match(pageHtml, /id="send-prompt"/);
    assert.match(pageHtml, /id="model-picker"/);
    assert.match(pageHtml, /id="composer-hint"/);
    assert.match(pageHtml, /id="select-workspace" class="workspace-picker"/);
    assert.match(
      pageHtml,
      /class="composer-dock">[\s\S]*id="select-workspace"[\s\S]*id="composer"/,
    );
    assert.doesNotMatch(pageHtml, /landing-context/);
    assert.doesNotMatch(pageHtml, /class="context-picker"/);
    assert.doesNotMatch(pageHtml, /aria-label="Search"/);
    assert.match(pageHtml, /id="workspace-menu"/);
    assert.match(pageHtml, /Rename workspace/);
    assert.match(pageHtml, /Remove from sidebar/);
    assert.match(pageHtml, /id="theme-picker-trigger"/);
    assert.match(pageHtml, /data-theme-value="dark"/);

    const app = await fetch(`${launched.origin}/app.js`);
    assert.equal(app.status, 200);
    const appSource = await app.text();
    assert.doesNotMatch(
      appSource,
      /\$\("(?:workspace-path|workspace-dialog|close-workspace-dialog|cancel-workspace|workspace-form)"\)|importWorkspace/,
    );
    assert.match(appSource, /collapseButton\?\.addEventListener\("click"/);
    assert.match(appSource, /aria-expanded="\$\{!collapsed\}"/);
    assert.doesNotMatch(appSource, /icon\("conversation"/);
    assert.match(appSource, /session-title.*session-time/s);
    assert.match(appSource, /data-workspace-action="more"/);
    assert.match(appSource, /data-workspace-action="new"/);
    assert.doesNotMatch(appSource, /workspace-count/);
    assert.match(appSource, /if \(!shell\) \{/);
    assert.match(
      appSource,
      /new-session-button[\s\S]*?createSession\(state\.selectedWorkspace\)/,
    );
    assert.match(appSource, /data-session-action="menu"/);
    assert.match(appSource, /archiveSession\(path\)/);
    assert.match(appSource, /method: "PATCH"/);
    assert.match(appSource, /message\.parts/);
    assert.match(appSource, /message-row assistant detail-only/);
    assert.match(
      appSource,
      /typeof message\.content === "string" \? message\.content\.trim\(\)/,
    );
    assert.match(appSource, /conversation-running/);
    assert.match(appSource, /visibleUngroupedSessions/);
    assert.match(appSource, /workspaceDeleteConfirm/);
    assert.match(appSource, /workspace-delete-dialog/);
    assert.match(appSource, /message-copy/);
    assert.match(appSource, /messageActionsMarkup/);
    assert.match(appSource, /turn-tick/);
    assert.match(appSource, /turn-rail/);
    assert.match(appSource, /scrollIntoView/);
    assert.match(appSource, /activity-card/);
    assert.match(appSource, /familyToolCallCard/);
    assert.match(appSource, /toolLineMarkup/);
    assert.match(appSource, /toolCallSummary/);
    assert.match(appSource, /groupRows/);
    assert.match(appSource, /tool-group/);
    assert.match(appSource, /thinkingLineMarkup/);
    assert.match(appSource, /data-thinking-start/);
    assert.match(appSource, /applyTheme/);
    assert.match(appSource, /data-theme-value/);
    assert.match(appSource, /message-edit-input/);
    assert.match(appSource, /enterMessageEdit/);
    assert.match(appSource, /renderActivityBar/);
    assert.match(appSource, /runtime_changed/);
    assert.match(appSource, /resultsByCallId/);
    assert.match(appSource, /pinnedToBottom/);
    assert.match(appSource, /behavior: "instant"/);
    assert.match(appSource, /customType/);
    assert.match(appSource, /subagent-result/);
    assert.match(appSource, /workflow-result/);

    const marked = await fetch(`${launched.origin}/marked.js`);
    assert.equal(marked.status, 200);
    assert.match(marked.headers.get("content-type") || "", /javascript/);
    assert.match(await marked.text(), /marked v18/);

    const favicon = await fetch(`${launched.origin}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(await favicon.text(), /<svg/);

    const styles = await fetch(`${launched.origin}/styles.css`);
    assert.equal(styles.status, 200);
    const stylesSource = await styles.text();
    assert.match(
      stylesSource,
      /\.landing \.conversation, \.landing \.composer-dock \{ grid-area: 1 \/ 1; \}/,
    );
    assert.match(
      stylesSource,
      /\.landing \.composer-dock \{[\s\S]*?align-self: center;/,
    );
    assert.match(stylesSource, /\.workbench-header \{\s*display: none;\s*\}/);
    assert.match(
      stylesSource,
      /\.composer\.dormant \{[^}]*border-style: dashed/,
    );
    assert.match(
      stylesSource,
      /\.composer\.dormant:hover \{[^}]*border-color:/,
    );
    assert.match(
      stylesSource,
      /\.workspace-picker-row \{[^}]*width: min\(840px, 100%\)/,
    );
    assert.match(
      stylesSource,
      /\.workspace-picker-row \{[^}]*margin: 0 auto[^}]*padding-left: 15px/,
    );
    assert.match(
      stylesSource,
      /\.workspace-picker \{[^}]*width: fit-content[^}]*padding: 0 10px 0 0/,
    );
    assert.match(
      stylesSource,
      /\.composer-toolbar \{[^}]*justify-content: flex-end/,
    );
    assert.match(stylesSource, /\.composer-hint \{ display: none; \}/);
    assert.match(
      stylesSource,
      /\.message-row\.assistant \{ width: min\(840px, calc\(100% - 48px\)\); \}/,
    );
    assert.match(
      stylesSource,
      /\.message-row\.assistant \.message-content \{ width: 100%; max-width: none; \}/,
    );
    assert.match(
      stylesSource,
      /\.message-row\.assistant \.message-details \{ width: min\(820px, calc\(100% - 4px\)\); margin-right: auto; margin-left: auto; \}/,
    );
    assert.match(
      stylesSource,
      /\.message-row\.detail-only \{ padding: 2px 0; \}/,
    );
    assert.match(
      stylesSource,
      /\.message-row\.detail-only \.message-details \{ margin: 0 auto; \}/,
    );
    assert.match(stylesSource, /\.workspace-delete-dialog/);
    assert.match(stylesSource, /\.message-actions \{/);
    assert.match(stylesSource, /\.turn-rail \{/);
    assert.match(stylesSource, /\.turn-tick-label \{/);
    assert.match(stylesSource, /\.activity-card \{/);
    assert.match(stylesSource, /\.activity-chip \{/);
    assert.match(stylesSource, /html\[data-theme="dark"\] body/);
    assert.match(stylesSource, /\.tool-icon \{/);
    assert.match(stylesSource, /\.tool-line\.error/);
    assert.match(stylesSource, /\.tool-group \{/);
    assert.match(
      stylesSource,
      /\.landing-brand \.pixel-mark i:nth-child\(9\) \{ top: 22px; left: 44px; \}/,
    );

    const unauthorized = await fetch(`${launched.origin}/api/snapshot`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${launched.origin}/api/snapshot`, {
      headers: authorized,
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as {
      protocolVersion: number;
      cursor: number;
      currentSessionId: string;
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
      models: Array<{ provider: string; id: string }>;
      runtime: { status: string; capabilities: Record<string, unknown> };
    };
    assert.equal(snapshot.protocolVersion, 1);
    assert.ok(snapshot.cursor >= 1);
    assert.equal(snapshot.currentSessionId, sessionManager.getSessionId());
    assert.ok(Array.isArray(snapshot.models));
    const modelsResponse = await fetch(`${launched.origin}/api/models`, {
      headers: authorized,
    });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual((await modelsResponse.json()).models, snapshot.models);
    assert.equal(snapshot.runtime.status, "running");
    assert.ok(snapshot.workspaces.some((workspace) => workspace.path === cwd));
    assert.deepEqual(snapshot.runtime.capabilities.workflows, [
      { runId: "wf-test", status: "running" },
    ]);

    const sessionsResponse = await fetch(`${launched.origin}/api/sessions`, {
      headers: authorized,
    });
    const listedSessions = (await sessionsResponse.json()) as {
      sessions: Array<{ path: string }>;
    };
    const currentSessionPath = listedSessions.sessions[0]?.path;
    assert.ok(currentSessionPath);
    const sessionRename = await fetch(`${launched.origin}/api/sessions`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: currentSessionPath,
        name: "Renamed conversation",
      }),
    });
    assert.equal(sessionRename.status, 200);
    const sessionArchive = await fetch(
      `${launched.origin}/api/sessions/archive?path=${encodeURIComponent(currentSessionPath)}`,
      { method: "POST", headers: authorized },
    );
    assert.equal(sessionArchive.status, 200);
    const archivedSnapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { sessions: Array<{ path: string; archived?: boolean }> };
    assert.equal(
      archivedSnapshot.sessions.find(
        (session) => session.path === currentSessionPath,
      )?.archived,
      true,
    );

    const wrongSession = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ sessionId: "other", content: "wrong target" }),
    });
    assert.equal(wrongSession.status, 409);

    const prompt = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        content: "continue here",
      }),
    });
    assert.equal(prompt.status, 202);
    assert.deepEqual(prompts, ["continue here"]);

    const importResponse = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ path: imported }),
    });
    assert.equal(importResponse.status, 201);
    const importedWorkspace = (await importResponse.json()) as { path: string };
    const afterImport = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { workspaces: Array<{ path: string }> };
    assert.ok(
      afterImport.workspaces.some(
        (workspace) => workspace.path === importedWorkspace.path,
      ),
    );

    const renameResponse = await fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: importedWorkspace.path,
        name: "Reference code",
      }),
    });
    assert.equal(renameResponse.status, 200);
    const concurrentRenames = await Promise.all([
      fetch(`${launched.origin}/api/workspaces`, {
        method: "PATCH",
        headers: authorized,
        body: JSON.stringify({
          path: importedWorkspace.path,
          name: "Concurrent left",
        }),
      }),
      fetch(`${launched.origin}/api/workspaces`, {
        method: "PATCH",
        headers: authorized,
        body: JSON.stringify({
          path: importedWorkspace.path,
          name: "Concurrent right",
        }),
      }),
    ]);
    assert.deepEqual(
      concurrentRenames.map((response) => response.status),
      [200, 200],
    );
    const restoreRename = await fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: authorized,
      body: JSON.stringify({
        path: importedWorkspace.path,
        name: "Reference code",
      }),
    });
    assert.equal(restoreRename.status, 200);
    const afterRename = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as { workspaces: Array<{ path: string; name: string }> };
    assert.equal(
      afterRename.workspaces.find(
        (workspace) => workspace.path === importedWorkspace.path,
      )?.name,
      "Reference code",
    );

    const importedSession = await fetch(`${launched.origin}/api/sessions`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ workspacePath: importedWorkspace.path }),
    });
    assert.equal(importedSession.status, 201);
    assert.equal(runtimeCwd, importedWorkspace.path);

    const newSession = await fetch(`${launched.origin}/api/sessions`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ workspacePath: cwd }),
    });
    assert.equal(newSession.status, 201);
    assert.equal(runtimeCwd, cwd);
    assert.equal(newSessions, 2);

    const removeActive = await fetch(
      `${launched.origin}/api/workspaces?path=${encodeURIComponent(cwd)}`,
      { method: "DELETE", headers: authorized },
    );
    assert.equal(removeActive.status, 200);
    const afterActiveRemove = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      currentSessionId: string;
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
    };
    assert.equal(
      afterActiveRemove.currentSessionId,
      sessionManager.getSessionId(),
    );
    assert.ok(
      !afterActiveRemove.workspaces.some((workspace) => workspace.path === cwd),
    );

    assert.equal(
      afterActiveRemove.sessions.find((session) => session.cwd === cwd)
        ?.ungrouped,
      true,
    );

    const restoreActive = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ path: cwd }),
    });
    assert.equal(restoreActive.status, 201);
    const restoredActive = (await restoreActive.json()) as { path: string };
    const afterActiveRestore = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
    };
    assert.ok(
      afterActiveRestore.workspaces.some(
        (workspace) => workspace.path === restoredActive.path,
      ),
    );
    assert.equal(
      afterActiveRestore.sessions.find((session) => session.cwd === cwd)
        ?.ungrouped,
      true,
    );

    const removeImported = await fetch(
      `${launched.origin}/api/workspaces?path=${encodeURIComponent(importedWorkspace.path)}`,
      { method: "DELETE", headers: authorized },
    );
    assert.equal(removeImported.status, 200);
    const afterRemove = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers: authorized })
    ).json()) as {
      workspaces: Array<{ path: string }>;
    };
    assert.ok(
      !afterRemove.workspaces.some(
        (workspace) => workspace.path === importedWorkspace.path,
      ),
    );
  } finally {
    await host.stop();
    assert.equal(disposed, true);
    unregister();
    await Promise.all(
      [cwd, imported].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("accepts prompts before the agent turn settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-"));
  const sessionManager = SessionManager.inMemory(cwd);
  let resolvePrompt!: () => void;
  const promptSettled = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  let promptStarted = false;
  let disposed = false;
  const runtime: WebRuntimeController = {
    sessionDirectory: cwd,
    cwd,
    sessionManager,
    isIdle: () => false,
    sendPrompt: async () => {
      promptStarted = true;
      await promptSettled;
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe: () => () => {},
    dispose: async () => {
      disposed = true;
    },
  };
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const responsePromise = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        content: "hello",
      }),
    });
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("prompt endpoint blocked")), 500),
      ),
    ]);
    assert.equal(response.status, 202);
    assert.equal(promptStarted, true);
    resolvePrompt();
    await responsePromise;
  } finally {
    resolvePrompt();
    await host.stop();
    assert.equal(disposed, true);
    await rm(cwd, { recursive: true, force: true });
  }
});
