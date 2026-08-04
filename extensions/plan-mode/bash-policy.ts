/**
 * Deciding whether an ARBITRARY shell command is read-only is undecidable, so
 * this does not try. It answers a much narrower question: is this command
 * EXACTLY one of a few known investigation commands, with nothing else
 * attached? Anything it cannot prove safe stays blocked — the same fail-closed
 * stance as PLAN_SAFE_TOOLS one level up, one level finer.
 *
 * It exists because planning without `git log`/`git diff`/`git status` means
 * planning without history: `read`/`rg` show what the code says, never why it
 * came to say it.
 */

/**
 * Any of these means the text is more than one plain command — a pipeline, a
 * sequence, a redirect, a substitution, a glob, or a background job. Rather
 * than parse shell (where every parser bug is a bypass), refuse outright.
 *
 * `\` is here because a line continuation splices in the next line; `$` covers
 * both `$(...)` and a `$VAR` that expands into arguments never inspected here.
 */
const SHELL_METACHARACTERS = /[;&|<>$`\\!*?{}()\[\]\n\r#]/;

/** Quotes hide word boundaries from the tokenizer below, so they are refused too. */
const QUOTES = /["']/;

/**
 * Read-only invocations keyed by argv[0]. A non-empty set means the second
 * word must be one of those subcommands; an empty set means the command reads
 * by nature and only flags/paths follow.
 *
 * Deliberately absent from git: `config` (writes on `--global x y`), `stash`
 * (mutates the worktree), `tag`/`branch`/`remote` (create refs on most forms),
 * `reflog` (`expire` deletes). Absent from gh: `api` (any method), `run`
 * (`rerun`/`cancel`), `repo` (`clone`/`delete`), `release` (`create`). Each
 * has a read-only form, but distinguishing it means parsing that subcommand's
 * own flag grammar — the exact analysis this module refuses to do.
 */
const READ_ONLY_COMMANDS = new Map<string, ReadonlySet<string>>([
  [
    "git",
    new Set([
      "log",
      "diff",
      "status",
      "show",
      "blame",
      "shortlog",
      "describe",
      "rev-parse",
      "rev-list",
      "ls-files",
      "ls-tree",
      "cat-file",
      "for-each-ref",
      "merge-base",
      "name-rev",
      "whatchanged",
      "grep",
    ]),
  ],
  ["gh", new Set(["pr", "issue", "search"])],
  ["ls", new Set()],
  ["cat", new Set()],
  ["head", new Set()],
  ["tail", new Set()],
  ["wc", new Set()],
  ["file", new Set()],
  ["stat", new Set()],
  ["du", new Set()],
  ["pwd", new Set()],
  ["which", new Set()],
  ["date", new Set()],
  ["tree", new Set()],
]);

/**
 * `gh <subcommand>` verbs that write even under an otherwise read-only parent
 * (`gh pr create`, `gh issue close`). Checked as a denylist because gh keeps
 * adding read verbs, and a new read verb being refused is a harmless miss
 * while a new write verb slipping through is not — so the check below also
 * requires the third word to be a known read verb.
 */
const GH_READ_VERBS = new Set(["view", "list", "status", "diff", "checks"]);

/**
 * Flags that make an otherwise read-only command write a file. `git show
 * --output=x` and `git diff --output x` both exist; so does `-o`.
 */
const OUTPUT_FLAGS = /^(-o|--output)(=|$)/;

/**
 * Flags that relocate what a command runs against or executes. `git
 * --exec-path=/tmp/evil log` runs binaries from an attacker path, and `-c
 * core.pager=...` runs a pager command.
 */
const RELOCATING_FLAGS =
  /^(-c|-C|--exec-path|--git-dir|--work-tree|--upload-pack|--receive-pack|--pager)(=|$)/;

export interface BashPlanDecision {
  allowed: boolean;
  /** Why it was refused, phrased for the model that must react to it. */
  reason?: string;
}

const refuse = (reason: string): BashPlanDecision => ({
  allowed: false,
  reason,
});

/**
 * Whether this exact command may run during plan mode. The contract is
 * one-directional: `allowed: true` means proven read-only by the rules above,
 * `allowed: false` means only "not proven", never "proven dangerous".
 */
export function planBashDecision(command: unknown): BashPlanDecision {
  if (typeof command !== "string") {
    return refuse("plan mode could not read the command to check it");
  }
  const text = command.trim();
  if (!text) return refuse("plan mode received an empty command");

  if (SHELL_METACHARACTERS.test(text)) {
    return refuse(
      "plan mode only runs a single plain command — no pipes, redirects, substitutions, globs, or chained commands",
    );
  }
  if (QUOTES.test(text)) {
    return refuse("plan mode only runs unquoted commands while planning");
  }

  const words = text.split(/\s+/);
  const [program, ...rest] = words;
  const subcommands = READ_ONLY_COMMANDS.get(program ?? "");
  if (!subcommands) {
    return refuse(
      `plan mode allows only read-only investigation commands (git log/diff/status/show/blame, gh pr view, ls, cat, head, tail, wc), not "${program}"`,
    );
  }

  for (const word of rest) {
    if (OUTPUT_FLAGS.test(word)) {
      return refuse(`"${word}" writes a file, which plan mode does not allow`);
    }
    if (RELOCATING_FLAGS.test(word)) {
      return refuse(
        `"${word}" can redirect what runs or where it runs, which plan mode does not allow`,
      );
    }
  }

  if (subcommands.size === 0) return { allowed: true };

  // The subcommand is the first word that is not a global flag: `git -P log`
  // and `git log` are the same command.
  const subcommand = rest.find((word) => !word.startsWith("-"));
  if (!subcommand || !subcommands.has(subcommand)) {
    return refuse(
      `plan mode allows only read-only ${program} subcommands (${[...subcommands].slice(0, 5).join(", ")}, …), not "${subcommand ?? "(none)"}"`,
    );
  }

  if (program === "gh") {
    // `gh pr view` reads; `gh pr create` does not. Require an explicit read
    // verb rather than trusting the parent subcommand.
    const afterSub = rest.slice(rest.indexOf(subcommand) + 1);
    const verb = afterSub.find((word) => !word.startsWith("-"));
    if (!verb || !GH_READ_VERBS.has(verb)) {
      return refuse(
        `plan mode allows only read verbs after "gh ${subcommand}" (${[...GH_READ_VERBS].join(", ")}), not "${verb ?? "(none)"}"`,
      );
    }
  }

  return { allowed: true };
}
