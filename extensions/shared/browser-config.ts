/** Browser identity and grants shared by setup, the Web host and settings. */
export const EXTERNAL_BROWSERS = [
  "chrome",
  "edge",
  "brave",
  "chromium",
  "safari",
  "firefox",
] as const;
export type ExternalBrowser = (typeof EXTERNAL_BROWSERS)[number];
export const BROWSER_IDS = ["embedded", ...EXTERNAL_BROWSERS] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

export interface BrowserConfig {
  readonly control: boolean;
  readonly embedded: boolean;
  readonly defaultBrowser: BrowserId;
  readonly externalBrowsers: readonly ExternalBrowser[];
}

export const isExternalBrowser = (value: unknown): value is ExternalBrowser =>
  EXTERNAL_BROWSERS.some((browser) => browser === value);
export const isBrowserId = (value: unknown): value is BrowserId =>
  value === "embedded" || isExternalBrowser(value);
export const isBrowserList = (value: unknown): value is ExternalBrowser[] =>
  Array.isArray(value) &&
  value.every(isExternalBrowser) &&
  new Set(value).size === value.length;

export function browserAllowed(config: BrowserConfig, browser: BrowserId) {
  return (
    config.control &&
    (browser === "embedded"
      ? config.embedded
      : config.externalBrowsers.includes(browser))
  );
}
