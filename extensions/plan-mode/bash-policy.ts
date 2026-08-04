/**
 * Deciding whether an ARBITRARY shell command is read-only is undecidable, so
 * this does not try. It answers a much narrower question: is this command one
 * of a few known investigation commands, built ONLY from parts on an explicit
 * allowlist? Anything not on a list is refused — the same fail-closed stance
 * as PLAN_SAFE_TOOLS one level up, one level finer.
 *
 * It exists because planning without `git log`/`git diff`/`git status` means
 * planning without history: `read`/`rg` show what the code says, never why it
 * came to say it.
 *
 * THREAT MODEL. The adversary is a model that would start changing things
 * before the user approved a plan — including one steered by injected text it
 * read while investigating. It is NOT a hostile repository: `git diff` honors
 * `diff.external` from the repo's own config, so a checkout whose `.git/config`
 * is attacker-controlled can run a program through a command this module
 * allows. Nothing here can prevent that, and nothing above it tries to: pi
 * already runs the project's own tooling under the user's trust decision.
 *
 * EVERY LIST BELOW IS AN ALLOWLIST, deliberately. An earlier version scanned
 * for known-dangerous flags instead, and review found four separate escapes in
 * one pass (`git grep -O<cmd>` executes, `file --compile` writes, `tree -ao`
 * writes, `date -s` sets the clock). A denylist over an unbounded flag space
 * cannot be finished; a missing allowlist entry only costs a refusal.
 */

/**
 * Any of these means the text is more than one plain command — a pipeline, a
 * sequence, a redirect, a substitution, a glob, or a background job. Rather
 * than parse shell (where every parser bug is a bypass), refuse outright.
 *
 * `\` is here because a line continuation splices in the next line; `$` covers
 * both `$(...)` and a `$VAR` that expands into arguments never inspected here.
 */
