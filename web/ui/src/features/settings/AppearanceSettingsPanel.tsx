import { Dialog } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Slider } from "@astryxdesign/core/Slider";
import { Switch } from "@astryxdesign/core/Switch";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useTheme } from "@astryxdesign/core/theme";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebAppearancePreference,
  WebSettingsCatalog,
  WebSettingsPreferencesPatch,
  WebThemePreference,
} from "../../../../protocol/types.ts";
import { copyText } from "../../lib/clipboard.ts";
import {
  appearanceColors,
  appearanceFonts as fonts,
  appearanceMode,
  appearanceModes as modes,
  appearancePalette,
  appearancePalettes as palettes,
  defaultAppearance as defaults,
  parseAppearanceTheme,
} from "./appearance.ts";

const accents = ["", "#2563EB", "#7C3AED", "#DB2777", "#D97706", "#16A34A"];

function AppearanceMenu({
  label,
  value,
  options,
  disabled,
  onSelect,
}: {
  label: string;
  value: string;
  options: { id: string; label: string; color?: string }[];
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const selected = options.find((option) => option.id === value);
  return (
    <DropdownMenu
      button={{
        label: selected?.label ?? value,
        "aria-label": label,
        variant: "secondary",
        size: "sm",
        className: "appearance-menu-trigger",
        isDisabled: disabled,
        ...(selected?.color
          ? {
              icon: (
                <span
                  className="appearance-color-dot"
                  style={{ background: selected.color }}
                />
              ),
            }
          : {}),
      }}
      menuWidth={200}
      alignment="end"
      items={options.map((option) => ({
        id: option.id || "default",
        label: option.label,
        isDisabled: disabled,
        ...(option.color
          ? {
              icon: (
                <span
                  className="appearance-color-dot"
                  style={{ background: option.color }}
                />
              ),
            }
          : {}),
        endContent:
          value === option.id ? <Check aria-hidden="true" /> : undefined,
        onClick: () => onSelect(option.id),
      }))}
    />
  );
}

function AppearanceColor({
  label,
  value,
  fallback,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onSave: (color: string) => Promise<boolean>;
}) {
  const saved = (value || fallback).toUpperCase();
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const save = (color: string) => {
    setDraft(color);
    if (color !== saved && /^#[0-9a-f]{6}$/iu.test(color))
      void onSave(color).then((ok) => {
        if (!ok) setDraft(saved);
      });
  };
  return (
    <div className="appearance-color-input">
      <label className="appearance-color-picker">
        <span className="appearance-color-dot" style={{ background: saved }} />
        <input
          aria-label={`${label} — ${saved}`}
          type="color"
          value={saved}
          disabled={disabled}
          onChange={(event) => save(event.target.value.toUpperCase())}
        />
      </label>
      <input
        className="appearance-color-hex"
        type="text"
        aria-label={label}
        value={draft}
        maxLength={7}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => save(event.target.value.toUpperCase())}
        onBlur={() => setDraft(saved)}
      />
    </div>
  );
}

export function AppearanceSettingsPanel({
  catalog,
  theme,
  pending,
  error,
  onRefresh,
  onUpdatePreferences,
}: {
  catalog: WebSettingsCatalog | null;
  theme: WebThemePreference;
  pending: boolean;
  error: string | null;
  onRefresh: () => void;
  onUpdatePreferences: (patch: WebSettingsPreferencesPatch) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { mode: resolvedMode } = useTheme();
  const setup = catalog?.setup;
  const savedTheme = setup?.ui.webTheme ?? theme;
  const appearance = setup?.ui.webAppearance ?? defaults;
  const palette = appearancePalette(savedTheme, appearance);
  const mode = appearanceMode(savedTheme);
  const [advanced, setAdvanced] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"saved" | "failed" | null>(null);
  const [chatWidth, setChatWidth] = useState(setup?.ui.webChatWidth ?? 820);
  const [fontSize, setFontSize] = useState(setup?.ui.webChatFontSize ?? 14);
  useEffect(() => {
    if (!setup) return;
    setChatWidth(setup.ui.webChatWidth);
    setFontSize(setup.ui.webChatFontSize);
  }, [setup]);
  const unreadable =
    catalog?.setupWritable === false ||
    !!catalog?.resources.diagnostics.settingsErrors;
  const disabled = pending || !setup || !!error || unreadable;
  const parsedImport = parseAppearanceTheme(importValue);
  const saveAppearance = (patch: Partial<WebAppearancePreference>) =>
    onUpdatePreferences({ appearance: patch });
  const closeImport = () => {
    if (pending) return;
    setImportOpen(false);
    setImportValue("");
    setImportError(false);
  };
  const dark =
    mode === "dark" || (mode === "system" && resolvedMode === "dark");
  const fallback = appearanceColors(palette, dark);

  return (
    <section className="settings-content-page settings-appearance-panel">
      <h1>{t("appearance")}</h1>
      {(!setup || error || unreadable) && (
        <div
          className="settings-load-state"
          role={error || unreadable ? "alert" : "status"}
        >
          <RefreshCw aria-hidden="true" />
          <span>
            {t(
              unreadable
                ? "configurationReadFailure"
                : error
                  ? "settingsCatalogFailed"
                  : "settingsCatalogLoading",
            )}
          </span>
          {(error || unreadable) && (
            <button type="button" onClick={onRefresh}>
              {t("retryAdmissionCheck")}
            </button>
          )}
        </div>
      )}
      <section
        className="appearance-section"
        aria-labelledby="appearance-visual-title"
      >
        <h2 id="appearance-visual-title">{t("appearanceVisualStyle")}</h2>
        <div className="appearance-card appearance-mode-row">
          <span>{t("appearanceMode")}</span>
          <div
            role="radiogroup"
            aria-label={t("appearanceMode")}
            className="appearance-mode-options"
          >
            {modes.map((id) => (
              <Tooltip
                key={id}
                content={t(
                  id === "system"
                    ? "themeSystem"
                    : id === "light"
                      ? "themeLight"
                      : "themeDark",
                )}
              >
                <label className="appearance-mode-option">
                  <input
                    type="radio"
                    name="openpi-appearance-mode"
                    aria-label={t(
                      id === "system"
                        ? "themeSystem"
                        : id === "light"
                          ? "themeLight"
                          : "themeDark",
                    )}
                    checked={mode === id}
                    disabled={disabled}
                    onChange={() => void onUpdatePreferences({ theme: id })}
                  />
                  <span
                    aria-hidden="true"
                    className="appearance-mode-preview"
                    data-mode={id}
                    data-selected={mode === id}
                  >
                    <span className="appearance-mini-window">
                      <span className="appearance-mini-sidebar" />
                      <span className="appearance-mini-chat">
                        <i />
                        <i />
                        <b />
                        <i />
                        <b />
                        <em />
                      </span>
                    </span>
                    {id === "system" && (
                      <span className="appearance-mini-window appearance-mini-dark">
                        <span className="appearance-mini-sidebar" />
                        <span className="appearance-mini-chat">
                          <i />
                          <i />
                          <b />
                          <i />
                          <b />
                          <em />
                        </span>
                      </span>
                    )}
                  </span>
                </label>
              </Tooltip>
            ))}
          </div>
        </div>
        <div className="appearance-card">
          <div className="appearance-row appearance-theme-row">
            <span>{t("appearanceTheme")}</span>
            <div className="appearance-theme-actions">
              <Tooltip content={t("appearanceImport")}>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("appearanceImport")}
                  disabled={disabled}
                  onClick={() => {
                    setImportError(false);
                    setImportOpen(true);
                  }}
                >
                  <Download aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip content={t("appearanceCopy")}>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("appearanceCopy")}
                  disabled={disabled}
                  onClick={() => {
                    void copyText(
                      JSON.stringify({
                        version: 1,
                        theme: mode,
                        appearance: { ...appearance, palette },
                      }),
                    ).then((ok) => setCopyStatus(ok ? "saved" : "failed"));
                  }}
                >
                  <Copy aria-hidden="true" />
                </button>
              </Tooltip>
              <AppearanceMenu
                label={t("appearanceTheme")}
                value={palette}
                options={palettes.map((id) => ({
                  id,
                  label:
                    id === "default"
                      ? "OpenPI"
                      : t(`theme${id[0]!.toUpperCase()}${id.slice(1)}`),
                }))}
                disabled={disabled}
                onSelect={(id) => {
                  const next = palettes.find((item) => item === id);
                  if (next) void saveAppearance({ palette: next });
                }}
              />
            </div>
          </div>
          <div className="appearance-row">
            <span>{t("appearanceAccent")}</span>
            <div className="appearance-accent-controls">
              <AppearanceMenu
                label={t("appearanceAccent")}
                value={appearance.accent}
                options={accents.map((color, index) => ({
                  id: color,
                  label: t(`appearanceAccent${index}`),
                  color: color || "var(--text)",
                }))}
                disabled={disabled}
                onSelect={(accent) => void saveAppearance({ accent })}
              />
              <AppearanceColor
                label={t("appearanceCustomAccent")}
                value={appearance.accent}
                fallback="#2563EB"
                disabled={disabled}
                onSave={(accent) => saveAppearance({ accent })}
              />
            </div>
          </div>
          <div className="appearance-row">
            <span>{t("appearanceBackground")}</span>
            <AppearanceColor
              label={t("appearanceBackground")}
              value={appearance.background}
              fallback={fallback.background}
              disabled={disabled}
              onSave={(background) => saveAppearance({ background })}
            />
          </div>
          <div className="appearance-row">
            <span>{t("appearanceForeground")}</span>
            <AppearanceColor
              label={t("appearanceForeground")}
              value={appearance.foreground}
              fallback={fallback.foreground}
              disabled={disabled}
              onSave={(foreground) => saveAppearance({ foreground })}
            />
          </div>
          <div className="appearance-row">
            <span>{t("appearanceFont")}</span>
            <AppearanceMenu
              label={t("appearanceFont")}
              value={appearance.font === "system" ? "codex" : appearance.font}
              options={fonts.map((id) => ({
                id,
                label: t(`appearanceFont_${id}`),
              }))}
              disabled={disabled}
              onSelect={(id) => {
                const font = fonts.find((item) => item === id);
                if (font) void saveAppearance({ font });
              }}
            />
          </div>
        </div>
        {copyStatus && (
          <p
            role={copyStatus === "failed" ? "alert" : "status"}
            className="appearance-share-status"
          >
            {t(
              copyStatus === "saved"
                ? "appearanceCopied"
                : "appearanceCopyFailed",
            )}
          </p>
        )}
      </section>
      <section className="appearance-section">
        <button
          type="button"
          className="appearance-advanced-toggle"
          aria-expanded={advanced}
          aria-controls="appearance-advanced"
          onClick={() => setAdvanced(!advanced)}
        >
          {t("appearanceAdvanced")}
          {advanced ? (
            <ChevronDown aria-hidden="true" />
          ) : (
            <ChevronRight aria-hidden="true" />
          )}
        </button>
        {advanced && setup && (
          <div
            id="appearance-advanced"
            className="appearance-card appearance-advanced-content"
          >
            <div className="appearance-row">
              <span>{t("expandThinkingByDefault")}</span>
              <Switch
                label={t("expandThinkingByDefault")}
                isLabelHidden
                value={setup.ui.webExpandThinking}
                size="sm"
                isDisabled={disabled}
                onChange={(expandThinking: boolean) =>
                  void onUpdatePreferences({ expandThinking })
                }
              />
            </div>
            <div className="appearance-slider-row">
              <div className="settings-slider-heading">
                <span>{t("chatContentWidth")}</span>
                <output>{chatWidth}px</output>
                <button
                  type="button"
                  className="settings-reset-button"
                  aria-label={t("resetChatContentWidth")}
                  disabled={disabled || chatWidth === 820}
                  onClick={() => {
                    setChatWidth(820);
                    void onUpdatePreferences({ chatWidth: 820 }).then((ok) => {
                      if (!ok) setChatWidth(setup.ui.webChatWidth);
                    });
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              </div>
              <Slider
                label={t("chatContentWidth")}
                isLabelHidden
                value={chatWidth}
                min={820}
                max={2000}
                step={10}
                width="100%"
                valueDisplay="none"
                isDisabled={disabled}
                onChange={(value: number) => setChatWidth(value)}
                onChangeEnd={(value: number) => {
                  if (value !== setup.ui.webChatWidth)
                    void onUpdatePreferences({ chatWidth: value }).then(
                      (ok) => {
                        if (!ok) setChatWidth(setup.ui.webChatWidth);
                      },
                    );
                }}
              />
            </div>
            <div className="appearance-slider-row">
              <div className="settings-slider-heading">
                <span>{t("chatFontSize")}</span>
                <output>{fontSize}px</output>
                <button
                  type="button"
                  className="settings-reset-button"
                  aria-label={t("resetChatFontSize")}
                  disabled={disabled || fontSize === 14}
                  onClick={() => {
                    setFontSize(14);
                    void onUpdatePreferences({ chatFontSize: 14 }).then(
                      (ok) => {
                        if (!ok) setFontSize(setup.ui.webChatFontSize);
                      },
                    );
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              </div>
              <Slider
                label={t("chatFontSize")}
                isLabelHidden
                value={fontSize}
                min={12}
                max={24}
                step={1}
                width="100%"
                valueDisplay="none"
                isDisabled={disabled}
                onChange={(value: number) => setFontSize(value)}
                onChangeEnd={(value: number) => {
                  if (value !== setup.ui.webChatFontSize)
                    void onUpdatePreferences({ chatFontSize: value }).then(
                      (ok) => {
                        if (!ok) setFontSize(setup.ui.webChatFontSize);
                      },
                    );
                }}
              />
            </div>
            <div className="appearance-row">
              <span>{t("appearanceReset")}</span>
              <button
                type="button"
                className="appearance-reset"
                disabled={disabled}
                onClick={() =>
                  void onUpdatePreferences({
                    theme: "system",
                    appearance: defaults,
                    chatWidth: 820,
                    chatFontSize: 14,
                    expandThinking: false,
                  })
                }
              >
                <RotateCcw aria-hidden="true" />
                {t("appearanceResetAction")}
              </button>
            </div>
          </div>
        )}
      </section>
      <Dialog
        isOpen={importOpen}
        onOpenChange={(open: boolean) => {
          if (!open) closeImport();
        }}
        aria-label={t("appearanceImport")}
        width={480}
        className="appearance-import-dialog"
      >
        <h2 className="appearance-import-title">{t("appearanceImport")}</h2>
        <form
          className="appearance-import-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsedImport || disabled) return;
            setImportError(false);
            void onUpdatePreferences(parsedImport).then((ok) => {
              if (ok) {
                setImportOpen(false);
                setImportValue("");
              } else setImportError(true);
            });
          }}
        >
          <label>
            {t("appearanceThemeValue")}
            <textarea
              maxLength={2000}
              value={importValue}
              disabled={pending}
              placeholder={t("appearanceImportPlaceholder")}
              onChange={(event) => {
                setImportError(false);
                setImportValue(event.target.value);
              }}
            />
          </label>
          {importValue && !parsedImport && (
            <p role="alert">{t("appearanceImportInvalid")}</p>
          )}
          {importError && (
            <p role="alert">{t("settingsPreferencesSaveFailed")}</p>
          )}
          <div className="appearance-import-actions">
            <button type="button" disabled={pending} onClick={closeImport}>
              {t("cancel")}
            </button>
            <button type="submit" disabled={disabled || !parsedImport}>
              {t(pending ? "savingSettings" : "appearanceImportAction")}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
