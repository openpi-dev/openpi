import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { browserAddress } from "./browser-address.ts";
import { useBrowserBridge } from "./browser-bridge.ts";

// Fixed resource bound, not a persisted user preference.
const MAX_PAGES = 8;

function DirectBrowserPage({
  onTitle,
  onOpen,
  initialUrl = "",
}: {
  onTitle: (title: string) => void;
  onOpen: (url: string) => void;
  initialUrl?: string;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const addressInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState({
    history: initialUrl ? [initialUrl] : [],
    index: initialUrl ? 0 : -1,
    revision: 0,
    loaded: false,
    unknown: false,
  });
  const url = page.history[page.index];
  const pageId = `${prefix}-${page.revision}`;
  const bridge = useBrowserBridge(
    pageId,
    (state) => {
      if (document.activeElement !== addressInput.current) setDraft(state.url);
      onTitle(state.title || new URL(state.url).host);
    },
    onOpen,
  );
  const currentUrl = bridge.page?.url ?? url;

  const navigate = (history: string[], index: number) => {
    const next = history[index];
    if (!next) return;
    setPage((current) => ({
      history,
      index,
      revision: current.revision + 1,
      loaded: false,
      unknown: false,
    }));
    setDraft(next);
    setError(null);
    onTitle(new URL(next).host);
  };

  return (
    <div className="browser-tool browser-direct-tool">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const next = browserAddress(draft, window.location.origin);
          if (!next) {
            setError(t("browserAddressNotAllowed"));
            return;
          }
          if (next === url) navigate(page.history, page.index);
          else {
            const history = [
              ...page.history.slice(0, page.index + 1),
              next,
            ].slice(-64);
            navigate(history, history.length - 1);
          }
        }}
      >
        <button
          type="button"
          aria-label={t("browserBack")}
          title={t("browserBack")}
          disabled={
            bridge.page
              ? !bridge.page.canGoBack
              : page.unknown || page.index <= 0
          }
          onClick={() =>
            bridge.page
              ? bridge.command("back")
              : navigate(page.history, page.index - 1)
          }
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("browserForward")}
          title={t("browserForward")}
          disabled={
            bridge.page
              ? !bridge.page.canGoForward
              : page.unknown || page.index >= page.history.length - 1
          }
          onClick={() =>
            bridge.page
              ? bridge.command("forward")
              : navigate(page.history, page.index + 1)
          }
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("browserReload")}
          title={t("browserReload")}
          disabled={!url}
          onClick={() =>
            bridge.page
              ? bridge.command("reload")
              : navigate(page.history, page.index)
          }
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <input
          ref={addressInput}
          aria-label={t("browserAddress")}
          title={t(bridge.page ? "browserAddress" : "browserEnteredAddress")}
          value={draft}
          placeholder="https://"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
        <button
          type="submit"
          aria-label={t("browserGo")}
          title={t("browserGo")}
          disabled={!draft.trim()}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("openExternalBrowser")}
          title={t("openExternalBrowser")}
          disabled={!currentUrl || (!bridge.page && page.unknown)}
          onClick={() =>
            currentUrl &&
            window.open(currentUrl, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink aria-hidden="true" />
        </button>
      </form>
      <div className="browser-feedback">
        {error && (
          <p className="workbar-error" role="alert">
            {error}
          </p>
        )}
        {page.unknown && !bridge.page && (
          <p className="browser-notice" role="status">
            {t("browserLocationUnknown")}
          </p>
        )}
      </div>
      <div className="browser-direct-viewport">
        {url ? (
          <iframe
            key={page.revision}
            data-openpi-browser-page={pageId}
            src={url}
            title={t("browserPageTitle", { address: new URL(url).host })}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            onLoad={() =>
              setPage((current) =>
                current.revision !== page.revision
                  ? current
                  : {
                      ...current,
                      loaded: true,
                      unknown: current.loaded,
                    },
              )
            }
          />
        ) : (
          <div className="workbar-empty">
            <Globe2 aria-hidden="true" />
            <strong>{t("browserReady")}</strong>
            <p>{t("browserDirectDescription")}</p>
          </div>
        )}
      </div>
      <p className="browser-notice">
        {t(bridge.ready ? "browserEnhancedHint" : "browserDirectHint")}
      </p>
    </div>
  );
}