const SHELL_METACHARACTERS = /[;&|<>$`\\!*?{}()[\]\n\r#]/;

/**
 * Tilde expansion, but only where a shell would actually expand it: at the
 * start of a word. `HEAD~3` is ordinary revision syntax and must survive,
 * while `~/notes` and `~user/x` resolve to a path this module never sees.
 */
const TILDE_EXPANSION = /(^|\s)~/;

/** Quotes hide word boundaries from the tokenizer below, so they are refused too. */
const QUOTES = /["']/;

/**
 * Read-only git subcommands. Absent on purpose: `config`, `stash`, `tag`,
 * `branch`, `remote`, `reflog`, `worktree` — each has a listing form, but
 * telling it apart from the writing form means parsing that subcommand's own
 * grammar, which is the analysis this module refuses to do.
 */
const GIT_SUBCOMMANDS = new Set([
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
  "merge-base",
  "name-rev",
  "whatchanged",
  "grep",
]);

/**
 * Flags accepted after a git subcommand. The admission rule for this list is
 * narrow: a flag qualifies only if it shapes OUTPUT or SELECTS commits, and
 * never names a program, a file to write, or a path git will execute from.
 * That is why `-O`/`--open-files-in-pager` (runs a program per match),
 * `-o`/`--output` (writes a file) and `--contents` (reads an out-of-tree file)
 * are absent, and why an unrecognized flag is refused rather than assumed dull.
 *
 * A `--flag=value` form is matched on the `--flag` part; a value given as the
 * next word is admitted by the non-flag branch of the scan.
 */
const GIT_FLAGS = new Set([
  // Patch and stat shaping.
  "-p",
  "--patch",
  "--no-patch",
  "-s",
  "--stat",
  "--shortstat",
  "--numstat",
  "--summary",
  "--raw",
  "--name-only",
  "--name-status",
  "--no-color",
  "--color",
  "--word-diff",
  "-U",
  "--unified",
  "--no-ext-diff",
  // Commit formatting.
  "--oneline",
  "--graph",
  "--abbrev-commit",
  "--no-abbrev-commit",
  "--format",
  "--pretty",
  "--date",
  "--relative-date",
  "--decorate",
  "--no-decorate",
  // Commit selection.
  "-n",
  "--max-count",
  "--skip",
  "--since",
  "--after",
  "--until",
  "--before",
  "--author",
  "--committer",
  "--grep",
  "--all",
  "--branches",
  "--tags",
  "--remotes",
  "--first-parent",
  "--no-merges",
  "--merges",
  "--reverse",
  "--follow",
  "--topo-order",
  "--date-order",
  // Diff/blame comparison.
  "--cached",
  "--staged",
  "-w",
  "--ignore-all-space",
  "--ignore-space-change",
  "-M",
  "-C",
  "-L",
  "--find-renames",
  "--find-copies",
  // Plumbing queries used while orienting.
  "--abbrev-ref",
  "--show-toplevel",
  "--git-dir",
  "--is-inside-work-tree",
  "--verify",
  "--short",
  "--porcelain",
  "--branch",
  "-b",
  "-u",
  "--untracked-files",
  "-t",
  "-r",
  "--long",
  "--count",
]);

/** gh subcommands paired with the verbs under each that only read. */
const GH_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["pr", new Set(["view", "list", "diff", "checks", "status"])],
  ["issue", new Set(["view", "list", "status"])],
  ["search", new Set(["code", "commits", "issues", "prs", "repos"])],
]);

/**
 * Flags accepted after a gh verb. `--web` is absent on purpose: it opens the
 * user's browser, which reads nothing and is a side effect they did not ask a
 * planning step to cause.
 */
const GH_FLAGS = new Set([
  "--json",
  "--jq",
  "--template",
  "--repo",
  "-R",
  "--state",
  "--limit",
  "-L",
  "--author",
  "--assignee",
  "--label",
  "--search",
  "--draft",
  "--base",
  "--head",
  "--owner",
  "--language",
  "--comments",
]);

/** `-5`, `-20`: git's count shorthand, which is a number rather than a flag. */
const NUMERIC_SHORTHAND = /^-\d+$/;

export interface BashPlanDecision {
  allowed: boolean;
  /** Why it was refused, phrased for the model that must react to it. */
  reason?: string;
}

const refuse = (reason: string): BashPlanDecision => ({
  allowed: false,
  reason,
});

/** Split `--flag=value` into the flag part the allowlists are keyed on. */
function flagName(word: string) {
  const eq = word.indexOf("=");
  return eq === -1 ? word : word.slice(0, eq);
}

/**
 * Check the argument tail. Words after `--` are pathspecs by definition and
 * need no check; before it, a word either is an allowlisted flag or is not a
 * flag at all (a path, ref, or pattern, none of which can execute).
 */
function scanArguments(
  words: readonly string[],
  allowed: ReadonlySet<string>,
  program: string,
): BashPlanDecision {
  for (const word of words) {
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    if (NUMERIC_SHORTHAND.test(word)) continue;
    if (!allowed.has(flagName(word))) {
      return refuse(
        `plan mode does not recognize "${word}" as a read-only ${program} option, so it will not run this command`,
      );
    }
  }
  return { allowed: true };
}

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
  if (TILDE_EXPANSION.test(text)) {
    return refuse(
      "plan mode does not run commands with `~` paths — give a path relative to the project instead",
    );
  }

  const [program, ...rest] = text.split(/\s+/);

  /*
   * The subcommand must be the FIRST word, never "the first word that is not a
   * flag". Skipping over flags assumes they are value-less, and git's
   * `--namespace x` / `--attr-source x` and gh's cobra parser each consume the
   * next word — so a skip-to-first-non-flag rule lets `git --namespace log
   * push --force` donate the allowlisted subcommand to the flag and run the
   * one behind it. Requiring position refuses `git -P log` too; that is a
   * false negative, which this module is allowed to have.
   */
  if (program === "git") {
    const [subcommand, ...args] = rest;
    if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand)) {
      return refuse(
        `plan mode allows only a read-only git subcommand immediately after "git" (log, diff, status, show, blame, …), not "${subcommand ?? "(none)"}"`,
      );
    }
    return scanArguments(args, GIT_FLAGS, "git");
  }

  if (program === "gh") {
    const [subcommand, verb, ...args] = rest;
    const verbs = subcommand ? GH_SUBCOMMANDS.get(subcommand) : undefined;
    if (!verbs) {
      return refuse(
        `plan mode allows only "gh pr", "gh issue" or "gh search" while planning, not "${subcommand ?? "(none)"}"`,
      );
    }
    if (!verb || !verbs.has(verb)) {
      return refuse(
        `plan mode allows only read verbs after "gh ${subcommand}" (${[...verbs].join(", ")}), not "${verb ?? "(none)"}"`,
      );
    }
    return scanArguments(args, GH_FLAGS, "gh");
  }

  /*
   * Nothing else is admitted. `ls`, `cat`, `head`, `tail` and `wc` were on an
   * earlier version of this list and are gone: plan mode already grants the
   * `ls`, `read`, `grep` and `fd`/`rg` TOOLS, so those shell forms added no
   * capability while each contributed its own flag grammar to get wrong
   * (`file --compile` and `tree -ao` both write files).
   */
  return refuse(
    `plan mode runs only read-only git and gh investigation commands while planning, not "${program}" — use the read, ls, grep or fd tools for files`,
  );
}
