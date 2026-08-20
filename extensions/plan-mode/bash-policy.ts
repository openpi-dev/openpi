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
 * This module does not parse shell or admit shell composition. Its small
 * tokenizer only recognizes words and quoted literal spans. `$`, backticks
 * and `\` are refused everywhere; shell metacharacters are refused outside
 * quotes. Globs are also refused outside quotes because the shell would expand
 * them before the allowlisted program sees them, while a quoted glob is a
 * literal pattern interpreted by that read-only program itself.
 */
const UNQUOTED_SHELL_METACHARACTERS = /[;&|<>(){}\n\r#]/;
const EXPANSION_CHARACTERS = /[$`\\]/;
const UNQUOTED_GLOB_CHARACTERS = new Set(["*", "?", "[", "]"]);

/**
 * Tilde expansion is refused only at the start of an unquoted word. `HEAD~3`
 * is ordinary revision syntax and must survive, while `~/notes` and
 * `~user/x` resolve to a path this module never sees.
 */

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

const RG_FLAGS = new Set([
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-l",
  "--files-with-matches",
  "-c",
  "--count",
  "-w",
  "-F",
  "--fixed-strings",
  "-e",
  "--regexp",
  "-g",
  "--glob",
  "-t",
  "--type",
  "--files",
  "--hidden",
  "--no-ignore",
  "-A",
  "-B",
  "-C",
  "--after-context",
  "--before-context",
  "--context",
  "-m",
  "--max-count",
  "-o",
  "--only-matching",
  "--sort",
  "--json",
  "--color",
  "-H",
  "-N",
  "--no-filename",
  "-v",
  "--invert-match",
  "-u",
  "-uu",
]);

const FD_FLAGS = new Set([
  "-e",
  "--extension",
  "-t",
  "--type",
  "-d",
  "--max-depth",
  "--min-depth",
  "-H",
  "--hidden",
  "-I",
  "--no-ignore",
  "-g",
  "--glob",
  "-F",
  "--fixed-strings",
  "-p",
  "--full-path",
  "-a",
  "--absolute-path",
  "-l",
  "--list-details",
  "--color",
  "-0",
  "-S",
  "--size",
]);

const LS_FLAGS = new Set([
  "-l",
  "-a",
  "-A",
  "-h",
  "-t",
  "-r",
  "-R",
  "-d",
  "-1",
  "-S",
  "-F",
  "--color",
]);
const WC_FLAGS = new Set(["-l", "-w", "-c", "-m"]);
const HEAD_TAIL_FLAGS = new Set(["-n", "-c", "--lines", "--bytes"]);

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

/**
 * Tokenize words without pretending to be a shell parser. Quoted spans are
 * removed and become literal text; no expansion or command composition is
 * supported. The validation happens while tokenizing so an unquoted glob can
 * never be mistaken for a literal program argument.
 */
function tokenize(command: string) {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  let wordStartsUnquoted = false;

  for (const character of command) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (EXPANSION_CHARACTERS.test(character)) {
        return refuse(
          `plan mode rejected expansion character ${JSON.stringify(character)} — remove expansion syntax and pass literal arguments instead`,
        );
      } else {
        word += character;
      }
      inWord = true;
      continue;
    }

    if (EXPANSION_CHARACTERS.test(character)) {
      return refuse(
        `plan mode rejected expansion character ${JSON.stringify(character)} — remove expansion syntax and pass literal arguments instead`,
      );
    }
    if (UNQUOTED_SHELL_METACHARACTERS.test(character)) {
      return refuse(
        `plan mode rejected unquoted shell metacharacter ${JSON.stringify(character)} — run a single plain command without shell composition`,
      );
    }
    if (UNQUOTED_GLOB_CHARACTERS.has(character)) {
      return refuse(
        "plan mode will not run an unquoted glob because the shell would expand it — quote it instead, e.g. --glob '*.ts'",
      );
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      if (!word) wordStartsUnquoted = false;
      continue;
    }
    if (/\s/.test(character)) {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
        wordStartsUnquoted = false;
      }
      continue;
    }
    if (!inWord) wordStartsUnquoted = true;
    if (wordStartsUnquoted && word.length === 0 && character === "~") {
      return refuse(
        "plan mode does not run tilde-expanded paths — use a path relative to the project instead",
      );
    }
    word += character;
    inWord = true;
  }

  if (quote) {
    return refuse(
      `plan mode rejected an unterminated ${quote === "'" ? "single" : "double"} quote — close the quote or pass a literal argument instead`,
    );
  }
  if (inWord) words.push(word);
  return { allowed: true as const, words };
}

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
  /**
   * Whether `-la` may stand for `-l -a`. Only the file-inspection programs opt
   * in: git and gh keep their historical one-flag-per-word rule, so widening
   * the tokenizer cannot quietly widen their surface too.
   */
  allowShortClusters = false,
): BashPlanDecision {
  for (const word of words) {
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    if (NUMERIC_SHORTHAND.test(word)) continue;
    if (allowed.has(flagName(word))) continue;
    const isAllowedCluster =
      allowShortClusters &&
      !word.startsWith("--") &&
      word.length > 2 &&
      [...word.slice(1)].every((character) => allowed.has(`-${character}`));
    if (isAllowedCluster) continue;
    return refuse(
      `plan mode does not recognize "${word}" as a read-only ${program} option — use only the allowlisted ${program} flags`,
    );
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

  const tokenized = tokenize(text);
  if (!("words" in tokenized)) return tokenized;
  const [program, ...rest] = tokenized.words;
  if (!program) return refuse("plan mode received an empty command");

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

  const readOnlyPrograms = new Map([
    ["rg", RG_FLAGS],
    ["fd", FD_FLAGS],
    ["ls", LS_FLAGS],
    ["wc", WC_FLAGS],
    ["head", HEAD_TAIL_FLAGS],
    ["tail", HEAD_TAIL_FLAGS],
  ]);
  const flags = readOnlyPrograms.get(program);
  if (flags) {
    if (
      program === "tail" &&
      rest.some((word) => word === "-f" || word === "--follow")
    ) {
      return refuse(
        'plan mode refuses "tail -f/--follow" because it can block forever — use a finite tail command instead',
      );
    }
    return scanArguments(rest, flags, program, true);
  }

  return refuse(
    `plan mode does not allow "${program}" — use read-only git and gh investigation commands; available commands are git, gh, rg, fd, ls, wc, head or tail, plus the read/grep/fd tools`,
  );
}
