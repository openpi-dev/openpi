// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WebGitReviewResult,
  WebGitReviewSource,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { WORKBAR_POSITION_STORAGE_KEY } from "../../web/ui/src/features/workbar/workbar-position-storage.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";

installCheckVisibilityFixture();
const original = webStore.getState();
const sessionId = "shared-session";
const pathA = "/workspace/a.jsonl";
const pathB = "/workspace/b.jsonl";
const filePath = "src/example.ts";
const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const truncation = {
  bytes: 0,
  maxBytes: 4 * 1024 * 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};
type ReviewRequest = {
  sessionId: string;
  path: string;
  signal?: AbortSignal;
  options: Parameters<WebClient["gitReview"]>[3];
  resolve: (result: WebGitReviewResult) => void;
};
let requests: ReviewRequest[] = [];

function snapshot(path = pathA): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-10-01T12:00:00Z",
    cursor: 1,
    currentSessionId: sessionId,
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation,
    selectedSession: {
      id: sessionId,
      path,
      cwd: "/workspace",
      bytes: 1,
      truncation,
      entries: [
        {
          id: "prompt",
          type: "message",
          timestamp: "2026-10-01T12:00:00Z",
          message: { role: "user", content: "Review this change" },
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  window.localStorage.removeItem(WORKBAR_POSITION_STORAGE_KEY);
  requests = [];
  vi.spyOn(original.actions, "start").mockImplementation(() => {});
  vi.spyOn(original.actions, "stop").mockImplementation(() => {});
  vi.spyOn(WebClient.prototype, "pendingQuestions").mockResolvedValue({
    pending: null,
  });
  vi.spyOn(WebClient.prototype, "gitReview").mockImplementation(
    (ownerId, path, signal, options) =>
      new Promise<WebGitReviewResult>((resolve) => {
        requests.push({ sessionId: ownerId, path, signal, options, resolve });
      }),
  );
  const current = snapshot();
  webStore.setState(
    {
      ...createWebStore().getState(),
      actions: original.actions,
      snapshot: current,
      connection: "connected",
      selectedWorkspace: "/workspace",
      selectedPath: pathA,
    },
    true,
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(WORKBAR_POSITION_STORAGE_KEY);
  webStore.setState(original, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function panel() {
  return within(document.querySelector<HTMLElement>(".workbar-panel")!);
}

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: i18n.t("openTools") }));
  fireEvent.click(
    panel().getByRole("button", {
      name: new RegExp("^" + i18n.t("changeEvidence")),
    }),
  );
}

async function select(path: string) {
  await act(async () =>
    webStore.setState({
      snapshot: snapshot(path),
      selectedPath: path,
      sessionSwitching: false,
    }),
  );
}

async function nextRequest(
  path: string,
  source: WebGitReviewSource,
  after = 0,
  baseRef?: string,
) {
  const match = () =>
    requests
      .slice(after)
      .find(
        (request) =>
          request.sessionId === sessionId &&
          request.path === path &&
          request.options?.source === source &&
          request.options?.baseRef === baseRef &&
          !request.options?.file &&
          !request.signal?.aborted,
      );
  await waitFor(() => expect(match()).toBeDefined());
  return match()!;
}

async function respond(request: ReviewRequest, revision = revisionA) {
  await act(async () =>
    request.resolve({
      ok: true,
      branches: {
        currentBranch: "feature",
        truncated: false,
        options: [
          { ref: "refs/heads/main", label: "main" },
          { ref: "refs/heads/release", label: "release" },
        ],
      },
      snapshot: {
        repositoryRoot: "/workspace",
        currentBranch: "feature",
        baseBranch:
          request.options?.source === "branch"
            ? (request.options.baseRef ?? "refs/heads/main")
            : null,
        comparison: request.options?.source ?? "unstaged",
        revision,
        additions: 1,
        deletions: 1,
        truncated: false,
        files: [
          {
            path: filePath,
            status: "modified",
            additions: 1,
            deletions: 1,
            diffLoaded: true,
            diffTruncated: false,
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      },
    }),
  );
}

function viewed() {
  return panel().getByRole<HTMLInputElement>("checkbox", {
    name: i18n.t("gitReviewMarkViewed", { path: filePath }),
  });
}

it("isolates viewed marks for the same Session id across exact paths and restores A only for the displayed revision", async () => {
  render(createElement(Providers, null, createElement(App)));
  await openReview();
  const initial = await nextRequest(pathA, "unstaged");
  await respond(initial);
  expect(viewed().checked).toBe(false);

  // Reading a diff does not make an operator decision on the file.
  fireEvent.click(panel().getByRole("button", { name: filePath }));
  await panel().findByRole("figure");
  fireEvent.click(
    panel().getByRole("button", { name: i18n.t("gitReviewBackToFiles") }),
  );
  expect(viewed().checked).toBe(false);
  fireEvent.click(viewed());
  expect(viewed().checked).toBe(true);

  const beforeB = requests.length;
  await select(pathB);
  await openReview();
  const other = await nextRequest(pathB, "unstaged", beforeB);
  expect(panel().queryByRole("checkbox")).toBeNull();
  await respond(other);
  expect(other.sessionId).toBe(initial.sessionId);
  expect(other.path).not.toBe(initial.path);
  expect(viewed().checked).toBe(false);

  const beforeReturn = requests.length;
  await select(pathA);
  const restored = await nextRequest(pathA, "unstaged", beforeReturn);
  expect(panel().queryByRole("checkbox")).toBeNull();
  await respond(restored);
  expect(viewed().checked).toBe(true);

  const beforeRefresh = requests.length;
  fireEvent.click(
    panel().getByRole("button", { name: i18n.t("gitReviewRefresh") }),
  );
  const changed = await nextRequest(pathA, "unstaged", beforeRefresh);
  await respond(changed, revisionB);
  await waitFor(() => expect(viewed().checked).toBe(false));
  expect(requests.every((request) => request.sessionId === sessionId)).toBe(
    true,
  );
});

it("clears the exact Session's viewed marks when the comparison source or concrete base changes, even with the same revision", async () => {
  render(createElement(Providers, null, createElement(App)));
  await openReview();
  await respond(await nextRequest(pathA, "unstaged"));
  fireEvent.click(viewed());
  expect(viewed().checked).toBe(true);

  const beforeSource = requests.length;
  fireEvent.change(panel().getByRole("combobox"), {
    target: { value: "staged" },
  });
  const staged = await nextRequest(pathA, "staged", beforeSource);
  await respond(staged);
  expect(viewed().checked).toBe(false);

  const beforeBranch = requests.length;
  fireEvent.change(panel().getByRole("combobox"), {
    target: { value: "branch" },
  });
  await respond(await nextRequest(pathA, "branch", beforeBranch));
  fireEvent.click(viewed());
  expect(viewed().checked).toBe(true);

  const beforeBase = requests.length;
  fireEvent.click(
    panel().getByRole("button", { name: i18n.t("gitReviewBaseBranch") }),
  );
  fireEvent.click(screen.getByRole("option", { name: /^release/u }));
  const release = await nextRequest(
    pathA,
    "branch",
    beforeBase,
    "refs/heads/release",
  );
  expect(panel().queryByRole("checkbox")).toBeNull();
  await respond(release);
  expect(viewed().checked).toBe(false);
  expect(release.path).toBe(pathA);
  expect(release.options?.baseRef).toBe("refs/heads/release");
});