export function BrowserPanel() {
  const { t } = useTranslation();
  const prefix = useId();
  const nextId = useRef(1);
  const [tabs, setTabs] = useState<
    { id: number; title: string; initialUrl?: string }[]
  >([{ id: 0, title: "" }]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [blockedUrl, setBlockedUrl] = useState<string>();
  const [selected, setSelected] = useState(0);
  const focusTab = (id: number) => {
    requestAnimationFrame(() =>
      document.getElementById(`${prefix}-tab-${id}`)?.focus(),
    );
  };
  const add = (url = "") => {
    if (tabsRef.current.length >= MAX_PAGES) {
      if (url) setBlockedUrl(url);
      return;
    }
    const tab = {
      id: nextId.current++,
      title: url ? new URL(url).host : "",
      initialUrl: url,
    };
    const next = [...tabsRef.current, tab];
    tabsRef.current = next;
    setTabs(next);
    setSelected(tab.id);
    setBlockedUrl(undefined);
    focusTab(tab.id);
  };
  const close = (id: number) => {
    setBlockedUrl(undefined);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (!remaining.length) {
      const blank = { id: nextId.current++, title: "" };
      setTabs([blank]);
      setSelected(blank.id);
      focusTab(blank.id);
    } else {
      setTabs(remaining);
      if (selected === id) {
        const index = tabs.findIndex((tab) => tab.id === id);
        const fallback = remaining[Math.min(index, remaining.length - 1)]!;
        setSelected(fallback.id);
        focusTab(fallback.id);
      }
    }
  };
  return (
    <div className="browser-workspace">
      <div className="browser-tabs-header">
        <div
          role="tablist"
          aria-label={t("browserTabs")}
          className="browser-tabs"
          onKeyDown={(event) => {
            if (
              !(event.target instanceof HTMLElement) ||
              event.target.getAttribute("role") !== "tab"
            )
              return;
            const targetId = event.target.id;
            const index = tabs.findIndex(
              (tab) => `${prefix}-tab-${tab.id}` === targetId,
            );
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft")
              next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = tabs.length - 1;
            else if (event.key === "Delete") {
              event.preventDefault();
              event.stopPropagation();
              close(tabs[index]!.id);
              return;
            } else return;
            event.preventDefault();
            event.stopPropagation();
            setSelected(tabs[next]!.id);
            focusTab(tabs[next]!.id);
          }}
        >
          {tabs.map((tab) => (
            <div
              className="browser-tab"
              key={tab.id}
              data-active={tab.id === selected}
            >
              <button
                type="button"
                role="tab"
                id={`${prefix}-tab-${tab.id}`}
                aria-selected={tab.id === selected}
                aria-controls={`${prefix}-page-${tab.id}`}
                tabIndex={tab.id === selected ? 0 : -1}
                onClick={() => setSelected(tab.id)}
              >
                <Globe2 aria-hidden="true" />
                <span>{tab.title || t("browserNewTab")}</span>
              </button>
              <button
                type="button"
                aria-label={t("browserCloseTab", {
                  title: tab.title || t("browserNewTab"),
                })}
                title={t("close")}
                onClick={() => close(tab.id)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="browser-add-tab"
          aria-label={t("browserAddTab")}
          title={
            tabs.length >= MAX_PAGES
              ? t("browserTabLimit", { count: MAX_PAGES })
              : t("browserAddTab")
          }
          disabled={tabs.length >= MAX_PAGES}
          onClick={() => add()}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {blockedUrl && (
        <p className="browser-notice" role="status">
          {t("browserTabLimit", { count: MAX_PAGES })} ·{" "}
          <a href={blockedUrl} target="_blank" rel="noopener noreferrer">
            {t("openExternalBrowser")}
          </a>
        </p>
      )}
      <div className="browser-pages">
        {tabs.map((tab) => (
          <div
            role="tabpanel"
            id={`${prefix}-page-${tab.id}`}
            aria-labelledby={`${prefix}-tab-${tab.id}`}
            className="browser-page"
            hidden={selected !== tab.id}
            key={tab.id}
          >
            <DirectBrowserPage
              initialUrl={tab.initialUrl}
              onOpen={add}
              onTitle={(title) =>
                setTabs((current) =>
                  current.map((item) =>
                    item.id === tab.id ? { ...item, title } : item,
                  ),
                )
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
