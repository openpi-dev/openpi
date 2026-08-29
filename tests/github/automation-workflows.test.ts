import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function workflow(name: string) {
  return readFileSync(`.github/workflows/${name}.yml`, "utf8");
}

test("shared repository workflows follow the automation main branch", () => {
  const workflows = [workflow("feishu-pr-notification"), workflow("release")];

  for (const source of workflows) {
    assert.match(source, /uses: openpi-dev\/automation\/.+@main/u);
    assert.doesNotMatch(source, /^\s+(?:run|steps|runs-on):/mu);
  }
});

test("the privileged PR caller passes only its two notification secrets", () => {
  const source = workflow("feishu-pr-notification");

  assert.match(source, /^\s*pull_request_target:/mu);
  assert.match(source, /^\s*pull-requests: read$/mu);
  assert.match(
    source,
    /FEISHU_PR_BOT_WEBHOOK: \$\{\{ secrets\.FEISHU_PR_BOT_WEBHOOK \}\}/u,
  );
  assert.match(
    source,
    /FEISHU_PR_BOT_SECRET: \$\{\{ secrets\.FEISHU_PR_BOT_SECRET \}\}/u,
  );
  assert.doesNotMatch(
    source,
    /secrets: inherit|pull_request\.head|github\.head_ref/u,
  );
});

test("release keeps its trigger, concurrency, and OIDC authority in the caller", () => {
  const source = workflow("release");

  assert.match(source, /^\s*workflow_dispatch:/mu);
  assert.match(source, /^\s*tags:/mu);
  assert.match(source, /^\s*id-token: write$/mu);
  assert.match(source, /^concurrency:/mu);
  assert.match(source, /^\s*tag: \$\{\{ github\.event_name/mu);
});

test("project-specific CI remains defined in this repository", () => {
  const source = workflow("ci");

  assert.match(source, /^\s*matrix:/mu);
  assert.match(source, /Smoke-test Pi package discovery/u);
  assert.match(source, /Background terminals \(Windows\)/u);
  assert.doesNotMatch(source, /openpi-dev\/automation/u);
});
