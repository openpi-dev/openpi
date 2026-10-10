import { Switch } from "@astryxdesign/core/Switch";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
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
  const [step, setStep] = useState(1);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
  const serial = useRef(0);
  const guideElement = useRef<HTMLElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A step change replaces the focused action; move focus to its new heading.
  useEffect(() => {
    if (guide) {
      guideElement.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
      stepHeading.current?.focus({ preventScroll: true });
    }
  }, [guide, step]);
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
    action: "folder" | "manage" | "connect",
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
        if (action === "folder") setNotice(t("browserFolderOpened"));
        return true;
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setPending(false);
    }
    return false;
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
    setStep(1);
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
          disabled={pending}
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
  const extensionPage = `${installer === "edge" ? "edge" : "chrome"}://extensions/`;
  const steps = [
    t("browserStepOpen"),
    t("browserDeveloperMode"),
    t("browserStepAdd"),
    t("browserStepConnect"),
  ];
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
              disabled={pending}
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
                      setStep(1);
                      setCopied(false);
                      setNotice(undefined);
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
              <ol
                className="browser-settings-progress"
                aria-label={t("browserSetupSteps")}
              >
                {steps.map((label, index) => (
                  <li key={label}>
                    <button
                      type="button"
                      aria-current={step === index + 1 ? "step" : undefined}
                      aria-label={t("browserStepLabel", {
                        step: index + 1,
                        label,
                      })}
                      disabled={pending}
                      onClick={() => {
                        setStep(index + 1);
                        setNotice(undefined);
                      }}
                    >
                      <span>{index + 1}</span>
                      {label}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="browser-settings-wizard" aria-live="polite">
                <span className="browser-settings-step-count">
                  {t("browserStepCount", { step, total: steps.length })}
                </span>
                <h4 ref={stepHeading} tabIndex={-1}>
                  {t(
                    step === 1
                      ? "browserOpenManagerTitle"
                      : step === 2
                        ? "browserDeveloperTitle"
                        : step === 3
                          ? "browserInstallTitle"
                          : "browserConnectTitle",
                    { browser: names[installer] },
                  )}
                </h4>
                <p>
                  {t(
                    step === 1
                      ? "browserOpenManagerHint"
                      : step === 2
                        ? "browserDeveloperHint"
                        : step === 3
                          ? "browserLoadHint"
                          : "browserConnectHint",
                    { browser: names[installer] },
                  )}
                </p>
                {step === 1 && (
                  <div className="browser-settings-address">
                    <BrowserMark browser={installer} />
                    <code>{extensionPage}</code>
                  </div>
                )}
                {(step === 2 || step === 3) && (
                  <figure
                    className={`browser-settings-illustration ${installer === "edge" ? "edge" : ""}`}
                  >
                    <figcaption>
                      {t("browserIllustration", { browser: names[installer] })}
                    </figcaption>
                    <div className="browser-settings-demo" aria-hidden="true">
                      <div className="browser-settings-demo-bar">
                        <i />
                        <i />
                        <i />
                        <code>{extensionPage}</code>
                      </div>
                      <div className="browser-settings-demo-heading">
                        <span>{t("browserExtensions")}</span>
                        <span
                          className={`browser-settings-demo-toggle ${step === 2 ? "highlight" : ""}`}
                        >
                          {t("browserDeveloperMode")}
                          <i />
                        </span>
                      </div>
                      <div className="browser-settings-demo-toolbar">
                        <span className={step === 3 ? "highlight" : ""}>
                          {t("browserLoadUnpacked")}
                        </span>
                        <i />
                        <i />
                      </div>
                    </div>
                  </figure>
                )}
                {step === 3 && (
                  <div className="browser-settings-folder">
                    <div className="browser-settings-folder-heading">
                      <FolderOpen />
                      <strong>browser-extension</strong>
                      <span>{t("browserFolderBundled")}</span>
                    </div>
                    <div className="browser-settings-path">
                      <code>{status.extensionPath}</code>
                    </div>
                    <div className="browser-settings-guide-actions">
                      <button
                        type="button"
                        className="browser-settings-button"
                        onClick={async () => {
                          const success = await copyText(status.extensionPath);
                          setCopied(success);
                          if (!success) setNotice(t("browserCopyFailed"));
                        }}
                      >
                        {copied ? <Check /> : <Copy />}
                        {t(copied ? "browserPathCopied" : "browserCopyPath")}
                      </button>
                      <button
                        type="button"
                        className="browser-settings-button"
                        disabled={pending}
                        onClick={() => void action(installer, "folder")}
                      >
                        <FolderOpen />
                        {t("browserOpenFolder")}
                      </button>
                    </div>
                    <p>
                      {t(
                        navigator.userAgent.includes("Mac")
                          ? "browserChooseFolderMac"
                          : "browserChooseFolderOther",
                      )}
                    </p>
                  </div>
                )}
                {step === 4 && (
                  <div className="browser-settings-waiting" role="status">
                    <RefreshCw />
                    <span>{t("browserWaiting")}</span>
                  </div>
                )}
                {!installed && (
                  <p className="browser-settings-warning">
                    {t("browserInstallBrowserFirst", {
                      browser: names[installer],
                    })}
                  </p>
                )}
                <div className="browser-settings-wizard-actions">
                  {step > 1 && (
                    <button
                      type="button"
                      className="browser-settings-button"
                      disabled={pending}
                      onClick={() => {
                        setStep(step - 1);
                        setNotice(undefined);
                      }}
                    >
                      <ArrowLeft />
                      {t("browserPreviousStep")}
                    </button>
                  )}
                  {step === 1 && (
                    <button
                      type="button"
                      className="browser-settings-text-button"
                      disabled={pending}
                      onClick={() => setStep(4)}
                    >
                      {t("browserAlreadyInstalled")}
                    </button>
                  )}
                  {step < 4 ? (
                    <button
                      type="button"
                      className="browser-settings-primary"
                      disabled={pending || !installed}
                      onClick={async () => {
                        if (
                          step === 2 ||
                          (await action(
                            installer,
                            step === 1 ? "manage" : "connect",
                          ))
                        )
                          setStep(step + 1);
                      }}
                    >
                      {t(
                        step === 1
                          ? "browserOpenManager"
                          : step === 2
                            ? "browserDeveloperDone"
                            : "browserInstalledConnect",
                        { browser: names[installer] },
                      )}
                      {step === 2 ? <ArrowRight /> : <ExternalLink />}
                    </button>
                  ) : (
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
                  )}
                </div>
                {step === 4 ? (
                  <div className="browser-settings-connect-help">
                    <p>{t("browserAllowHint")}</p>
                    <button
                      type="button"
                      className="browser-settings-text-button"
                      disabled={pending || !installed}
                      onClick={() => void action(installer, "connect")}
                    >
                      {t("browserOpenIn", { browser: names[installer] })}
                      <ExternalLink />
                    </button>
                  </div>
                ) : (
                  step > 1 && (
                    <button
                      type="button"
                      className="browser-settings-text-button"
                      disabled={pending || !installed}
                      onClick={() => void action(installer, "manage")}
                    >
                      {t("browserReopenManager")}
                      <ExternalLink />
                    </button>
                  )
                )}
              </div>
            </>
          )}
          <details className="browser-settings-help">
            <summary>
              <ChevronDown />
              {t("browserHelp")}
            </summary>
            <p>{t("browserReloadHint")}</p>
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
