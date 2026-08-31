import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startsAtReferenceBoundary } from "./syntax.ts";

const SKILL_COMMAND_PREFIX = "skill:";
const INLINE_SKILL_REFERENCE = /\$([^\s$]*)$/;

// Adapted from bkyssn's PR #321. Pi remains the only Skill registry, and
// candidates are read from its live command projection on every request.
function inlineSkillSuggestions(pi: ExtensionAPI, prefix: string) {
  const namePrefix = prefix.slice(1);
  return pi
    .getCommands()
    .filter(
      (command) =>
        command.source === "skill" &&
        command.name.startsWith(SKILL_COMMAND_PREFIX),
    )
    .map((command) => ({
      name: command.name.slice(SKILL_COMMAND_PREFIX.length),
      description: command.description,
    }))
    .filter((skill) => skill.name.startsWith(namePrefix))
    .map((skill) => ({
      value: `$${skill.name}`,
      label: `$${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
    }));
}

export function registerInlineSkillAutocomplete(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => {
      // Only our exact suggestion objects use our insertion semantics. All
      // foreign candidates continue through the existing provider unchanged.
      const ownItems = new WeakSet<object>();
      return {
        triggerCharacters: [
          ...new Set([...(current.triggerCharacters ?? []), "$"]),
        ],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const beforeCursor = lines
            .slice(0, cursorLine)
            .concat((lines[cursorLine] ?? "").slice(0, cursorCol))
            .join("\n");
          const match = INLINE_SKILL_REFERENCE.exec(beforeCursor);
          if (!match || !startsAtReferenceBoundary(beforeCursor, match.index)) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          }
          const prefix = `$${match[1] ?? ""}`;
          const items = inlineSkillSuggestions(pi, prefix);
          for (const item of items) ownItems.add(item);
          return items.length > 0 ? { prefix, items } : null;
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          if (!ownItems.has(item))
            return current.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          const line = lines[cursorLine] ?? "";
          const start = cursorCol - prefix.length;
          const next = [...lines];
          next[cursorLine] =
            line.slice(0, start) + item.value + line.slice(cursorCol);
          return {
            lines: next,
            cursorLine,
            cursorCol: start + item.value.length,
          };
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true
          );
        },
      };
    });
  });
}
