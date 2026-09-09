import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerWebCapability } from "../../extensions/shared/web-observer-registry.ts";
import { WebHost } from "../../web/host/web-host.ts";
import {
  type WebRuntimeController,
  type WebRuntimeEvent,
  WebRuntimeRequestError,
} from "../../web/runtime/types.ts";

// Use a raw document request: fetch always sets Sec-Fetch-Mode to cors.
function documentRequest(url: string, headers: Record<string, string> = {}) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(
              name,
              Array.isArray(value) ? value.join(", ") : value,
            );
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: responseHeaders,
          }),
        );
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("serves workspaces through a runtime isolated from terminal sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-host-"));
  const imported = await mkdtemp(join(tmpdir(), "openpi-web-import-"));
  let runtimeCwd = cwd;
  let sessionManager = SessionManager.inMemory(cwd);
  const unregister = registerWebCapability(sessionManager, {
    kind: "workflows",
    snapshot: () => ({
      items: [
        {
          runId: "wf-test",
          status: "running",
          startedAt: 1,
          agents: { total: 1, running: 1, done: 0, error: 0, uncertain: 0 },
        },
      ],
      omitted: 0,
      truncated: false,
    }),
  });
  const unregisterTerminalDetails = registerWebCapability(sessionManager, {
    kind: "background-terminals",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
    detail: (id) =>
      id === "bt-test"
        ? {
            kind: "background-terminals",
            id,
            title: "server",
            command: "run-server",
            cwd,
            status: "running",
            createdAt: 1,
            stdout: {
              text: "ready",
              totalBytes: 5,
              retainedBytes: 5,
              omittedBytes: 0,
              truncated: false,
              recoveryAvailable: false,
            },
            stderr: {
              text: "",
              totalBytes: 0,
              retainedBytes: 0,
              omittedBytes: 0,
              truncated: false,
              recoveryAvailable: false,
            },
            truncated: false,
          }
        : undefined,
  });
  const prompts: string[] = [];
  const creationCommandIds: string[] = [];
  let newSessions = 0;
  let disposed = false;
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    get cwd() {
      return runtimeCwd;
    },
    get sessionManager() {
      return sessionManager;
    },
    isIdle: () => false,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async (content) => {
      prompts.push(content);
      return { pendingFollowUps: 0 };
    },
    newSession: async (workspacePath, options) => {
      newSessions++;
      if (options?.commandId) creationCommandIds.push(options.commandId);
      runtimeCwd = workspacePath;
      sessionManager = SessionManager.inMemory(workspacePath);
      for (const listener of listeners) listener({ type: "session_start" });
      return {
        cancelled: false,
        ...(options?.commandId ? { commandId: options.commandId } : {}),
      };
    },
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [
      {
        provider: "fixture",
        id: "current-model",
        name: "Current",
        label: "Current",
        current: true,
      },
      {
        provider: "fixture",
        id: "other-model",
        name: "Other",
        label: "Other",
        current: false,
      },
    ],
    getProjectTrustStatus: () => ({
      source: "pi-project-trust",
      workspace: runtimeCwd,
      state: "restricted",
      decision: "undecided",
      projectResources: true,
      sessionTrusted: false,
      refreshRequired: false,
    }),
    listProviderAuth: () => ({
      providers: [
        {
          id: "fixture",
          name: "Fixture",
          authMethods: ["api_key"],
          configured: true,
          source: "environment",
          subscription: false,
          nameTruncated: false,
        },
      ],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 250,
      },
    }),
    setModel: async () => {
      throw new WebRuntimeRequestError(
        "Model is not available",
        "MODEL_NOT_AVAILABLE",
        400,
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      disposed = true;
    },
  };
  const host = new WebHost({
    runtime,
    allowedOrigins: ["http://127.0.0.1:59999"],
  });

  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const authorized = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const page = await documentRequest(`${launched.origin}/`);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy") || "",
      /img-src 'self' data:/u,
    );
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const pageHtml = await page.text();
    assert.match(pageHtml, /<div id="root"><\/div>/);
    assert.ok(
      pageHtml.includes(`<meta name="openpi-web-token" content="${token}">`),
    );
    assert.equal(
      page.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const blockedHeaders: Record<string, string>[] = [
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Dest": "script" },
      { Referer: "https://attacker.example/" },
      { Origin: "https://attacker.example" },
      { Origin: "http://127.0.0.1:59999" },
    ];
    for (const headers of blockedHeaders) {
      const blocked = await documentRequest(`${launched.origin}/`, headers);
      assert.equal(blocked.status, 403);
      assert.ok(!(await blocked.text()).includes(token));
    }
    const navigation = await documentRequest(`${launched.origin}/`, {
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(navigation.status, 200);
    assert.equal((await fetch(`${launched.origin}/api/snapshot`)).status, 401);
    assert.match(
      pageHtml,
      /<script type="module"[^>]*src="\/app\.js"><\/script>/,
    );
    assert.match(pageHtml, /<link rel="stylesheet"[^>]*href="\/styles\.css">/);
    assert.match(pageHtml, /href="\/favicon\.svg"/);
    assert.doesNotMatch(pageHtml, /marked\.js|https?:\/\//u);

    const app = await fetch(`${launched.origin}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type") || "", /javascript/);
    const appSource = await app.text();
    assert.ok(!appSource.includes(token));
    assert.match(appSource, /OpenPI Web root is missing/);
    assert.match(appSource, /openpi\.web\.token/);
    assert.match(appSource, /\/events\?cursor=/);
    assert.match(appSource, /workspaceDeleteConfirm/);
    assert.match(appSource, /activity-card/);
    assert.doesNotMatch(appSource, /localStorage|openpi\.archived-sessions/);
    assert.doesNotMatch(appSource, /language-picker|open-settings/u);

    const styles = await fetch(`${launched.origin}/styles.css`);
    assert.equal(styles.status, 200);
    const stylesSource = await styles.text();
    assert.match(stylesSource, /\.landing \.conversation/);
    assert.match(stylesSource, /\.composer\.dormant/);
    assert.match(stylesSource, /\.activity-card/);
    assert.match(
      stylesSource,
      /@media\s*\((?:max-width:\s*760px|width\s*<=\s*760px)\)/,
    );
    assert.match(stylesSource, /prefers-reduced-motion/);

    const favicon = await fetch(`${launched.origin}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") || "", /svg/);

    const removedLegacyAsset = await fetch(`${launched.origin}/marked.js`);
    assert.equal(removedLegacyAsset.status, 401);

    let thinkingReads = 0;
    runtime.getThinkingState = () => {
      thinkingReads++;
      return { level: "high", available: ["off", "high"] };
    };
    assert.equal((await fetch(`${launched.origin}/api/thinking`)).status, 401);
    assert.equal(thinkingReads, 0);
    const thinkingResponse = await fetch(`${launched.origin}/api/thinking`, {
      headers: authorized,
    });
    assert.deepEqual(await thinkingResponse.json(), {
      sessionId: sessionManager.getSessionId(),
      level: "high",
      available: ["off", "high"],
    });
    assert.equal(thinkingReads, 1);
    delete runtime.getThinkingState;
    const unknownThinking = await fetch(`${launched.origin}/api/thinking`, {
      headers: authorized,
    });
    assert.deepEqual(await unknownThinking.json(), {
      sessionId: sessionManager.getSessionId(),
      level: "unknown",
      available: [],
    });
    assert.equal(
      (
        await fetch(
          `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test`,
        )
      ).status,
      401,
    );

    const trustGetter = runtime.getProjectTrustStatus;
    assert.ok(trustGetter);
    let trustReads = 0;
    runtime.getProjectTrustStatus = () => {
      trustReads++;
      return trustGetter();
    };
    assert.equal((await fetch(`${launched.origin}/api/trust`)).status, 401);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/trust`, {
          headers: { ...authorized, Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${launched.origin}/api/trust`, {
          method: "POST",
          headers: authorized,
        })
      ).status,
      405,
    );
    assert.equal(trustReads, 0);
    delete runtime.getProjectTrustStatus;
    const unavailableTrust = await fetch(`${launched.origin}/api/trust`, {
      headers: authorized,
    });
    assert.equal(unavailableTrust.status, 501);
    assert.equal(
      (await unavailableTrust.json()).code,
      "PROJECT_TRUST_STATUS_UNAVAILABLE",
    );
    runtime.getProjectTrustStatus = trustGetter;

    const unauthorized = await fetch(`${launched.origin}/api/snapshot`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedCapabilities = await fetch(
      `${launched.origin}/api/capabilities`,
    );
    assert.equal(unauthorizedCapabilities.status, 401);
    const unauthorizedDiagnostics = await fetch(
      `${launched.origin}/api/diagnostics`,
    );
    assert.equal(unauthorizedDiagnostics.status, 401);

    const response = await fetch(`${launched.origin}/api/snapshot`, {
      headers: authorized,
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as {
      protocolVersion: number;
      cursor: number;
      preferences: { theme: string };
      currentSessionId: string;
      workspaces: Array<{ path: string }>;
      sessions: Array<{ cwd: string; ungrouped?: boolean }>;
      models: Array<{ provider: string; id: string }>;
      runtime: { status: string; capabilities: Record<string, unknown> };
    };
    assert.equal(snapshot.protocolVersion, 1);
    assert.equal(snapshot.preferences.theme, "system");
    assert.ok(snapshot.cursor >= 1);
    assert.equal(snapshot.currentSessionId, sessionManager.getSessionId());
    assert.ok(Array.isArray(snapshot.models));
    const modelsResponse = await fetch(`${launched.origin}/api/models`, {
      headers: authorized,
    });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual((await modelsResponse.json()).models, snapshot.models);
    const trustResponse = await fetch(`${launched.origin}/api/trust`, {
      headers: authorized,
    });
    assert.equal(trustResponse.status, 200);
    assert.deepEqual(await trustResponse.json(), {
      source: "pi-project-trust",
      workspace: cwd,
      state: "restricted",
      decision: "undecided",
      projectResources: true,
      sessionTrusted: false,
      refreshRequired: false,
    });
    const providerAuthResponse = await fetch(
      `${launched.origin}/api/providers/auth-status`,
      { headers: authorized },
    );
    assert.equal(providerAuthResponse.status, 200);
    assert.deepEqual(await providerAuthResponse.json(), {
      providers: [
        {
          id: "fixture",
          name: "Fixture",
          authMethods: ["api_key"],
          configured: true,
          source: "environment",
          subscription: false,
          nameTruncated: false,
        },
      ],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 250,
      },
    });
    for (const route of [
      "/api/thinking",
      "/api/trust",
      "/api/providers/auth-status",
      "/api/capabilities/detail?kind=background-terminals&id=bt-test",
    ]) {
      const separator = route.includes("?") ? "&" : "?";
      const mismatched = await fetch(
        `${launched.origin}${route}${separator}sessionId=another-session`,
        { headers: authorized },
      );
      assert.equal(mismatched.status, 409);
      assert.equal((await mismatched.json()).code, "SESSION_CHANGED");
    }
    const scopedDetail = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test&sessionId=${encodeURIComponent(sessionManager.getSessionId())}`,
      { headers: authorized },
    );
    assert.equal(scopedDetail.status, 200);
    assert.equal(
      (await scopedDetail.json()).sessionId,
      sessionManager.getSessionId(),
    );
    const terminalDetailResponse = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-test`,
      { headers: authorized },
    );
    assert.equal(terminalDetailResponse.status, 200);
    assert.deepEqual((await terminalDetailResponse.json()).detail, {
      kind: "background-terminals",
      id: "bt-test",
      title: "server",
      command: "run-server",
      cwd,
      status: "running",
      createdAt: 1,
      stdout: {
        text: "ready",
        totalBytes: 5,
        retainedBytes: 5,
        omittedBytes: 0,
        truncated: false,
        recoveryAvailable: false,
      },
      stderr: {
        text: "",
        totalBytes: 0,
        retainedBytes: 0,
        omittedBytes: 0,
        truncated: false,
        recoveryAvailable: false,
      },
      truncated: false,
    });
    const staleTerminalResponse = await fetch(
      `${launched.origin}/api/capabilities/detail?kind=background-terminals&id=bt-missing`,
      { headers: authorized },
    );
    assert.equal(staleTerminalResponse.status, 404);
    assert.deepEqual(await staleTerminalResponse.json(), {
      code: "CAPABILITY_NOT_FOUND",
      error: "capability resource was not found in the active Session",
    });
    const unavailableModel = await fetch(`${launched.origin}/api/model`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        provider: "missing",
        modelId: "missing",
        sessionId: sessionManager.getSessionId(),
      }),
    });
    assert.equal(unavailableModel.status, 400);
    assert.deepEqual(await unavailableModel.json(), {
      code: "MODEL_NOT_AVAILABLE",
      error: "Model is not available",
    });
    assert.equal(snapshot.runtime.status, "running");
    assert.ok(snapshot.workspaces.some((workspace) => workspace.path === cwd));
    assert.deepEqual(snapshot.runtime.capabilities.workflows, {
      items: [
        {
          runId: "wf-test",
          status: "running",
          startedAt: 1,
          agents: { total: 1, running: 1, done: 0, error: 0, uncertain: 0 },
        },
      ],
      omitted: 0,
      truncated: false,
    });
    const capabilitiesResponse = await fetch(
      `${launched.origin}/api/capabilities`,
      { headers: authorized },
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilitiesBody = (await capabilitiesResponse.json()) as {
      sessionId: string;
      capabilities: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(capabilitiesBody).sort(), [
      "capabilities",
      "sessionId",
    ]);
    assert.equal(capabilitiesBody.sessionId, sessionManager.getSessionId());
    assert.deepEqual(
      capabilitiesBody.capabilities,
      snapshot.runtime.capabilities,
    );
    assert.doesNotMatch(
      JSON.stringify(capabilitiesBody),
      /token|Authorization|Bearer|transcript|entries|messages|apiKey|secret/i,
    );
    const writeCapabilities = await fetch(
      `${launched.origin}/api/capabilities`,
      {
        method: "POST",
        headers: authorized,
        body: "{}",
      },
    );
    assert.equal(writeCapabilities.status, 405);

    const diagnosticsResponse = await fetch(
      `${launched.origin}/api/diagnostics`,
      { headers: authorized },
    );
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsBody = await diagnosticsResponse.json();
    assert.deepEqual(diagnosticsBody, {
      node: process.version,
      cwd,
      sessionId: sessionManager.getSessionId(),
      workspaceSelected: true,
      models: [
        {
          provider: "fixture",
          id: "current-model",
          name: "Current",
          label: "Current",
          current: true,
        },
      ],
    });
    assert.doesNotMatch(
      JSON.stringify(diagnosticsBody),
      /token|Authorization|Bearer|transcript|entries|messages|apiKey|secret/i,
    );
    const writeDiagnostics = await fetch(`${launched.origin}/api/diagnostics`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    assert.equal(writeDiagnostics.status, 405);

    const sessionsResponse = await fetch(`${launched.origin}/api/sessions`, {
      headers: authorized,
    });
    const listedSessions = (await sessionsResponse.json()) as {
      sessions: Array<{ path: string }>;
      truncation: { truncated: boolean; sessionsOmitted: number };
    };
    assert.deepEqual(listedSessions.truncation, {
      truncated: false,
      sessionsOmitted: 0,
    });
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

    const unarchiveUrl = `${launched.origin}/api/sessions/unarchive?path=${encodeURIComponent(currentSessionPath)}`;
    assert.equal((await fetch(unarchiveUrl, { method: "POST" })).status, 401);
    assert.equal(
      (
        await fetch(`${launched.origin}/api/sessions/unarchive`, {
          method: "POST",
          headers: authorized,
        })
      ).status,
      400,
    );
    const unarchiveResponse = await fetch(unarchiveUrl, {
      method: "POST",
      headers: authorized,
    });
    assert.equal(unarchiveResponse.status, 200);
    assert.deepEqual(await unarchiveResponse.json(), {
      path: currentSessionPath,
      archived: false,
    });
    const restoredSnapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, {
        headers: authorized,
      })
    ).json()) as { sessions: Array<{ path: string; archived?: boolean }> };
    assert.equal(
      restoredSnapshot.sessions.find(
        (session) => session.path === currentSessionPath,
      )?.archived,
      undefined,
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
      body: JSON.stringify({
        workspacePath: importedWorkspace.path,
        commandId: "create-imported",
      }),
    });
    assert.equal(importedSession.status, 201);
    assert.equal((await importedSession.json()).commandId, "create-imported");
    assert.equal(runtimeCwd, importedWorkspace.path);

    const newSession = await fetch(`${launched.origin}/api/sessions`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ workspacePath: cwd, commandId: "create-current" }),
    });
    assert.equal(newSession.status, 201);
    assert.equal((await newSession.json()).commandId, "create-current");
    assert.equal(runtimeCwd, cwd);
    assert.equal(newSessions, 2);
    assert.deepEqual(creationCommandIds, ["create-imported", "create-current"]);

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
    unregisterTerminalDetails();
    unregister();
    await Promise.all(
      [cwd, imported].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("an unbound Host exposes no bootstrap Session and rejects prompt bypasses", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-unbound-host-"));
  const bootstrap = join(root, ".bootstrap-workspace");
  const sessionManager = SessionManager.inMemory(bootstrap);
  let prompts = 0;
  let disposed = false;
  const events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
  const runtime: WebRuntimeController = {
    cwd: bootstrap,
    workspaceSelected: false,
    sessionDirectory: root,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      prompts++;
      return { pendingFollowUps: 0 };
    },
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    setModel: async () => {
      throw new Error("workspace required");
    },
    subscribe: () => () => {},
    dispose: async () => {
      disposed = true;
    },
  };
  const host = new WebHost({
    runtime,
    onEvent: (type, detail) => events.push({ type, detail }),
  });

  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const snapshotResponse = await fetch(`${launched.origin}/api/snapshot`, {
      headers,
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      currentSessionId?: string;
      selectedSession?: unknown;
      workspaces: unknown[];
      sessions: unknown[];
    };
    assert.equal(snapshot.currentSessionId, undefined);
    assert.equal(snapshot.selectedSession, undefined);
    assert.deepEqual(snapshot.workspaces, []);
    assert.deepEqual(snapshot.sessions, []);

    const prompt = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        content: "must not run",
      }),
    });
    assert.equal(prompt.status, 409);
    assert.deepEqual(await prompt.json(), {
      code: "WORKSPACE_REQUIRED",
      error: "Choose a workspace before using the Web runtime",
    });
    assert.equal(prompts, 0);

    const cancellation = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: sessionManager.getSessionId(),
        commandId: "command-a",
        epoch: 1,
      }),
    });
    assert.equal(cancellation.status, 409);
    assert.equal((await cancellation.json()).code, "WORKSPACE_REQUIRED");

    const started = events.find((event) => event.type === "web_host_started");
    assert.ok(started);
    assert.equal("cwd" in (started.detail ?? {}), false);
  } finally {
    await host.stop();
    assert.equal(disposed, true);
    await rm(root, { recursive: true, force: true });
  }
});

