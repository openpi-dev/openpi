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

// Fixed resource bound, not a persisted user preference.
const MAX_PAGES = 8;

function DirectBrowserPage({ onTitle }: { onTitle: (title: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState({
    history: [] as string[],
    index: -1,
    revision: 0,
    loaded: false,
    unknown: false,
  });
  const url = page.history[page.index];

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
          disabled={page.unknown || page.index <= 0}
          onClick={() => navigate(page.history, page.index - 1)}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("browserForward")}
          title={t("browserForward")}
          disabled={page.unknown || page.index >= page.history.length - 1}
          onClick={() => navigate(page.history, page.index + 1)}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t("browserReload")}
          title={t("browserReload")}
          disabled={!url}
          onClick={() => navigate(page.history, page.index)}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <input
          aria-label={t("browserAddress")}
          title={t("browserEnteredAddress")}
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
          disabled={!url || page.unknown}
          onClick={() =>
            url && window.open(url, "_blank", "noopener,noreferrer")
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
        {page.unknown && (
          <p className="browser-notice" role="status">
            {t("browserLocationUnknown")}
          </p>
        )}
      </div>
      <div className="browser-direct-viewport">
        {url ? (
          <iframe
            key={page.revision}
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
      <p className="browser-notice">{t("browserDirectHint")}</p>
    </div>
  );
}

export function BrowserPanel() {
  const { t } = useTranslation();
  const prefix = useId();
  const nextId = useRef(1);
  const [tabs, setTabs] = useState([{ id: 0, title: "" }]);
  const [selected, setSelected] = useState(0);
  const focusTab = (id: number) => {
    requestAnimationFrame(() =>
      document.getElementById(`${prefix}-tab-${id}`)?.focus(),
    );
  };
  const close = (id: number) => {
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
          onClick={() => {
            if (tabs.length >= MAX_PAGES) return;
            const tab = { id: nextId.current++, title: "" };
            setTabs((current) => [...current, tab]);
            setSelected(tab.id);
            focusTab(tab.id);
          }}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
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
