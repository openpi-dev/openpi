/** Reviewed optional package; Pi remains the owner of installation and loading. */
export const WEB_ACCESS_PACKAGE = {
  name: "pi-web-access",
  version: "0.38.0",
  source: "npm:pi-web-access@0.38.0",
  repository: "https://github.com/nicobailon/pi-web-access",
} as const;

export const WEB_ACCESS_ACTIONS = [
  "install-exa",
  "install-existing",
  "disable",
] as const;
export type WebAccessAction = (typeof WEB_ACCESS_ACTIONS)[number];

/** This profile is created only after the user chooses Exa, never at startup. */
export const EXA_WEB_ACCESS_PROFILE = {
  provider: "exa",
  webSearch: { allowedProviders: ["exa"] },
  toolActivation: "dynamic",
  workflow: "none",
  tools: { sourceCheck: { enabled: false } },
  fetch: { defaultMode: "readable", allowedModes: ["readable", "raw"] },
  fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
  allowBrowserCookies: false,
  autoOpenBrowser: false,
  githubClone: { enabled: false },
  githubPrIssue: { enabled: false },
  youtube: { enabled: false },
  video: { enabled: false },
  image: { enabled: false },
  pdf: { enabled: true, maxSizeMB: 20, maxPages: 100 },
  commands: {
    websearch: { enabled: false },
    curator: { enabled: false },
    search: { enabled: false },
    "google-account": { enabled: false },
  },
} as const;

export function isWebAccessSource(source: string) {
  return /^npm:pi-web-access(?:@[^/]+)?$/u.test(source);
}
