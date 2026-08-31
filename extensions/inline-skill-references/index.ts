import { readFile } from "node:fs/promises";
import { contentText } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionAPI,
  parseSkillBlock,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

// Consume the complete identifier after `$` before looking it up. This is
// intentionally broader than the currently valid Pi Skill names: an input such
// as `$review技能` must be treated as one unknown reference, never as the known
// `$review` prefix followed by unrelated text.
const INLINE_SKILL_REFERENCE_CHARACTER = /[\p{L}\p{M}\p{N}_-]/u;
const INLINE_SKILL_MESSAGE_TYPE = "openpi-inline-skill-references";

type AgentMessage = AgentSession["messages"][number];
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type InlineSkillMessage = Extract<AgentMessage, { role: "custom" }>;

interface InlineSkillProjection {
  // A projection is the immutable result of resolving one submitted user
  // message against the Skills Pi supplied for this run. Pi deep-clones
  // provider context, so an AgentMessage object identity cannot be used to
  // locate the source later. Timestamp plus normalized source text are the
  // stable facts preserved by those clones.
  readonly sourceText: string;
  readonly sourceTimestamp: number;
  readonly message: InlineSkillMessage;
}

function startsAtReferenceBoundary(prompt: string, index: number) {
  // The public syntax accepts only start-of-input or horizontal ASCII
  // whitespace. Do not generalize this to `\s`: a newline before `$name` is
  // deliberately not an invocation boundary, and a preceding backslash keeps
  // `\$name` literal because the `$` is then not at a valid boundary.
  if (index === 0) return true;
  const previous = prompt[index - 1];
  return previous === " " || previous === "\t";
}

function readReferenceName(prompt: string, dollarIndex: number) {
  // Read the maximal candidate before resolving it. Exact-name lookup later
  // ensures `$reviewer` cannot accidentally invoke a Skill named `review`.
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
  // Resolve only from Pi's per-turn discovery result. This extension owns no
  // registry or cross-turn cache, so project Trust, disabled Skills, reloads,
  // and all other discovery policy remain Pi's source of truth.
  const skillsByName = new Map<string, Skill>();
  for (const skill of skills) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }

  // Preserve the user's first-reference order because it is also the order in
  // which Skill instructions reach the model. Repeated references contribute
  // no additional content, while unknown candidates remain ordinary user text.
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
  // Frontmatter is discovery metadata, not model instructions. The envelope
  // supplies the identity and base directory explicitly so relative paths in
  // the body retain the same meaning as a native Pi Skill invocation.
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

async function loadSkillEnvelope(skill: Skill) {
  try {
    return skillEnvelope(skill, await readFile(skill.filePath, "utf8"));
  } catch (error) {
    // Fail the extension event instead of silently omitting a requested Skill.
    // Partial or stale instructions would give the model a misleading view of
    // which capability the user explicitly selected.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load inline Skill "${skill.name}" from ${skill.filePath}: ${reason}`,
    );
  }
}

function referenceText(message: AgentMessage) {
  if (message.role !== "user") return;
  const text = contentText(message.content, "");
  // Native `/skill` invocations may arrive wrapped in Pi's internal Skill
  // block. Search only the original user-message portion: scanning the injected
  // native Skill body could recursively expand `$other` text written inside it.
  const nativeSkill = parseSkillBlock(text);
  return nativeSkill ? (nativeSkill.userMessage ?? "") : text;
}

export async function createInlineSkillProjection(
  message: UserMessage,
  skills: readonly Skill[],
) {
  const prompt = referenceText(message) ?? "";
  const referenced = referencedSkills(prompt, skills);
  if (referenced.length === 0) return;

  // Resolve and read at message_end, exactly once for the submitted message.
  // Provider retries and tool-result turns reuse this snapshot even if a Skill
  // file changes mid-run. Promise.all also makes projection creation atomic:
  // one failed read rejects the event, so no partial instruction set is saved.
  return {
    sourceText: prompt,
    sourceTimestamp: message.timestamp,
    message: {
      role: "custom",
      customType: INLINE_SKILL_MESSAGE_TYPE,
      content: (await Promise.all(referenced.map(loadSkillEnvelope))).join(
        "\n\n",
      ),
      display: false,
      details: {
        skills: referenced.map(({ name, filePath }) => ({ name, filePath })),
      },
      timestamp: message.timestamp,
    },
  } satisfies InlineSkillProjection;
}

