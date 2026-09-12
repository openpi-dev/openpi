import type { Page, Route } from "@playwright/test";

/**
 * Route-mocked backend fixture for the thinking-level picker.
 *
 * These tests fetch the real Host snapshot and override it with a deterministic
 * active reasoning Session, then intercept `/api/thinking` reads and writes.
 * Nothing here touches the real runtime; only the browser's view of it.
 */

export const MOCK_SESSION_ID = "session-1";
export const MOCK_WORKSPACE = "/mock/workspace";
export const MOCK_SESSION_PATH = `${MOCK_WORKSPACE}/session.jsonl`;
export const MOCK_AVAILABLE = ["off", "low", "high", "max"] as const;

export interface ThinkingFixtureState {
  level: string;
  available: string[];
  supported: boolean;
  runtimeStatus: "idle" | "running";
  /** Monotonic across both snapshot and GET/POST `/api/thinking` projections. */
  revision: number;
}

export interface ThinkingFixture {
  readonly state: ThinkingFixtureState;
  /** Captured `POST /api/thinking` bodies, in request order. */
  readonly posts: Array<{ sessionId: string; level: string }>;
  /** Number of `GET /api/thinking` reconciles issued by the client. */
  getCount(): number;
  /** Hold the next POST response open until `releaseHeldPost()` is called. */
  holdNextPost(): void;
  releaseHeldPost(): void;
  /** Fail the next POST once with the given status and JSON body. */
  failNextPost(status: number, body: Record<string, unknown>): void;
}

export interface ThinkingFixtureOverrides {
  level?: string;
  available?: string[];
  supported?: boolean;
  runtimeStatus?: "idle" | "running";
}

export async function installThinkingFixture(
  page: Page,
  overrides: ThinkingFixtureOverrides = {},
): Promise<ThinkingFixture> {
  const state: ThinkingFixtureState = {
    level: "off",
    available: [...MOCK_AVAILABLE],
    supported: true,
    runtimeStatus: "idle",
    revision: 1000,
    ...overrides,
  };
  const posts: Array<{ sessionId: string; level: string }> = [];
  let getRequests = 0;
  let failure: { status: number; body: Record<string, unknown> } | null = null;
  let holdNext = false;
  let heldReleased = true;
  let releaseHeld: (() => void) | null = null;

  const projection = () => ({
    level: state.level,
    available: [...state.available],
    supported: state.supported,
  });

  const fulfilThinking = async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET") {
      getRequests++;
      await route.fulfill({
        json: {
          sessionId: MOCK_SESSION_ID,
          ...projection(),
          revision: ++state.revision,
        },
      });
      return;
    }
    const body = request.postDataJSON() as {
      sessionId: string;
      level: string;
    };
    posts.push(body);
    if (failure) {
      const current = failure;
      failure = null;
      await route.fulfill({ status: current.status, json: current.body });
      return;
    }
    if (holdNext) {
      holdNext = false;
      if (!heldReleased) {
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
      }
    }
    state.level = body.level;
    await route.fulfill({
      json: {
        sessionId: body.sessionId,
        ...projection(),
        revision: ++state.revision,
      },
    });
  };

  let baseSnapshot: Record<string, unknown> | null = null;
  await page.route("**/api/snapshot**", async (route) => {
    try {
      if (!baseSnapshot) {
        const response = await route.fetch();
        baseSnapshot = (await response.json()) as Record<string, unknown>;
      }
      const snapshot = structuredClone(baseSnapshot);
      snapshot.currentSessionId = MOCK_SESSION_ID;
      snapshot.sessions = [
        {
          id: MOCK_SESSION_ID,
          path: MOCK_SESSION_PATH,
          cwd: MOCK_WORKSPACE,
          source: "web-session",
          origin: "web",
          controller: "web",
          readOnly: false,
          name: "Mock session",
          created: "2026-09-11T00:00:00Z",
          modified: "2026-09-11T00:00:00Z",
          messageCount: 0,
          firstMessage: "",
        },
      ];
      snapshot.workspaces = [
        { path: MOCK_WORKSPACE, name: "Mock", current: true },
      ];
      snapshot.selectedSession = {
        id: MOCK_SESSION_ID,
        path: MOCK_SESSION_PATH,
        cwd: MOCK_WORKSPACE,
        entries: [],
        bytes: 0,
        truncation: {
          truncated: false,
          maxBytes: 2097152,
          entriesOmitted: 0,
          messagesTruncated: 0,
          messagePartsOmitted: 0,
        },
      };
      snapshot.runtime = {
        status: state.runtimeStatus,
        capabilities: {},
      };
      snapshot.models = [
        {
          provider: "mock",
          id: "reasoner",
          name: "Mock Reasoner",
          label: "Mock Reasoner",
          current: true,
        },
      ];
      snapshot.thinking = { ...projection(), revision: ++state.revision };
      await route.fulfill({ json: snapshot });
    } catch {
      // A background snapshot refresh can be aborted while the page navigates
      // or the test tears down, disposing the fetched response. That must not
      // fail the test.
      await route.abort().catch(() => undefined);
    }
  });

  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": idle\n\n",
    }),
  );

  await page.route("**/api/thinking**", (route) => fulfilThinking(route));

  return {
    state,
    posts,
    getCount: () => getRequests,
    holdNextPost() {
      holdNext = true;
      heldReleased = false;
    },
    releaseHeldPost() {
      heldReleased = true;
      releaseHeld?.();
      releaseHeld = null;
    },
    failNextPost(status, body) {
      failure = { status, body };
    },
  };
}
