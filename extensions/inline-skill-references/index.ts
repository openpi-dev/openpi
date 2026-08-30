import { readFile } from "node:fs/promises";
import {
  parseSkillBlock,
  stripFrontmatter,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const SKILL_COMMAND_PREFIX = "skill:";
const INLINE_SKILL_REFERENCE = /(?:^|[ \t])\$([^\s$]*)$/;
const SUBMITTED_INLINE_SKILL_REFERENCE = /(?:^|[ \t])\$([^\s]+)/gm;
const REFERENCE_TERMINATOR = /^(?:$|[^\p{L}\p{N}_$-])/u;

type LoadedSkill = NonNullable<
  BeforeAgentStartEvent["systemPromptOptions"]["skills"]
>[number];

/**
 * Pi owns the Skill registry. This adapter derives short-lived completion
 * candidates from its current slash-command projection on each request.
 */
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

function referencedSkills(prompt: string, skills: readonly LoadedSkill[]) {
  const selected = new Set<string>();
  const references: LoadedSkill[] = [];

  for (const match of prompt.matchAll(SUBMITTED_INLINE_SKILL_REFERENCE)) {
    const reference = match[1]!;
    const skill = skills.find(
      (candidate) =>
        reference.startsWith(candidate.name) &&
        REFERENCE_TERMINATOR.test(reference.slice(candidate.name.length)),
    );
    if (skill && !selected.has(skill.name)) {
      selected.add(skill.name);
      references.push(skill);
    }
  }

  return references;
}

/**
 * Mirror Pi's native Skill envelope while retaining Pi's turn-scoped Skill
 * projection as the only authority for which files may be read.
 */
function formatInlineSkillContent(skill: LoadedSkill, body: string) {
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

async function inlineSkillContent(skill: LoadedSkill) {
  const content = await readFile(skill.filePath, "utf8");
  return formatInlineSkillContent(skill, stripFrontmatter(content).trim());
}

export function createInlineSkillReferencesExtension() {
  return function inlineSkillReferences(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;

      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: ["$"],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
          const match = beforeCursor.match(INLINE_SKILL_REFERENCE);
          if (!match) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
          }

          const prefix = `$${match[1] ?? ""}`;
          const items = inlineSkillSuggestions(pi, prefix);
          return items.length > 0 ? { prefix, items } : null;
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
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
      }));
    });

    pi.on("before_agent_start", async (event) => {
      // Pi expands /skill:name before this hook. Its exported parser separates
      // the already-loaded native Skill body from the user's trailing arguments.
      const nativeSkill = parseSkillBlock(event.prompt);
      const userPrompt = nativeSkill ? nativeSkill.userMessage : event.prompt;
      if (!userPrompt) return;

      const skills = referencedSkills(
        userPrompt,
        event.systemPromptOptions.skills ?? [],
      );
      if (skills.length === 0) return;

      const content = await Promise.all(skills.map(inlineSkillContent));
      return {
        message: {
          customType: "openpi-inline-skill-reference",
          content: content.join("\n\n"),
          display: false,
        },
      };
    });
  };
}

export default createInlineSkillReferencesExtension();
