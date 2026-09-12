import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";

/** Cursor stores the short-lived access JWT and its refresh token together. */
export type CursorCredentials = OAuthCredentials;

/** pi passes the return value of this function to `streamSimple.apiKey`. */
export function getCursorApiKey(credentials: CursorCredentials): string {
  return credentials.access;
}

/** Accept a bare access token for hand-written or older auth.json entries. */
export function decodeCursorApiKey(value: string | undefined): string {
  return value?.trim() ?? "";
}
