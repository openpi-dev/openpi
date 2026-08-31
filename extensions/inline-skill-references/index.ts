import { readFile } from "node:fs/promises";
import { contentText } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionAPI,
  parseSkillBlock,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const INLINE_SKILL_REFERENCE_CHARACTER = /[\p{L}\p{M}\p{N}_-]/u;
const INLINE_SKILL_MESSAGE_TYPE = "openpi-inline-skill-references";

type AgentMessage = AgentSession["messages"][number];

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

function referenceText(message: AgentMessage) {
  if (message.role !== "user") return;
  const text = contentText(message.content, "");
  const nativeSkill = parseSkillBlock(text);
  return nativeSkill ? (nativeSkill.userMessage ?? "") : text;
}

function alreadyHasInlineSkillMessage(message: AgentMessage | undefined) {
  return (
    message?.role === "custom" &&
    message.customType === INLINE_SKILL_MESSAGE_TYPE
  );
}

export async function injectInlineSkillReferences(
  messages: readonly AgentMessage[],
  skills: readonly Skill[],
) {
  const next: AgentMessage[] = [];
  const loads = new Map<Skill, Promise<string>>();
  let changed = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    next.push(message);
    const prompt = referenceText(message);
    if (
      prompt === undefined ||
      alreadyHasInlineSkillMessage(messages[index + 1])
    ) {
      continue;
    }

    const referenced = referencedSkills(prompt, skills);
    if (referenced.length === 0) continue;

    const envelopes: string[] = [];
    for (const skill of referenced) {
      let load = loads.get(skill);
      if (!load) {
        load = loadSkillEnvelope(skill);
        loads.set(skill, load);
      }
      envelopes.push(await load);
    }
    next.push({
      role: "custom",
      customType: INLINE_SKILL_MESSAGE_TYPE,
      content: envelopes.join("\n\n"),
      display: false,
      details: {
        skills: referenced.map(({ name, filePath }) => ({ name, filePath })),
      },
      timestamp: message.timestamp,
    });
    changed = true;
  }

  return changed ? next : undefined;
}

export default function inlineSkillReferences(pi: ExtensionAPI) {
  let currentSkills: readonly Skill[] = [];

  pi.on("before_agent_start", (event) => {
    currentSkills = event.systemPromptOptions.skills ?? [];
  });

  pi.on("context", async (event) => {
    const messages = await injectInlineSkillReferences(
      event.messages,
      currentSkills,
    );
    if (messages) return { messages };
  });
}
