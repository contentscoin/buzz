import assert from "node:assert/strict";
import { test } from "node:test";
import { completionObservation, executionResult } from "../src/execution-result.mjs";

const clean = (s, n) => typeof s === "string" ? Array.from(s).slice(0, n).join("") : null;
const run = "52a04b10-f7eb-43aa-a432-c97c9c9bda75";
function fixtures(provider = "anthropic", model = "claude-opus-5-5") {
  const task = {
    task_id: run, run_id: run, status: "dispatching", dispatch_stage: "intent_recorded",
    created_at: Date.now() / 1000 - 60, proposal_hash: "a".repeat(64),
    proposal: { requested_model: `${provider}/${model}`, requested_effort: "medium", model_binding: "b".repeat(64) },
  };
  const terminal = { runId: run, sessionId: "session", turnId: run,
    requested: { provider, model }, effective: { provider, model, responseModel: model } };
  const receipt = { runId: run, status: "ok", summary: "completed",
    result: { payloads: [{ text: "확인 결과" }], meta: { livenessState: "working",
      agentMeta: { provider, model, terminalReceipt: terminal } } } };
  const wait = { runId: run, status: "ok", endedAt: Date.now() - 1000, stopReason: "stop",
    livenessState: "working", terminalReceipt: structuredClone(terminal),
    terminalReply: { disposition: "visible", text: "확인 결과" } };
  return { task, receipt, wait };
}
for (const [provider, model] of [["anthropic", "claude-opus-5-5"], ["openai", "gpt-6.1-sol"]]) {
  test(`bound ${provider} SDK receipt without outer stop requires matching independent wait`, async () => {
    const { task, receipt, wait } = fixtures(provider, model);
    let reads = 0;
    const result = await executionResult(receipt, task, clean, false,
      async () => assert.fail("bound SDK identity cannot fall back to another source"),
      async () => assert.fail("unexpected tool recovery"),
      async (current) => { reads++; assert.equal(current, task); return wait; });
    assert.equal(reads, 1);
    assert.equal(result.status, "succeeded");
    assert.equal(result.actual_model, `${provider}/${model}`);
    assert.equal(result.reply, "확인 결과");
    assert.equal(result.completion_evidence.source, "gateway.agent.wait");
  });
}
for (const [name, mutate] of [
  ["missing independent wait", (f) => { f.wait = null; }],
  ["wrong outer run", (f) => { f.receipt.runId = "other"; }],
  ["malformed inner receipt", (f) => { f.receipt.result.meta.agentMeta.terminalReceipt = {}; }],
  ["wrong inner run", (f) => { f.receipt.result.meta.agentMeta.terminalReceipt.runId = "other"; }],
  ["wrong requested model", (f) => { f.receipt.result.meta.agentMeta.terminalReceipt.requested.model = "other"; }],
  ["wrong wait session", (f) => { f.wait.terminalReceipt.sessionId = "other"; }],
  ["wrong wait turn", (f) => { f.wait.terminalReceipt.turnId = "other"; }],
  ["different effective model", (f) => { f.wait.terminalReceipt.effective.responseModel = "gpt-6.1-sol"; f.wait.terminalReceipt.effective.provider = "openai"; }],
  ["different terminal reply", (f) => { f.wait.terminalReply.text = "other"; }],
  ["wait pending tools", (f) => { f.wait.stopReason = "tool_calls"; }],
  ["wait error", (f) => { f.wait.status = "error"; f.wait.stopReason = "error"; }],
  ["wait canceled", (f) => { f.wait.status = "error"; f.wait.stopReason = "aborted"; }],
  ["unfinished envelope", (f) => { f.receipt.summary = "accepted"; }],
  ["historic uncertainty", (f) => { f.task.status = "needs_reconcile"; }],
]) {
  test(`bound identity retains uncertainty with ${name}`, async () => {
    const f = fixtures(); mutate(f);
    assert.equal(await executionResult(f.receipt, f.task, clean, false,
      async () => assert.fail("must not bypass independent wait"),
      async () => assert.fail("must not bypass independent wait"),
      async () => f.wait), null);
  });
}
test("unconfirmed observation exports only booleans without payload/error secrets", () => {
  const { task, receipt } = fixtures();
  receipt.error = "credential must never be logged";
  receipt.result.payloads[0].text = "private result must never be logged";
  receipt.result.meta.unknownSecret = "secret";
  const observed = completionObservation(receipt, task);
  assert.equal(observed.terminal_bound, true);
  assert.equal(observed.stop_missing, true);
  assert.equal(observed.eligible_envelope, false);
  assert.equal(Object.values(observed).every(v => typeof v === "boolean"), true);
  assert.equal(/credential|private result|unknownSecret/.test(JSON.stringify(observed)), false);
});
for (const [field, mutate] of [
  ["rpc_error", (r) => { r.error = "private provider error"; }],
  ["meta_error", (r) => { r.result.meta.error = "private provider error"; }],
  ["aborted", (r) => { r.result.meta.aborted = true; }],
  ["yielded", (r) => { r.result.meta.yielded = true; }],
  ["continuation_pending", (r) => { r.result.meta.continuationPending = true; }],
  ["replay_invalid", (r) => { r.result.meta.replayInvalid = true; }],
  ["timeout_phase", (r) => { r.result.meta.timeoutPhase = "provider"; }],
  ["pending_tools", (r) => { r.result.meta.pendingToolCalls = [{ secret: "private" }]; }],
  ["blocked_liveness", (r) => { r.result.meta.livenessState = "paused"; }],
  ["payload_error", (r) => { r.result.payloads[0].isError = true; }],
]) {
  test(`unconfirmed diagnostic identifies ${field} without private values`, () => {
    const { task, receipt } = fixtures(); mutate(receipt);
    const observation = completionObservation(receipt, task);
    assert.equal(observation[field], true);
    assert.equal(observation.eligible_envelope, false);
    assert.equal(Object.values(observation).every(v => typeof v === "boolean"), true);
    assert.equal(JSON.stringify(observation).includes("private"), false);
  });
}