test("returns accepted only after Pi admits the prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-"));
  const sessionManager = SessionManager.inMemory(cwd);
  let resolvePrompt!: () => void;
  const promptAdmitted = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  let promptStarted = false;
  let disposed = false;
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    cwd,
    sessionManager,
    isIdle: () => false,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      promptStarted = true;
      await promptAdmitted;
      return { pendingFollowUps: 0 };
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(promptStarted, true);
    let responded = false;
    void responsePromise.then(() => {
      responded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(responded, false);
    resolvePrompt();
    const response = await responsePromise;
    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as {
      accepted: boolean;
      pendingFollowUps: number;
    };
    assert.equal(responseBody.accepted, true);
    assert.equal(responseBody.pendingFollowUps, 0);
  } finally {
    resolvePrompt();
    await host.stop();
    assert.equal(disposed, true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns an exact receipt for a turn-bound cancellation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-cancel-"));
  const runtime = testRuntime(cwd);
  const activeTurn = {
    sessionId: runtime.sessionManager.getSessionId(),
    commandId: "command-a",
    epoch: 3,
  };
  runtime.getActiveTurn = () => activeTurn;
  runtime.cancelTurn = async (options) => ({
    ...options,
    state: "accepted",
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const snapshotResponse = await fetch(`${launched.origin}/api/snapshot`, {
      headers,
    });
    assert.equal(snapshotResponse.status, 200);
    assert.deepEqual(
      (await snapshotResponse.json()).runtime.activeTurn,
      activeTurn,
    );

    const response = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(activeTurn),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ...activeTurn,
      state: "accepted",
      accepted: true,
      cursor: 1,
    });

    runtime.cancelTurn = async (options) => ({
      ...options,
      state: "stale-turn",
    });
    const stale = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(activeTurn),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).state, "stale-turn");

    const invalid = await fetch(`${launched.origin}/api/turns/cancel`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...activeTurn, epoch: 0 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

function testRuntime(
  cwd: string,
  sendPrompt: WebRuntimeController["sendPrompt"] = async () => ({
    pendingFollowUps: 0,
  }),
) {
  const sessionManager = SessionManager.inMemory(cwd);
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    sessionDirectory: cwd,
    cwd,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt,
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  return runtime;
}

async function startTestHost(runtime: WebRuntimeController) {
  const host = new WebHost({ runtime });
  await host.start();
  const launched = new URL(host.url);
  const token = new URLSearchParams(launched.hash.slice(1)).get("token");
  assert.ok(token);
  const headers = { Authorization: `Bearer ${token}` };
  return { host, launched, headers };
}

test("classifies invalid and oversized JSON bodies as client errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-request-body-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const invalidJson = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: '{"path":',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), {
      code: "INVALID_REQUEST_BODY",
      error: "request body is invalid JSON",
    });

    const nonObjectJson = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(nonObjectJson.status, 400);
    assert.deepEqual(await nonObjectJson.json(), {
      code: "INVALID_REQUEST_BODY",
      error: "request body must be an object",
    });

    const oversizedBody = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "x".repeat(16 * 1024) }),
    });
    assert.equal(oversizedBody.status, 413);
    assert.deepEqual(await oversizedBody.json(), {
      code: "REQUEST_BODY_TOO_LARGE",
      error: "request body is too large",
      maxBytes: 16 * 1024,
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("classifies an oversized body sent in multiple chunks as a client error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-request-chunks-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const bodyLength = 64 * 1024;
  let request: ReturnType<typeof httpRequest> | undefined;
  const responsePromise = new Promise<{
    statusCode: number | undefined;
    body: string;
  }>((resolve, reject) => {
    request = httpRequest(
      {
        hostname: launched.hostname,
        port: Number(launched.port),
        path: "/api/workspaces",
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": bodyLength,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, body }),
        );
      },
    );
    request.once("error", reject);
    request.write(Buffer.alloc(20 * 1024, "a"));
  });

  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for early 413 response")),
        2_000,
      );
      timer.unref();
    });
    const response = await Promise.race([responsePromise, timeout]);
    assert.equal(response.statusCode, 413);
    assert.deepEqual(JSON.parse(response.body), {
      code: "REQUEST_BODY_TOO_LARGE",
      error: "request body is too large",
      maxBytes: 16 * 1024,
    });
  } finally {
    request?.destroy();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps unexpected Web Host failures classified as server errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-server-error-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const adapter = (
    host as unknown as {
      adapter: { importWorkspace(path: string): Promise<string> };
    }
  ).adapter;
  adapter.importWorkspace = async () => {
    throw new Error("unexpected adapter failure");
  };
  try {
    const response = await fetch(`${launched.origin}/api/workspaces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "unexpected adapter failure",
    });
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("quiet SSE clients receive heartbeats without advancing the event cursor", {
  timeout: 2_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-heartbeat-"));
  const host = new WebHost({
    runtime: testRuntime(cwd),
    sseHeartbeatMs: 10,
  });
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const before = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for an SSE heartbeat")),
        1_000,
      );
      request = httpRequest(
        {
          hostname: launched.hostname,
          port: Number(launched.port),
          path: `/events?cursor=${before.cursor}`,
          headers,
        },
        (response) => {
          assert.equal(response.statusCode, 200);
          response.setEncoding("utf8");
          let received = "";
          response.on("data", (chunk: string) => {
            received += chunk;
            if (!received.includes(": heartbeat\n\n")) return;
            clearTimeout(timeout);
            resolve();
          });
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.end();
    });
    const after = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    assert.equal(after.cursor, before.cursor);
  } finally {
    request?.destroy();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adapter initialization fails before the Host starts listening", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-startup-failure-"));
  const runtime = testRuntime(cwd);
  const host = new WebHost({ runtime });
  const adapter = (
    host as unknown as { adapter: { initialize(): Promise<void> } }
  ).adapter;
  adapter.initialize = async () => {
    throw new Error("metadata initialization failed");
  };
  try {
    await assert.rejects(host.start(), /metadata initialization failed/u);
    assert.equal(
      (host as unknown as { server: { listening: boolean } }).server.listening,
      false,
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function readEventRecords(response: Response, count: number) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const records: Array<{
    id: number;
    event: { sequence: number; type: string; detail?: Record<string, unknown> };
  }> = [];
  while (records.length < count) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const id = frame
        .split("\n")
        .find((line) => line.startsWith("id: "))
        ?.slice(4);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!id || !data) continue;
      records.push({
        id: Number(id),
        event: JSON.parse(data) as {
          sequence: number;
          type: string;
          detail?: Record<string, unknown>;
        },
      });
    }
  }
  await reader.cancel();
  return records.slice(0, count);
}

test("rejects prompt admission with the runtime's typed receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-reject-"));
  const rejection = new WebRuntimeRequestError(
    "Pi rejected this prompt",
    "PROMPT_REJECTED",
    422,
  );
  let sendCalls = 0;
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    throw rejection;
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const response = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        content: "reject me",
        commandId: "rejected-admission",
        retry: false,
      }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      code: "PROMPT_REJECTED",
      error: "Pi rejected this prompt",
    });
    const replay = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        content: "reject me",
        commandId: "rejected-admission",
        retry: true,
      }),
    });
    assert.equal(replay.status, 422);
    assert.deepEqual(await replay.json(), {
      code: "PROMPT_REJECTED",
      error: "Pi rejected this prompt",
    });
    assert.equal(sendCalls, 1);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays one prompt admission after a browser timeout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-retry-"));
  let sendCalls = 0;
  let releaseAdmission!: () => void;
  const admitted = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let runtimePendingFollowUps = 2;
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    await admitted;
    const receipt = { pendingFollowUps: runtimePendingFollowUps };
    runtimePendingFollowUps = 0;
    return receipt;
  });
  const { host, launched, headers } = await startTestHost(runtime);
  const commandId = "browser-timeout-retry";
  const prompt = {
    sessionId: runtime.sessionManager.getSessionId(),
    content: "send this exactly once",
    commandId,
  };
  try {
    const abort = new AbortController();
    const timedOut = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...prompt, retry: false }),
      signal: abort.signal,
    });
    while (sendCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    abort.abort();
    await assert.rejects(timedOut, /abort/u);
    // The host can accept after the client loses its receipt. The retry must
    // replay that completed admission rather than dispatch it again.
    releaseAdmission();
    while (
      (
        (await (
          await fetch(`${launched.origin}/api/snapshot`, { headers })
        ).json()) as { cursor: number }
      ).cursor < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const replay = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...prompt, retry: true }),
    });
    const response = await replay;
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      id: commandId,
      accepted: true,
      state: "accepted",
      pendingFollowUps: 2,
      cursor: 2,
    });
    assert.equal(runtimePendingFollowUps, 0);
    assert.equal(sendCalls, 1);

    const conflict = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        content: "different body",
        retry: true,
      }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      code: "COMMAND_CONFLICT",
      error: "commandId is already bound to a different prompt",
    });

    const unknown = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...prompt,
        commandId: "after-host-restart",
        retry: true,
      }),
    });
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), {
      code: "COMMAND_ADMISSION_UNKNOWN",
      error:
        "previous prompt admission is unknown; refresh canonical state before sending a new request",
    });
    assert.equal(sendCalls, 1);
  } finally {
    releaseAdmission?.();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fails closed instead of evicting pending prompt admissions", {
  timeout: 10_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-capacity-"));
  let sendCalls = 0;
  let releaseAdmissions!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseAdmissions = resolve;
  });
  const runtime = testRuntime(cwd, async () => {
    sendCalls++;
    await held;
    return { pendingFollowUps: 0 };
  });
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const requests = Array.from({ length: 128 }, (_, index) =>
      fetch(`${launched.origin}/api/prompt`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: runtime.sessionManager.getSessionId(),
          content: `pending ${index}`,
          commandId: `pending-${index}`,
          retry: false,
        }),
      }),
    );
    while (sendCalls !== 128) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const overflow = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        content: "must not replace a pending admission",
        commandId: "overflow",
        retry: false,
      }),
    });
    assert.equal(overflow.status, 503);
    assert.deepEqual(await overflow.json(), {
      code: "PROMPT_ADMISSION_CAPACITY",
      error:
        "prompt admission capacity is full; wait for a pending admission to settle",
    });
    assert.equal(sendCalls, 128);
    releaseAdmissions();
    assert.ok(
      (await Promise.all(requests)).every(
        (response) => response.status === 202,
      ),
    );
  } finally {
    releaseAdmissions?.();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns and publishes the observed follow-up queue receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-prompt-queue-"));
  const runtime = testRuntime(cwd, async () => ({
    pendingFollowUps: 2,
  }));
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    const response = await fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        content: "queue me",
      }),
    });
    assert.equal(response.status, 202);
    const receipt = (await response.json()) as {
      id: string;
      accepted: boolean;
      state: string;
      pendingFollowUps: number;
      cursor: number;
    };
    assert.match(receipt.id, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      { ...receipt, id: undefined },
      {
        id: undefined,
        accepted: true,
        state: "accepted",
        pendingFollowUps: 2,
        cursor: snapshot.cursor + 1,
      },
    );
    const events = await readEventRecords(
      await fetch(`${launched.origin}/events?cursor=${snapshot.cursor}`, {
        headers,
      }),
      1,
    );
    assert.equal(events[0].event.sequence, snapshot.cursor + 1);
    assert.equal(events[0].event.type, "prompt_accepted");
    assert.match(String(events[0].event.detail?.commandId), /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      { ...events[0].event.detail, commandId: undefined },
      {
        commandId: undefined,
        sessionId: runtime.sessionManager.getSessionId(),
        pendingFollowUps: 2,
      },
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays only events after an exact SSE cursor with event ids", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    host.publish("first");
    host.publish("second");
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const records = await readEventRecords(response, 2);
    assert.deepEqual(
      records.map(({ id, event }) => [id, event.sequence, event.type]),
      [
        [snapshot.cursor + 1, snapshot.cursor + 1, "first"],
        [snapshot.cursor + 2, snapshot.cursor + 2, "second"],
      ],
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replays a bounded burst larger than Node's write high-water mark", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-burst-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 8; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 200);
    const records = await readEventRecords(response, 8);
    assert.deepEqual(
      records.map(({ event }) => event.type),
      Array.from({ length: 8 }, () => "burst"),
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires resync before SSE headers when replay exceeds its byte budget", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-sse-budget-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 13; index++) {
      host.publish("burst", { index, value: "x".repeat(20 * 1024) });
    }
    const response = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "RESYNC_REQUIRED");
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires resync for missing, future, or expired SSE cursors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-cursor-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const missing = await fetch(`${launched.origin}/events`, { headers });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "RESYNC_REQUIRED");

    const future = await fetch(`${launched.origin}/events?cursor=999999`, {
      headers,
    });
    assert.equal(future.status, 409);

    for (let index = 0; index < 205; index++)
      host.publish("advance", { index });
    const expired = await fetch(`${launched.origin}/events?cursor=0`, {
      headers,
    });
    assert.equal(expired.status, 409);
    const body = (await expired.json()) as {
      code: string;
      oldestCursor: number;
    };
    assert.equal(body.code, "RESYNC_REQUIRED");
    assert.ok(body.oldestCursor > 0);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("accepts Last-Event-ID and rejects cursor disagreement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-last-id-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    host.publish("after-snapshot");
    const replay = await fetch(`${launched.origin}/events`, {
      headers: { ...headers, "Last-Event-ID": String(snapshot.cursor) },
    });
    assert.equal(replay.status, 200);
    assert.equal(
      (await readEventRecords(replay, 1))[0]?.event.type,
      "after-snapshot",
    );

    const mismatch = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      {
        headers: {
          ...headers,
          "Last-Event-ID": String(snapshot.cursor + 1),
        },
      },
    );
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).code, "CURSOR_MISMATCH");
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds SSE clients and replaces oversized events with invalidation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-bounds-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const clients: Response[] = [];
  try {
    const snapshot = (await (
      await fetch(`${launched.origin}/api/snapshot`, { headers })
    ).json()) as { cursor: number };
    for (let index = 0; index < 8; index++) {
      const response = await fetch(
        `${launched.origin}/events?cursor=${snapshot.cursor}`,
        { headers },
      );
      assert.equal(response.status, 200);
      clients.push(response);
    }
    const ninth = await fetch(
      `${launched.origin}/events?cursor=${snapshot.cursor}`,
      { headers },
    );
    assert.equal(ninth.status, 503);
    assert.equal((await ninth.json()).code, "SSE_CLIENT_LIMIT");

    const first = clients.shift();
    assert.ok(first);
    const firstRecord = readEventRecords(first, 1);
    host.publish("huge", { value: "x".repeat(80 * 1024) });
    assert.equal((await firstRecord)[0]?.event.type, "state_invalidated");
  } finally {
    for (const response of clients)
      await response.body?.cancel().catch(() => {});
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("concurrent stop callers await the same runtime disposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-"));
  let releaseDispose!: () => void;
  const disposeBarrier = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  let disposeCalls = 0;
  const runtime = testRuntime(cwd);
  runtime.dispose = async () => {
    disposeCalls++;
    await disposeBarrier;
  };
  const { host } = await startTestHost(runtime);
  try {
    const first = host.stop();
    const second = host.stop();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposeCalls, 1);
    assert.equal(secondSettled, false);
    releaseDispose();
    await Promise.all([first, second]);
    assert.equal(disposeCalls, 1);
  } finally {
    releaseDispose();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop waits for lease-sensitive HTTP mutations before runtime disposal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-mutation-"));
  const runtime = testRuntime(cwd);
  let disposeCalls = 0;
  runtime.dispose = async () => {
    disposeCalls++;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  let releaseMutation!: () => void;
  const mutationBarrier = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const adapter = (
    host as unknown as {
      adapter: { renameWorkspace(path: string, name: string): Promise<string> };
    }
  ).adapter;
  adapter.renameWorkspace = async (_path, name) => {
    mutationStarted();
    await mutationBarrier;
    return name;
  };
  try {
    const request = fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: cwd, name: "renamed" }),
    });
    await started;
    const stopping = host.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disposeCalls, 0);

    releaseMutation();
    await stopping;
    assert.equal(disposeCalls, 1);
    assert.equal((await request).status, 200);
  } finally {
    releaseMutation();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop reports uncertain without releasing runtime authority past a mutation", async () => {
  const cwd = await mkdtemp(
    join(tmpdir(), "openpi-web-stop-mutation-timeout-"),
  );
  const runtime = testRuntime(cwd);
  let disposeCalls = 0;
  runtime.dispose = async () => {
    disposeCalls++;
  };
  const host = new WebHost({ runtime, shutdownTimeoutMs: 30 });
  let releaseMutation!: () => void;
  const mutationBarrier = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const adapter = (
      host as unknown as {
        adapter: {
          renameWorkspace(path: string, name: string): Promise<string>;
        };
      }
    ).adapter;
    adapter.renameWorkspace = async (_path, name) => {
      mutationStarted();
      await mutationBarrier;
      return name;
    };
    const request = fetch(`${launched.origin}/api/workspaces`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: cwd, name: "renamed" }),
    });
    await started;
    const startedAt = Date.now();
    await assert.rejects(host.stop(), /cleanup did not settle within 30 ms/u);
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(disposeCalls, 0);

    releaseMutation();
    assert.equal((await request).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(disposeCalls, 1);
  } finally {
    releaseMutation();
    await host.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop rejects a late keepalive mutation before it enters the drain", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-keepalive-"));
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let releasePrompt!: () => void;
  const promptBarrier = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  let releaseDispose!: () => void;
  const disposeBarrier = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const runtime = testRuntime(cwd, async () => {
    promptStarted();
    await promptBarrier;
    return { pendingFollowUps: 0 };
  });
  runtime.dispose = async () => {
    releasePrompt();
    await disposeBarrier;
  };
  const { host, launched, headers } = await startTestHost(runtime);
  let renameCalls = 0;
  const adapter = (
    host as unknown as {
      adapter: { renameWorkspace(path: string, name: string): Promise<string> };
    }
  ).adapter;
  adapter.renameWorkspace = async (_path, name) => {
    renameCalls++;
    return name;
  };
  const socket = createConnection({
    host: launched.hostname,
    port: Number(launched.port),
  });
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  let output = "";
  let lateResponseSeen!: () => void;
  const lateResponse = new Promise<void>((resolve) => {
    lateResponseSeen = resolve;
  });
  socket.on("data", (chunk) => {
    output += chunk;
    if (output.includes("HTTP/1.1 503")) lateResponseSeen();
  });
  try {
    await once(socket, "connect");
    const promptBody = JSON.stringify({
      sessionId: runtime.sessionManager.getSessionId(),
      content: "hold the first request",
    });
    socket.write(
      `POST /api/prompt HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(promptBody)}\r\nConnection: keep-alive\r\n\r\n${promptBody}`,
    );
    await started;

    const stopping = host.stop();
    const renameBody = JSON.stringify({ path: cwd, name: "too late" });
    socket.write(
      `PATCH /api/workspaces HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(renameBody)}\r\nConnection: keep-alive\r\n\r\n${renameBody}`,
    );
    await Promise.race([
      lateResponse,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("late 503 was not observed")), 2_000),
      ),
    ]);

    assert.match(output, /HTTP\/1\.1 202/u);
    assert.match(output, /HTTP\/1\.1 503/u);
    assert.match(output, /HOST_STOPPING/u);
    assert.equal(renameCalls, 0);
    releaseDispose();
    await stopping;
  } finally {
    releasePrompt();
    releaseDispose();
    socket.destroy();
    await host.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop reports uncertain cleanup when runtime disposal never settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-timeout-"));
  const runtime = testRuntime(cwd);
  runtime.dispose = () => new Promise(() => undefined);
  const host = new WebHost({ runtime, shutdownTimeoutMs: 30 });
  try {
    await host.start();
    const startedAt = Date.now();
    await assert.rejects(
      host.stop(),
      /cleanup did not settle within 30 ms; cleanup state is uncertain/u,
    );
    assert.ok(Date.now() - startedAt < 500);
    await assert.rejects(
      host.stop(),
      /cleanup did not settle within 30 ms; cleanup state is uncertain/u,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop aborts an open workspace picker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-picker-"));
  let chooserStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    chooserStarted = resolve;
  });
  let chooserAborted = false;
  const runtime = testRuntime(cwd);
  const host = new WebHost({
    runtime,
    directoryChooser: (signal) =>
      new Promise((resolve) => {
        chooserStarted();
        signal.addEventListener(
          "abort",
          () => {
            chooserAborted = true;
            resolve(undefined);
          },
          { once: true },
        );
      }),
  });
  try {
    await host.start();
    const launched = new URL(host.url);
    const token = new URLSearchParams(launched.hash.slice(1)).get("token");
    assert.ok(token);
    const pickerRequest = fetch(`${launched.origin}/api/workspaces/select`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    await started;

    await host.stop();

    assert.equal(chooserAborted, true);
    assert.equal((await pickerRequest).status, 200);
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop bounds an authenticated incomplete HTTP request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-http-"));
  const { host, launched, headers } = await startTestHost(testRuntime(cwd));
  const socket = createConnection({
    host: launched.hostname,
    port: Number(launched.port),
  });
  socket.on("error", () => undefined);
  try {
    await once(socket, "connect");
    socket.write(
      `POST /api/workspaces HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"path":"`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      host.stop(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("host stop did not finish")),
          2_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    assert.ok(Date.now() - startedAt < 1_500);
  } finally {
    socket.destroy();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop disposes the runtime before waiting for an in-flight prompt request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-stop-prompt-"));
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    promptStarted = resolve;
  });
  let releasePrompt!: () => void;
  const pendingPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  let disposeCalls = 0;
  const runtime = testRuntime(cwd, async () => {
    promptStarted();
    await pendingPrompt;
    return { pendingFollowUps: 0 };
  });
  runtime.dispose = async () => {
    disposeCalls++;
    releasePrompt();
  };
  const { host, launched, headers } = await startTestHost(runtime);
  try {
    const response = fetch(`${launched.origin}/api/prompt`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: runtime.sessionManager.getSessionId(),
        content: "pending during shutdown",
      }),
    });
    await started;
    await host.stop();
    assert.equal(disposeCalls, 1);
    assert.equal((await response).status, 202);
  } finally {
    releasePrompt();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
