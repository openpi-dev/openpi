/**
 * Credential codec for the Antigravity provider.
 *
 * pi persists whatever object `login` returns into auth.json and hands it back
 * to `refreshToken`/`getApiKey` verbatim, so the Antigravity-specific extras
 * (projectId, email) ride along as additional fields. `getApiKey` then packs
 * everything the stream needs into the single `apiKey` string pi threads into
 * `SimpleStreamOptions.apiKey`.
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";

/** Stored credential shape: pi's OAuth fields plus Antigravity extras. */
export interface AntigravityCredentials extends OAuthCredentials {
  /** Cloud Code Assist project resolved during login provisioning. */
  projectId?: string;
  /** Google account email, best-effort display metadata. */
  email?: string;
}

/** What the stream function needs, packed into the apiKey string. */
export interface AntigravityApiKeyPayload {
  token: string;
  projectId?: string;
}

export function encodeApiKey(credentials: AntigravityCredentials): string {
  const payload: AntigravityApiKeyPayload = {
    token: credentials.access,
    projectId: credentials.projectId,
  };
  return JSON.stringify(payload);
}

export function decodeApiKey(raw: string): AntigravityApiKeyPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "token" in parsed) {
      const token = parsed.token;
      if (typeof token === "string") {
        const projectId =
          "projectId" in parsed && typeof parsed.projectId === "string"
            ? parsed.projectId
            : undefined;
        return { token, projectId };
      }
    }
  } catch {
    // Not JSON: tolerate a bare access token (e.g. hand-written auth.json).
  }
  return { token: raw };
}
