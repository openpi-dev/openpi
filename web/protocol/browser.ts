import type { BrowserConfig, ExternalBrowser } from "../../extensions/shared/browser-config.ts";

export interface BrowserProfile {
  id: string;
  browser: ExternalBrowser;
  profileId: string;
  extensionId: string;
  version: string;
  connected: boolean;
  current: boolean;
}

export interface BrowserSettingsStatus {
  config: BrowserConfig;
  profiles: BrowserProfile[];
  browsers: { id: ExternalBrowser; installed: boolean }[];
  extensionPath: string;
  extensionVersion: string;
}
