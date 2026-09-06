import type {
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
  OAuthCredentials,
  OAuthLoginCallbacks,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";

interface LegacyOAuthImplementation {
  name: string;
  isSubscription?: boolean;
  login(callbacks: CancellableOAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(
    credential: OAuthCredentials,
    signal: AbortSignal,
  ): Promise<OAuthCredentials>;
  getApiKey(credential: OAuthCredentials): string | Promise<string>;
}

export type CancellableOAuthLoginCallbacks = Omit<
  OAuthLoginCallbacks,
  "onManualCodeInput"
> & {
  onManualCodeInput?(signal?: AbortSignal): Promise<string>;
};

function legacyCallbacks(
  interaction: ProviderAuthInteraction,
): CancellableOAuthLoginCallbacks {
  return {
    signal: interaction.signal,
    onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
    onDeviceCode: (info) =>
      interaction.notify({ type: "device_code", ...info }),
    onProgress: (message) => interaction.notify({ type: "progress", message }),
    onPrompt: (prompt) =>
      interaction.prompt({
        type: "text",
        message: prompt.message,
        placeholder: prompt.placeholder,
      }),
    onManualCodeInput: (signal) =>
      interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization callback URL or code",
        signal,
      }),
    onSelect: (prompt) =>
      interaction.prompt({
        type: "select",
        message: prompt.message,
        options: prompt.options,
      }),
  };
}

function canonicalCredential(credentials: OAuthCredentials): OAuthCredential {
  return { ...credentials, type: "oauth" };
}

/** Adapt pi's retained extension OAuth callbacks to the native Provider API. */
export function createOAuthAuth(
  implementation: LegacyOAuthImplementation,
): OAuthAuth {
  return {
    name: implementation.name,
    isSubscription: implementation.isSubscription,
    login: async (interaction) =>
      canonicalCredential(
        await implementation.login(legacyCallbacks(interaction)),
      ),
    refresh: async (credential, signal) =>
      canonicalCredential(
        await implementation.refreshToken(credential, signal),
      ),
    toAuth: async (credential): Promise<ModelAuth> => ({
      apiKey: await implementation.getApiKey(credential),
    }),
  };
}
