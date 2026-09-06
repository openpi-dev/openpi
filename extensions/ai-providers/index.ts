/**
 * ai-providers — OAuth-backed model providers for pi.
 *
 * Adds OAuth-backed Google Antigravity and Cursor model providers. Both are
 * inert until the user logs in and selects one of their models. Cursor uses
 * AgentService/Run in deliberately chat-only mode: Cursor-native coding tools
 * are not exposed or executed by this extension.
 *
 * Wire protocol: Cloud Code Assist `v1internal:streamGenerateContent` over
 * SSE (see antigravity/provider.ts). Reference implementation: oh-my-pi's
 * google-gemini-cli provider (shared google-gemini-cli/google-antigravity).
 */

import { createProvider, type ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOAuthAuth } from "./oauth-adapter.ts";
import { encodeApiKey } from "./antigravity/credentials.ts";
import { fetchAntigravityModels } from "./antigravity/discovery.ts";
import {
  ANTIGRAVITY_API_URL,
  ANTIGRAVITY_MODELS,
} from "./antigravity/models.ts";
import {
  loginAntigravity,
  refreshAntigravityToken,
} from "./antigravity/oauth.ts";
import { streamAntigravity } from "./antigravity/provider.ts";
import { getCursorApiKey } from "./cursor/credentials.ts";
import { fetchCursorModels } from "./cursor/discovery.ts";
import { transformCursorImageInput } from "./cursor/input-images.ts";
import { CURSOR_MODELS } from "./cursor/models.ts";
import { loginCursor, refreshCursorToken } from "./cursor/oauth.ts";
import { streamCursor } from "./cursor/provider.ts";

function providerStreams(
  streamSimple: ProviderStreams["streamSimple"],
): ProviderStreams {
  return {
    stream: (model, context, options) => streamSimple(model, context, options),
    streamSimple,
  };
}

export default function authProviders(pi: ExtensionAPI) {
  pi.on("input", transformCursorImageInput);

  pi.registerProvider(
    createProvider({
      id: "google-antigravity",
      name: "Google Antigravity",
      baseUrl: ANTIGRAVITY_API_URL,
      api: providerStreams(streamAntigravity),
      auth: {
        oauth: createOAuthAuth({
          name: "Google (Antigravity)",
          isSubscription: true,
          login: loginAntigravity,
          refreshToken: refreshAntigravityToken,
          getApiKey: encodeApiKey,
        }),
      },
      models: ANTIGRAVITY_MODELS,
      fetchModels: fetchAntigravityModels,
    }),
  );

  pi.registerProvider(
    createProvider({
      id: "cursor",
      name: "Cursor",
      baseUrl: "https://api2.cursor.sh",
      api: providerStreams(streamCursor),
      auth: {
        oauth: createOAuthAuth({
          name: "Cursor",
          isSubscription: true,
          login: loginCursor,
          refreshToken: refreshCursorToken,
          getApiKey: getCursorApiKey,
        }),
      },
      models: CURSOR_MODELS,
      fetchModels: fetchCursorModels,
    }),
  );
}
