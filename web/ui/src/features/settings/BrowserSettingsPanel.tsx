import { Switch } from "@astryxdesign/core/Switch";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BROWSER_IDS,
  EXTERNAL_BROWSERS,
  type BrowserConfig,
  type BrowserId,
  type ExternalBrowser,
} from "../../../../../extensions/shared/browser-config.ts";
import type { BrowserSettingsStatus } from "../../../../protocol/browser.ts";
import { copyText } from "../../lib/clipboard.ts";
import { WebClient } from "../../protocol/client.ts";

const names = {
  chrome: "Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  chromium: "Chromium",
} as const;

function BrowserMark({ browser }: { browser: BrowserId }) {
  return (
    <span className={`browser-settings-mark ${browser}`} aria-hidden="true">
      {browser === "chrome" || browser === "chromium" ? <i /> : <Globe2 />}
    </span>
  );
}

export function BrowserSettingsPanel({
  onSaved,
}: {
  onSaved: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserSettingsStatus>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [guide, setGuide] = useState<BrowserId>();
  const [installer, setInstaller] = useState<ExternalBrowser>("chrome");
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
  const serial = useRef(0);
  const guideElement = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    if (guide)
      guideElement.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
  }, [guide]);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const next = await new WebClient().request<BrowserSettingsStatus>(
        "/api/settings/browser",
      );
      if (mounted.current && request === serial.current) {
        setStatus(next);
        setError(undefined);
      }
      return next;
    } catch (reason) {
      if (mounted.current && request === serial.current)
        setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  const save = async (patch: Partial<BrowserConfig>) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    ++serial.current;
    try {
      const next = await new WebClient().request<BrowserSettingsStatus>(
        "/api/settings/browser",
        { method: "POST", body: JSON.stringify(patch) },
      );
      if (!mounted.current) return;
      ++serial.current;
      setStatus(next);
      setNotice(t("browserSaved"));
      void onSaved();
    } catch (reason) {
      await refresh();
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const action = async (
    browser: ExternalBrowser,
    action: "install" | "manage" | "connect",
  ) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await new WebClient().request("/api/settings/browser/action", {
        method: "POST",
        body: JSON.stringify({ browser, action }),
      });
      if (mounted.current) {
        setOpened(true);
        setNotice(t("browserNativeOpened"));
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const name = (id: BrowserId) =>
    id === "embedded" ? t("browserEmbedded") : names[id];
  if (!status)
    return (
      <div className="browser-settings-load" role={error ? "alert" : "status"}>
        <Globe2 />
        <p>{error || t("browserLoading")}</p>
        {error && (
          <button type="button" onClick={() => void refresh()}>
            {t("browserCheck")}
          </button>
        )}
      </div>
    );
  const { config } = status;
  const currentProfile = status.profiles.find(
    (profile) =>
      profile.current &&
      profile.connected &&
      profile.version === status.extensionVersion,
  );
  const connections = (browser: BrowserId) =>
    status.profiles.filter(
      (profile) =>
        profile.connected &&
        profile.version === status.extensionVersion &&
        (browser === "embedded"
          ? profile.current
          : profile.browser === browser),
    );
  const allowed = (browser: BrowserId) =>
    browser === "embedded"
      ? config.embedded
      : config.externalBrowsers.includes(browser);
  const allowPatch = (
    browser: BrowserId,
    value: boolean,
  ): Partial<BrowserConfig> =>
    browser === "embedded"
      ? { embedded: value }
      : {
          externalBrowsers: value
            ? [...new Set([...config.externalBrowsers, browser])]
            : config.externalBrowsers.filter((id) => id !== browser),
        };
  const setup = (browser: BrowserId) => {
    setGuide(browser);
    setOpened(false);
    setNotice(undefined);
    setCopied(false);
    setInstaller(
      browser === "embedded" ? (currentProfile?.browser ?? "chrome") : browser,
    );
  };
  const row = (browser: BrowserId) => {
    const connected = connections(browser).length > 0;
    const installed =
      browser === "embedded" ||
      status.browsers.some((item) => item.id === browser && item.installed);
    const old = status.profiles.some(
      (profile) =>
        profile.connected &&
        profile.version !== status.extensionVersion &&
        (browser === "embedded"
          ? profile.current
          : profile.browser === browser),
    );
    return (
      <div className="browser-settings-row" key={browser}>
        <BrowserMark browser={browser} />
        <div className="browser-settings-description">
          <strong>{name(browser)}</strong>
          <span className={connected ? "connected" : ""}>
            {connected ? (
              <>
                <i />
                {t("browserConnected")}
              </>
            ) : (
              t(
                old
                  ? "browserUpdateNeeded"
                  : installed
                    ? "browserNeedsSetup"
                    : "browserNotFound",
              )
            )}
          </span>
        </div>
        <button
          className="browser-settings-button"
          type="button"
          aria-label={t(
            connected ? "browserManageNamed" : "browserSetupNamed",
            { browser: name(browser) },
          )}
          onClick={() => setup(browser)}
        >
          {t(connected ? "browserManage" : "browserSetUp")}
        </button>
        <Switch
          label={t("browserAllowNamed", { browser: name(browser) })}
          isLabelHidden
          size="sm"
          value={allowed(browser)}
          isDisabled={pending}
          onChange={(value: boolean) => void save(allowPatch(browser, value))}
        />
      </div>
    );
  };
  const guideConnected = guide !== undefined && connections(guide).length > 0;
  const installed = status.browsers.some(
    (item) => item.id === installer && item.installed,
  );
  return (
    <div className="browser-settings">
      <header className="browser-settings-heading">
        <h2>{t("browserSettings")}</h2>
        <p>{t("browserSettingsIntro")}</p>
      </header>
      <div className="browser-settings-card browser-settings-main-card">
        <div className="browser-settings-control">
          <div>
            <strong>{t("browserControl")}</strong>
            <p>{t("browserControlHint")}</p>
          </div>
          <Switch
            label={t("browserControl")}
            isLabelHidden
            size="sm"
            value={config.control}
            isDisabled={pending}
            onChange={(control: boolean) => void save({ control })}
          />
        </div>
        <div className="browser-settings-default">
          <div>
            <label htmlFor="browser-default">{t("browserDefault")}</label>
            <p>{t("browserDefaultHint")}</p>
          </div>
          <select
            id="browser-default"
            value={config.defaultBrowser}
            disabled={pending}
            onChange={(event) =>
              void save({ defaultBrowser: event.target.value as BrowserId })
            }
          >
            {BROWSER_IDS.map((id) => (
              <option value={id} key={id} disabled={!allowed(id)}>
                {name(id)}
                {!allowed(id) ? ` · ${t("browserBlocked")}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!allowed(config.defaultBrowser) && (
        <p className="browser-settings-warning" role="status">
          {t("browserDefaultBlocked")}
        </p>
      )}
      <div className="browser-settings-section-heading">
        <h3>{t("browserAllowedTitle")}</h3>
        <span>{!config.control && t("browserOffHint")}</span>
      </div>
      <div className="browser-settings-card">
        {row("embedded")}
        {row("chrome")}
        <details className="browser-settings-more">
          <summary>
            <ChevronRight />
            {t("browserMore")}
          </summary>
          {EXTERNAL_BROWSERS.filter((id) => id !== "chrome").map(row)}
        </details>
      </div>
      <p className="browser-settings-example">{t("browserSpeakHint")}</p>
      {guide !== undefined && (
        <section
          ref={guideElement}
          className="browser-settings-guide"
          aria-label={t("browserGuideTitle", { browser: name(guide) })}
        >
          <div className="browser-settings-guide-heading">
            <div>
              <span>
                {t(
                  guideConnected
                    ? "browserConnectionTitle"
                    : "browserGuideEyebrow",
                )}
              </span>
              <h3>{t("browserGuideTitle", { browser: name(guide) })}</h3>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("browserCloseGuide")}
              onClick={() => setGuide(undefined)}
            >
              <X />
            </button>
          </div>
          {guideConnected ? (
            <>
              <p className="browser-settings-ready">
                <CheckCircle2 />
                {t("browserConnectionReady")}
              </p>
              <p>
                {guide === "embedded"
                  ? t("browserEmbeddedDetail")
                  : t("browserExternalDetail", { browser: name(guide) })}
              </p>
              <div className="browser-settings-guide-actions">
                <button
                  type="button"
                  className="browser-settings-button"
                  disabled={pending}
                  onClick={() =>
                    void action(
                      guide === "embedded" ? currentProfile!.browser : guide,
                      "manage",
                    )
                  }
                >
                  {t("browserManageExtension")}
                  <ExternalLink />
                </button>
                {(!allowed(guide) || !config.control) && (
                  <button
                    type="button"
                    className="browser-settings-primary"
                    disabled={pending}
                    onClick={() =>
                      void save({ control: true, ...allowPatch(guide, true) })
                    }
                  >
                    {t("browserAllowUse")}
                  </button>
                )}
                {allowed(guide) && config.defaultBrowser !== guide && (
                  <button
                    type="button"
                    className="browser-settings-button"
                    disabled={pending}
                    onClick={() => void save({ defaultBrowser: guide })}
                  >
                    {t("browserMakeDefault")}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              {guide === "embedded" && (
                <label className="browser-settings-install-browser">
                  {t("browserInstallIn")}
                  <select
                    value={installer}
                    disabled={pending}
                    onChange={(event) => {
                      setInstaller(event.target.value as ExternalBrowser);
                      setOpened(false);
                    }}
                  >
                    {EXTERNAL_BROWSERS.map((id) => (
                      <option key={id} value={id}>
                        {names[id]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ol className="browser-settings-steps">
                <li>
                  <span className="browser-settings-step">1</span>
                  <div>
                    <strong>{t("browserInstallTitle")}</strong>
                    <p>
                      {t(
                        installed
                          ? "browserInstallHint"
                          : "browserInstallBrowserFirst",
                        { browser: names[installer] },
                      )}
                    </p>
                    <button
                      type="button"
                      className="browser-settings-button"
                      disabled={pending || !installed}
                      onClick={() => void action(installer, "install")}
                    >
                      {t(
                        opened ? "browserReopenInstall" : "browserOpenInstall",
                      )}
                      <ExternalLink />
                    </button>
                  </div>
                </li>
                <li>
                  <span className="browser-settings-step">2</span>
                  <div>
                    <strong>{t("browserConnectTitle")}</strong>
                    <p>
                      {t("browserConnectHint", { browser: names[installer] })}
                    </p>
                    <button
                      type="button"
                      className="browser-settings-button"
                      disabled={pending || !installed}
                      onClick={() => void action(installer, "connect")}
                    >
                      {t("browserOpenIn", { browser: names[installer] })}
                      <ExternalLink />
                    </button>
                  </div>
                </li>
                <li>
                  <span className="browser-settings-step">3</span>
                  <div>
                    <strong>{t("browserAllowTitle")}</strong>
                    <p>{t("browserAllowHint")}</p>
                    <button
                      type="button"
                      className="browser-settings-primary"
                      disabled={pending || checking}
                      onClick={async () => {
                        setChecking(true);
                        const next = await refresh();
                        if (mounted.current) {
                          setChecking(false);
                          const connected = next?.profiles.some(
                            (profile) =>
                              profile.connected &&
                              profile.version === next.extensionVersion &&
                              (guide === "embedded"
                                ? profile.current
                                : profile.browser === guide),
                          );
                          setNotice(
                            t(
                              connected
                                ? "browserConnectionReady"
                                : "browserNotConnectedYet",
                            ),
                          );
                        }
                      }}
                    >
                      <RefreshCw className={checking ? "settings-spin" : ""} />
                      {t("browserCheck")}
                    </button>
                  </div>
                </li>
              </ol>
            </>
          )}
          <details className="browser-settings-help">
            <summary>
              <ChevronDown />
              {t("browserHelp")}
            </summary>
            <p>{t("browserReloadHint")}</p>
            <div className="browser-settings-path">
              <code>{status.extensionPath}</code>
              <button
                type="button"
                className="icon-button"
                aria-label={t("browserCopyPath")}
                onClick={async () =>
                  setCopied(await copyText(status.extensionPath))
                }
              >
                {copied ? <Check /> : <Copy />}
              </button>
            </div>
            <p>{t("browserSupportedHint")}</p>
          </details>
        </section>
      )}
      {error && (
        <div className="browser-settings-error" role="alert">
          {error}
          <button type="button" onClick={() => void refresh()}>
            {t("browserCheck")}
          </button>
        </div>
      )}
      <div
        className="browser-settings-feedback"
        role="status"
        aria-live="polite"
      >
        {pending ? t("browserSaving") : notice}
      </div>
    </div>
  );
}