function isProjectionSource(
  message: AgentMessage,
  projection: InlineSkillProjection,
) {
  // Both facts are required. Text distinguishes different submissions that
  // happen to share a timestamp; timestamp distinguishes identical prompts in
  // different turns. Object identity is unavailable after Pi clones context.
  return (
    message.role === "user" &&
    message.timestamp === projection.sourceTimestamp &&
    referenceText(message) === projection.sourceText
  );
}

export function injectInlineSkillReferences(
  messages: readonly AgentMessage[],
  projections: readonly InlineSkillProjection[],
) {
  const insertions = new Map<number, InlineSkillMessage>();
  let beforeIndex = messages.length;
  // Match both lists newest-first with a monotonically decreasing cursor. This
  // correlates repeated prompts with the current run's newest submissions,
  // prevents one historical user message from satisfying two projections, and
  // preserves the original submission order when several messages were queued.
  for (
    let projectionIndex = projections.length - 1;
    projectionIndex >= 0;
    projectionIndex -= 1
  ) {
    const projection = projections[projectionIndex];
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      if (!isProjectionSource(messages[index], projection)) continue;
      insertions.set(index, projection.message);
      beforeIndex = index;
      break;
    }
  }

  // A context may omit a queued source message while Pi is transitioning. In
  // that case leave it untouched rather than attaching instructions to a
  // different message or reconstructing state from historical text.
  if (insertions.size === 0) return;
  const next: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    next.push(messages[index]);
    const insertion = insertions.get(index);
    // Extension context handlers compose in sequence and later handlers are
    // allowed to mutate the array they receive. Clone every insertion so they
    // never receive the stored run projection itself; otherwise a mutation in
    // one provider call would silently alter instructions in subsequent calls.
    if (insertion) next.push(structuredClone(insertion));
  }
  return next;
}

export default function inlineSkillReferences(pi: ExtensionAPI) {
  // Both collections are scoped to one agent run. currentSkills is Pi's
  // authoritative discovery snapshot; activeProjections contains only messages
  // actually submitted during that run.
  let currentSkills: readonly Skill[] = [];
  let activeProjections: InlineSkillProjection[] = [];

  const reset = () => {
    currentSkills = [];
    activeProjections = [];
  };

  pi.on("before_agent_start", (event) => {
    // This is the only discovery boundary. Pi has already applied its Skill and
    // Trust policy here. Queued messages do not emit another
    // before_agent_start, so they intentionally reuse this run's supplied set.
    activeProjections = [];
    currentSkills = event.systemPromptOptions.skills ?? [];
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "user") return;
    // message_end is the authoritative shared boundary for initial, queued,
    // TUI, RPC, print, and extension-submitted user messages. Loading here also
    // keeps filesystem I/O and failure reporting out of the provider-facing
    // context transform, which may run repeatedly during one model turn.
    const projection = await createInlineSkillProjection(
      event.message,
      currentSkills,
    );
    if (projection) activeProjections.push(projection);
  });

  pi.on("context", (event) => {
    // Keep this hook a pure projection of captured run state. Re-scanning the
    // entire context here would retroactively expand old `$name` text after a
    // Skill reload and would reread files on every provider or tool-result turn.
    const messages = injectInlineSkillReferences(
      event.messages,
      activeProjections,
    );
    if (messages) return { messages };
  });

  // Projections are execution state for one agent run, not a Skill cache. Clear
  // them at every terminal or navigation boundary so a later run cannot inherit
  // hidden instructions from a settled, replaced, or shutting-down Session.
  pi.on("agent_settled", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
}
