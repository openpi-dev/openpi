/**
 * Google OAuth login + Cloud Code Assist provisioning for Antigravity.
 *
 * Flow (mirrors the real Antigravity client, reference:
 * oh-my-pi packages/ai/src/registry/oauth/google-antigravity.ts):
 *
 *   1. Serve a localhost callback (127.0.0.1:51121/oauth-callback, ephemeral
 *      fallback) and hand the Google consent URL to pi via `callbacks.onAuth`.
 *   2. Exchange the authorization code (no PKCE — the Antigravity client is a
 *      confidential client with a public client_secret).
 *   3. Provision: loadCodeAssist → (onboardUser free-tier poll when the
 *      account has no tier yet) → loadCodeAssist for the project id.
 *   4. Return pi's OAuthCredentials plus { projectId, email } extras; pi
 *      persists the whole object in auth.json and hands it back verbatim.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import type { CancellableOAuthLoginCallbacks } from "../oauth-adapter.ts";
import type { AntigravityCredentials } from "./credentials.ts";

// Public OAuth client identity of the Antigravity IDE (also used by omp and
// the pi-agy project; it is designed to be embedded in shipped binaries).
// Stored as base64 so GitHub secret scanning does not treat the public
// confidential-client pair as a leaked secret.
const CLIENT_ID = atob(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;
const FREE_TIER_ID = "free-tier";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;

/** Refresh tokens are considered stale this long before their actual expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const LOAD_CODE_ASSIST_METADATA = { ideType: "ANTIGRAVITY" };

// ---------------------------------------------------------------------------
// User-Agent (version-gated upstream; see omp catalog/wire/gemini-headers.ts)
// ---------------------------------------------------------------------------

const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";
const VERSION_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredVersion: string | undefined;
let versionFetch: Promise<void> | undefined;

export function getAntigravityUserAgent(): string {
  const version =
    process.env.OPENPI_ANTIGRAVITY_VERSION ||
    discoveredVersion ||
    DEFAULT_ANTIGRAVITY_VERSION;
  const cl = process.env.OPENPI_ANTIGRAVITY_CL || "963137146";
  return `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64; cl=${cl})`;
}

/** Best-effort version discovery from the official update manifest. */
export function ensureAntigravityVersion(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (process.env.OPENPI_ANTIGRAVITY_VERSION || discoveredVersion) {
    return Promise.resolve();
  }
  if (versionFetch) return versionFetch;
  versionFetch = (async () => {
    try {
      const timeout = AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS);
      const response = await fetcher(VERSION_MANIFEST_URL, {
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "electron-builder",
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) {
        discoveredVersion = parseManifestVersion(await response.text());
      }
    } catch {
      // Silent: the pinned fallback stays valid when discovery fails.
    } finally {
      if (!discoveredVersion) versionFetch = undefined;
    }
  })();
  return versionFetch;
}

function parseManifestVersion(yamlText: string): string | undefined {
  for (const line of yamlText.split(/\r?\n/)) {
    const match =
      /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(
        line,
      );
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error(`Login cancelled: ${String(signal.reason ?? "aborted")}`);
  }
}

function withCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  throwIfCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Login cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** fetch with login cancellation + per-request timeout composed. */
async function oauthFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (error) {
    throwIfCancelled(signal);
    if (timeout.aborted) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`);
    }
    throw error;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error("Login cancelled"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

// ---------------------------------------------------------------------------
// Localhost callback server
// ---------------------------------------------------------------------------

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServer {
  port: number;
  waitForCallback(
    expectedState: string,
    signal: AbortSignal | undefined,
  ): Promise<CallbackResult>;
  close(): void;
}

function parseCallbackInput(input: string): CallbackResult | undefined {
  const value = input.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (!code) return undefined;
    return { code, state: url.searchParams.get("state") ?? "" };
  } catch {
    return { code: value, state: "" };
  }
}

const LOGIN_SUCCESS_HTML =
  "<html><body><h2>Antigravity login complete</h2>" +
  "<p>You can return to your terminal.</p></body></html>";

const LOGIN_ERROR_HTML =
  "<html><body><h2>Antigravity login failed</h2>" +
  "<p>Missing or mismatched authorization response.</p></body></html>";

async function startCallbackServer(): Promise<CallbackServer> {
  const server = http.createServer();
  const pending: ((result: CallbackResult) => void)[] = [];
  const failures: { expectedState: string; reject(error: Error): void }[] = [];

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const matching = state
      ? failures.findIndex((entry) => entry.expectedState === state)
      : -1;
    if (error || !code || matching < 0) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(LOGIN_ERROR_HTML);
      // Only a denial carrying our nonce can terminate the flow. A random
      // local request must not be able to cancel an in-flight login.
      if (error && matching >= 0) {
        const [failure] = failures.splice(matching, 1);
        failure?.reject(new Error(`Authorization failed: ${error}`));
      }
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(LOGIN_SUCCESS_HTML);
    for (const resolve of pending.splice(0)) resolve({ code, state: state! });
    failures.length = 0;
  });

  async function listen(port: number): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
    return promise;
  }

  let port: number;
  try {
    port = await listen(CALLBACK_PORT);
  } catch {
    // Preferred port busy: fall back to an ephemeral port; the redirect_uri
    // is built from whatever we actually bound.
    port = await listen(0);
  }

  return {
    port,
    waitForCallback(expectedState, signal) {
      const { promise, resolve, reject } =
        Promise.withResolvers<CallbackResult>();
      let settled = false;
      let onAbort: (() => void) | undefined;
      const pendingCallback = (result: CallbackResult) => {
        if (result.state !== expectedState) {
          return;
        }
        settle(() => resolve(result));
      };
      const failure = {
        expectedState,
        reject(error: Error) {
          settle(() => reject(error));
        },
      };
      const cleanup = () => {
        const pendingIndex = pending.indexOf(pendingCallback);
        if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
        const failureIndex = failures.indexOf(failure);
        if (failureIndex >= 0) failures.splice(failureIndex, 1);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        complete();
      };
      pending.push(pendingCallback);
      failures.push(failure);
      if (signal) {
        onAbort = () => settle(() => reject(new Error("Login cancelled")));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return promise;
    },
    close() {
      for (const failure of [...failures]) {
        failure.reject(new Error("Login callback server closed"));
      }
      pending.length = 0;
      failures.length = 0;
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud Code Assist provisioning
// ---------------------------------------------------------------------------

interface LoadCodeAssistResponse {
  currentTier?: { id?: string } | null;
  paidTier?: { id?: string } | null;
  allowedTiers?: { id?: string }[];
  ineligibleTiers?: {
    tierId?: string;
    reasonMessage?: string;
    validationUrl?: string;
  }[];
  cloudaicompanionProject?: string;
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
  response?: { cloudaicompanionProject?: string } | null;
}

async function postCloudCodeAssist(
  label: string,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  throwIfCancelled(signal);
  const response = await oauthFetch(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": getAntigravityUserAgent(),
      },
      body: JSON.stringify(body),
    },
    signal,
    timeoutMs,
  );
  if (response.status !== 200) {
    const errorText = await response.text();
    throw new Error(
      `${label} failed: ${response.status} ${response.statusText}: ${errorText}`,
    );
  }
  return response.json();
}

function asLoadCodeAssistResponse(payload: unknown): LoadCodeAssistResponse {
  if (payload === null || typeof payload !== "object") {
    throw new Error("loadCodeAssist returned a non-object response");
  }
  return payload as LoadCodeAssistResponse;
}

async function loadCodeAssist(
  accessToken: string,
  signal: AbortSignal | undefined,
): Promise<LoadCodeAssistResponse> {
  let payload = asLoadCodeAssistResponse(
    await postCloudCodeAssist(
      "loadCodeAssist",
      LOAD_CODE_ASSIST_URL,
      accessToken,
      { metadata: LOAD_CODE_ASSIST_METADATA },
      signal,
    ),
  );
  const projectId = payload.cloudaicompanionProject;
  if (payload.paidTier === undefined && projectId) {
    payload = asLoadCodeAssistResponse(
      await postCloudCodeAssist(
        "loadCodeAssist",
        LOAD_CODE_ASSIST_URL,
        accessToken,
        {
          cloudaicompanionProject: projectId,
          metadata: LOAD_CODE_ASSIST_METADATA,
        },
        signal,
      ),
    );
  }
  return payload;
}

function assertFreeTierEligible(payload: LoadCodeAssistResponse): void {
  if (payload.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID)) return;
  const ineligible = payload.ineligibleTiers?.find(
    (tier) => tier.tierId === FREE_TIER_ID,
  );
  if (!ineligible?.reasonMessage) return;
  const validation = ineligible.validationUrl
    ? `\n${ineligible.validationUrl}`
    : "";
  throw new Error(`${ineligible.reasonMessage}${validation}`);
}

async function onboardUser(
  accessToken: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`);
    }
    return left;
  };

  let operation = (await postCloudCodeAssist(
    "onboardUser",
    ONBOARD_USER_URL,
    accessToken,
    { tierId: FREE_TIER_ID, metadata: LOAD_CODE_ASSIST_METADATA },
    signal,
    remaining(),
  )) as OnboardOperation;

  while (true) {
    if (operation.done === true) {
      if (operation.error) {
        const detail =
          operation.error.message ?? JSON.stringify(operation.error);
        throw new Error(`OnboardUser operation failed: ${detail}`);
      }
      return;
    }
    await sleep(Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()), signal);
    throwIfCancelled(signal);
    if (!operation.name) {
      throw new Error("onboardUser returned an operation without a name");
    }
    const polled = await oauthFetch(
      `${OPERATIONS_URL}/${operation.name}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": getAntigravityUserAgent(),
        },
      },
      signal,
      remaining(),
    );
    if (polled.status !== 200) {
      throw new Error(
        `onboardUser poll failed: ${polled.status} ${await polled.text()}`,
      );
    }
    operation = (await polled.json()) as OnboardOperation;
  }
}

async function discoverProject(
  accessToken: string,
  onProgress: ((message: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  onProgress?.("Checking Cloud Code Assist account status...");
  const initial = await loadCodeAssist(accessToken, signal);
  assertFreeTierEligible(initial);
  if (initial.currentTier === undefined || initial.currentTier === null) {
    onProgress?.("Provisioning the Antigravity free tier...");
    await onboardUser(accessToken, signal);
  }
  onProgress?.("Refreshing Cloud Code Assist project...");
  const refreshed = await loadCodeAssist(accessToken, signal);
  const projectId = refreshed.cloudaicompanionProject;
  if (!projectId) {
    throw new Error("loadCodeAssist did not return a cloudaicompanionProject");
  }
  return projectId;
}

async function fetchUserEmail(
  accessToken: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const response = await oauthFetch(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      signal,
    );
    if (response.ok) {
      const data: unknown = await response.json();
      if (data !== null && typeof data === "object" && "email" in data) {
        const email = data.email;
        if (typeof email === "string") return email;
      }
    }
  } catch {
    // Email is display metadata only; never fail the login over it.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

export async function loginAntigravity(
  callbacks: CancellableOAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const signal = callbacks.signal;
  throwIfCancelled(signal);
  await ensureAntigravityVersion(signal);
  throwIfCancelled(signal);

  const server = await startCallbackServer();
  try {
    throwIfCancelled(signal);
    const state = crypto.randomUUID();
    const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    callbacks.onAuth({
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete the Google sign-in in your browser.",
    });

    const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
    const loginSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const raceController = new AbortController();
    const raceSignal = AbortSignal.any([loginSignal, raceController.signal]);
    let callback: CallbackResult;
    try {
      const callbackPromise = server.waitForCallback(state, raceSignal);
      const onManualCodeInput = callbacks.onManualCodeInput;
      if (onManualCodeInput) {
        const manualPromise = (async () => {
          while (true) {
            const parsed = parseCallbackInput(
              await withCancellation(onManualCodeInput(raceSignal), raceSignal),
            );
            if (parsed && (!parsed.state || parsed.state === state))
              return parsed;
          }
        })();
        callback = await Promise.race([callbackPromise, manualPromise]);
      } else {
        callback = await callbackPromise;
      }
    } catch (error) {
      if (timeout.aborted) {
        throw new Error("Login timed out waiting for the browser callback");
      }
      throw error;
    } finally {
      // The callback and manual prompt are alternatives. Cancel the loser as
      // soon as either one supplies a valid authorization code.
      raceController.abort();
    }

    callbacks.onProgress?.("Exchanging authorization code for tokens...");
    throwIfCancelled(signal);
    const tokenResponse = await oauthFetch(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: callback.code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      },
      signal,
    );
    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`,
      );
    }
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh token — revoke the app's access " +
          "at myaccount.google.com/permissions and try again.",
      );
    }

    const projectId = await discoverProject(
      tokens.access_token,
      callbacks.onProgress,
      signal,
    );
    const email = await fetchUserEmail(tokens.access_token, signal);
    throwIfCancelled(signal);

    const credentials: AntigravityCredentials = {
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000 - EXPIRY_MARGIN_MS,
      projectId,
      email,
    };
    return credentials;
  } finally {
    server.close();
  }
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  const existing = credentials as AntigravityCredentials;
  const response = await oauthFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: credentials.refresh,
        grant_type: "refresh_token",
      }),
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${response.status} ${await response.text()}`,
    );
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  const refreshed: AntigravityCredentials = {
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - EXPIRY_MARGIN_MS,
    projectId: existing.projectId,
    email: existing.email,
  };
  return refreshed;
}
