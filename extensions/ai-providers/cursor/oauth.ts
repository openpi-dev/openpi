import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import type { CursorCredentials } from "./credentials.ts";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 30 * 1_000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1_000;

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorPollOptions {
  /** Test/bridge override; production uses Cursor's auth endpoint. */
  pollUrl?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Cursor authentication cancelled");
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    },
    Math.max(0, ms),
  );
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error("Cursor authentication cancelled"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (error) {
    throwIfAborted(signal);
    if (timeout.aborted) {
      throw new Error(`Cursor request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const verifierBytes = randomBytes(96);
  const verifier = verifierBytes.toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  const query = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return {
    verifier,
    challenge,
    uuid,
    loginUrl: `${CURSOR_LOGIN_URL}?${query.toString()}`,
  };
}

/** Poll Cursor's loginDeepControl handoff until the browser finishes. */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
  options?: CursorPollOptions,
): Promise<{ accessToken: string; refreshToken: string }> {
  const pollUrl = options?.pollUrl ?? CURSOR_POLL_URL;
  const maxAttempts = options?.maxAttempts ?? POLL_MAX_ATTEMPTS;
  const maxDelay = options?.maxDelayMs ?? POLL_MAX_DELAY_MS;
  const multiplier = options?.backoffMultiplier ?? POLL_BACKOFF_MULTIPLIER;
  let delay = options?.baseDelayMs ?? POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await wait(delay, signal);
    const url = new URL(pollUrl);
    url.searchParams.set("uuid", uuid);
    url.searchParams.set("verifier", verifier);
    try {
      const response = await fetchWithTimeout(url.toString(), {}, signal);
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * multiplier, maxDelay);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Cursor auth poll failed: HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!isTokenPayload(payload) || !payload.refreshToken) {
        throw new Error("Cursor auth poll returned an invalid token payload");
      }
      return {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      consecutiveErrors++;
      delay = Math.min(delay * multiplier, maxDelay);
      if (consecutiveErrors >= 3) {
        throw new Error(
          "Too many consecutive errors during Cursor authentication polling",
        );
      }
    }
  }
  throw new Error("Cursor authentication polling timed out");
}

function isTokenPayload(
  value: unknown,
): value is { accessToken: string; refreshToken?: string } {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    (record.refreshToken === undefined ||
      typeof record.refreshToken === "string")
  );
}

export async function loginCursor(
  callbacks: OAuthLoginCallbacks,
): Promise<CursorCredentials> {
  const auth = await generateCursorAuthParams();
  callbacks.onAuth({
    url: auth.loginUrl,
    instructions: "Complete the Cursor sign-in in your browser.",
  });
  callbacks.onProgress?.("Waiting for browser authentication...");

  const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
  const signal = callbacks.signal
    ? AbortSignal.any([callbacks.signal, timeout])
    : timeout;
  const tokens = await pollCursorAuth(auth.uuid, auth.verifier, signal);
  return {
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: getCursorTokenExpiry(tokens.accessToken),
  };
}

export async function refreshCursorToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<CursorCredentials> {
  const response = await fetchWithTimeout(
    CURSOR_REFRESH_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.refresh}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(
      `Cursor token refresh failed: ${response.status} ${await response.text()}`,
    );
  }
  const payload: unknown = await response.json();
  if (!isTokenPayload(payload)) {
    throw new Error("Cursor token refresh returned an invalid token payload");
  }
  return {
    access: payload.accessToken,
    refresh: payload.refreshToken || credentials.refresh,
    expires: getCursorTokenExpiry(payload.accessToken),
  };
}

function decodeCursorJwtPayload(token: string): unknown | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

/** Returns an expiry with the same five-minute safety margin as the Cursor client. */
export function getCursorTokenExpiry(token: string): number {
  try {
    const payload = decodeCursorJwtPayload(token);
    if (
      payload !== null &&
      typeof payload === "object" &&
      "exp" in payload &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp)
    ) {
      return payload.exp * 1_000 - EXPIRY_MARGIN_MS;
    }
  } catch {
    // Cursor occasionally returns opaque access tokens; use a conservative hour.
  }
  return Date.now() + 60 * 60 * 1_000;
}

export const getTokenExpiry = getCursorTokenExpiry;

export function isCursorTokenExpiringSoon(
  token: string,
  thresholdSeconds = 300,
): boolean {
  try {
    const payload = decodeCursorJwtPayload(token);
    if (
      payload === null ||
      typeof payload !== "object" ||
      !("exp" in payload) ||
      typeof payload.exp !== "number"
    ) {
      return true;
    }
    return payload.exp - Math.floor(Date.now() / 1_000) < thresholdSeconds;
  } catch {
    return true;
  }
}
