import { readFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const INLINE_SKILL_REFERENCE_CHARACTER = /[\p{L}\p{M}\p{N}_-]/u;

function startsAtReferenceBoundary(prompt: string, index: number) {
  if (index === 0) return true;
  const previous = prompt[index - 1];
  return previous === " " || previous === "\t";
}

function readReferenceName(prompt: string, dollarIndex: number) {
  let end = dollarIndex + 1;
  while (
    end < prompt.length &&
    INLINE_SKILL_REFERENCE_CHARACTER.test(prompt[end] ?? "")
  ) {
    end += 1;
  }
  return { name: prompt.slice(dollarIndex + 1, end), end };
}

export function referencedSkills(prompt: string, skills: readonly Skill[]) {
  const skillsByName = new Map<string, Skill>();
  for (const skill of skills) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }

  const selected: Skill[] = [];
  const selectedNames = new Set<string>();
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== "$" || !startsAtReferenceBoundary(prompt, index)) {
      continue;
    }

    const reference = readReferenceName(prompt, index);
    index = reference.end - 1;
    const skill = skillsByName.get(reference.name);
    if (!skill || selectedNames.has(skill.name)) continue;
    selectedNames.add(skill.name);
    selected.push(skill);
  }
  return selected;
}

function skillEnvelope(skill: Skill, content: string) {
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

async function loadSkillEnvelope(skill: Skill) {
  try {
    return skillEnvelope(skill, await readFile(skill.filePath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load inline Skill "${skill.name}" from ${skill.filePath}: ${reason}`,
    );
  }
}

export default function inlineSkillReferences(pi: ExtensionAPI) {
  let pendingPrompt: string | undefined;

  pi.on("input", (event) => {
    if (!event.streamingBehavior) pendingPrompt = event.text;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const prompt = pendingPrompt;
    pendingPrompt = undefined;
    if (prompt === undefined) return;
    const skills = referencedSkills(
      prompt,
      event.systemPromptOptions.skills ?? [],
    );
    if (skills.length === 0) return;

    const envelopes: string[] = [];
    for (const skill of skills) {
      envelopes.push(await loadSkillEnvelope(skill));
    }
    return {
      message: {
        customType: "openpi-inline-skill-references",
        content: envelopes.join("\n\n"),
        display: false,
        details: {
          skills: skills.map(({ name, filePath }) => ({ name, filePath })),
        },
      },
    };
  });
}
