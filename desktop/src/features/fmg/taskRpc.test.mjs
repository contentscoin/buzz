import assert from "node:assert/strict";
import test from "node:test";

import { taskDetailSchema } from "./taskRpc.ts";

function task() {
  return {
    task_id: "c0632317-f4b9-43ad-8f56-352a2a7688b9",
    status: "awaiting_approval",
    revision: 1,
    created_at: 1791435776,
    updated_at: 1791435776,
    proposal_hash: "a".repeat(64),
    run_id: null,
    dispatch_stage: null,
    proposal: {
      role_id: "fmg-frontend",
      requested_model: "openai/gpt-6.1-sol",
      requested_effort: "medium",
      instructions: "검토용 작업",
    },
    result: null,
    recovery_history: [],
  };
}

function projectTask(account) {
  const value = task();
  value.proposal.proposal_account = account;
  value.proposal.project = {
    schema: 1,
    project_id: "buzz",
    repository_url: "https://github.com/contentscoin/buzz.git",
    role_id: "fmg-frontend",
    branch: "fmg-buzz/fmg-frontend",
    source_commit: "b".repeat(40),
    execution_host: "hostinger",
    workspace_binding: "c".repeat(64),
  };
  return value;
}

test("task detail keeps legacy proposals without repository or proposal account readable", () => {
  const parsed = taskDetailSchema.parse(task());
  assert.equal(parsed.proposal.project, undefined);
  assert.equal(parsed.proposal.proposal_account, undefined);
  assert.equal(parsed.proposal.requested_effort, "medium");
});

for (const account of ["gateway_owner_main", "original_oauth_client"]) {
  test(`task detail preserves the ${account} account and its repository binding`, () => {
    const value = projectTask(account);
    const parsed = taskDetailSchema.parse(value);
    assert.equal(parsed.proposal.proposal_account, account);
    assert.deepEqual(parsed.proposal.project, value.proposal.project);
  });

  test(`task detail rejects ${account} without its repository binding`, () => {
    const value = projectTask(account);
    delete value.proposal.project;
    assert.equal(taskDetailSchema.safeParse(value).success, false);
  });

  test(`task detail rejects mismatched role and branch bindings for ${account}`, () => {
    const wrongRole = projectTask(account);
    wrongRole.proposal.role_id = "fmg-backend";
    assert.equal(taskDetailSchema.safeParse(wrongRole).success, false);

    const wrongBranch = projectTask(account);
    wrongBranch.proposal.project.branch = "fmg-buzz/fmg-backend";
    assert.equal(taskDetailSchema.safeParse(wrongBranch).success, false);
  });
}

test("task detail rejects a repository binding without its proposal account", () => {
  const value = projectTask("original_oauth_client");
  delete value.proposal.proposal_account;
  assert.equal(taskDetailSchema.safeParse(value).success, false);
});

test("task detail rejects unknown and missing-value proposal accounts", () => {
  for (const account of ["other_oauth_client", "gateway_owner", "", null]) {
    assert.equal(
      taskDetailSchema.safeParse(projectTask(account)).success,
      false,
    );
  }
});
