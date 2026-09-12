import { FileText, Puzzle, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { WebCommandSummary } from "../../../../protocol/types.ts";
import type { CommandDiscoveryState } from "../../store/web-store.ts";

interface SlashCommandMenuProps {
  activeIndex: number;
  commandDiscovery: CommandDiscoveryState;
  commands: WebCommandSummary[];
  draft: boolean;
  preferBelow: boolean;
  onComplete: (command: WebCommandSummary) => void;
  onSelect: (index: number) => void;
}

export const slashCommandListId = "openpi-slash-command-list";

export function slashCommandOptionId(index: number) {
  return `openpi-slash-command-${index}`;
}

export function filterWebCommands(
  commands: readonly WebCommandSummary[],
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = normalized
    ? commands.filter((command) =>
        [command.name, command.description, command.source].some((value) =>
          value?.toLocaleLowerCase().includes(normalized),
        ),
      )
    : [...commands];

  return [
    ...matches.filter((command) => command.availability === "available"),
    ...matches.filter((command) => command.availability === "unsupported"),
  ];
}

function SourceIcon({ source }: Pick<WebCommandSummary, "source">) {
  if (source === "extension") return <Puzzle />;
  if (source === "prompt") return <FileText />;
  return <Sparkles />;
}

export function SlashCommandMenu(props: SlashCommandMenuProps) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = menu.current;
    const composer = element?.parentElement;
    if (!element || !composer || !props.preferBelow) return;

    const placeMenu = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportBottom = viewportTop + viewportHeight;
      const composerRect = composer.getBoundingClientRect();
      const gap = 8;
      const viewportMargin = 12;
      const availableBelow = Math.max(
        0,
        viewportBottom - composerRect.bottom - gap - viewportMargin,
      );
      const availableAbove = Math.max(
        0,
        composerRect.top - viewportTop - gap - viewportMargin,
      );
      const desiredHeight = Math.min(
        element.scrollHeight,
        224,
        viewportHeight * 0.32,
      );
      const placement =
        availableBelow >= desiredHeight || availableBelow >= availableAbove
          ? "below"
          : "above";
      const availableHeight =
        placement === "below" ? availableBelow : availableAbove;

      element.dataset.placement = placement;
      element.style.setProperty(
        "--slash-command-available-height",
        `${Math.floor(availableHeight)}px`,
      );
    };

    placeMenu();
    const resizeObserver = new ResizeObserver(placeMenu);
    resizeObserver.observe(element);
    resizeObserver.observe(composer);
    window.addEventListener("resize", placeMenu);
    window.visualViewport?.addEventListener("resize", placeMenu);
    window.visualViewport?.addEventListener("scroll", placeMenu);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", placeMenu);
      window.visualViewport?.removeEventListener("resize", placeMenu);
      window.visualViewport?.removeEventListener("scroll", placeMenu);
    };
  }, [props.preferBelow]);

  const activeCommand = props.commands[props.activeIndex];
  useEffect(() => {
    if (!activeCommand) return;
    const option = menu.current?.querySelector<HTMLElement>(
      `[data-command-index="${props.activeIndex}"]`,
    );
    option?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeCommand, props.activeIndex]);

  if (props.draft) {
    return (
      <div
        ref={menu}
        className="slash-command-menu slash-command-state"
        role="status"
      >
        {t("commandSessionRequired")}
      </div>
    );
  }
  if (
    props.commandDiscovery.status === "idle" ||
    props.commandDiscovery.status === "loading"
  ) {
    return (
      <div
        ref={menu}
        className="slash-command-menu slash-command-state"
        role="status"
      >
        {t("commandsLoading")}
      </div>
    );
  }
  if (props.commandDiscovery.status === "error") {
    return (
      <div
        ref={menu}
        className="slash-command-menu slash-command-state"
        role="alert"
      >
        <strong>{t("commandsUnavailable")}</strong>
        <span>{props.commandDiscovery.error}</span>
      </div>
    );
  }
  if (
    props.commandDiscovery.status === "ready" &&
    props.commands.length === 0
  ) {
    return (
      <div
        ref={menu}
        className="slash-command-menu slash-command-state"
        role="status"
      >
        {t("commandsNoMatch")}
      </div>
    );
  }

  return (
    <div ref={menu} className="slash-command-menu">
      <div id={slashCommandListId} role="listbox" aria-label={t("commands")}>
        {props.commands.map((command, index) => {
          const unsupported = command.availability === "unsupported";
          return (
            <button
              key={`${command.source}:${command.name}`}
              id={slashCommandOptionId(index)}
              data-command-index={index}
              className="slash-command-option"
              type="button"
              role="option"
              aria-selected={index === props.activeIndex}
              aria-disabled={unsupported}
              disabled={unsupported}
              onMouseEnter={() => props.onSelect(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onComplete(command)}
            >
              <span className="slash-command-icon">
                <SourceIcon source={command.source} />
              </span>
              <span className="slash-command-copy">
                <span className="slash-command-heading">
                  <strong>/{command.name}</strong>
                  <span>{t(`commandSource_${command.source}`)}</span>
                </span>
                {command.description && <span>{command.description}</span>}
              </span>
              <span className="slash-command-support">
                {unsupported
                  ? t("commandUnsupported")
                  : command.argumentHint
                    ? t("commandAcceptsArguments")
                    : null}
              </span>
            </button>
          );
        })}
      </div>
      {props.commandDiscovery.commandsOmitted > 0 && (
        <div className="slash-command-bounded" role="status">
          {t("commandsBounded", {
            count: props.commandDiscovery.commandsOmitted,
          })}
        </div>
      )}
    </div>
  );
}
