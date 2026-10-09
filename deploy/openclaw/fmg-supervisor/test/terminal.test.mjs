import assert from "node:assert/strict";
import { test } from "node:test";
import { finalResult } from "../src/terminal.mjs";
import { runtimeResult } from "../src/runtime-recovery.mjs";
import { executionResult } from "../src/execution-result.mjs";

const clean = (s, n) =>
  typeof s === "string" ? Array.from(s).slice(0, n).join("") : null;
const run = "76fc8565-8b9e-4c71-8a80-736b6eca5178";
const task = {
  status: "dispatching",
  task_id: run,
  run_id: run,
  created_at: Date.now() / 1000 - 60,
  dispatch_stage: "intent_recorded",
  proposal_hash: "a".repeat(64),
  proposal: {
    role_id: "fmg-backend",
    session_key: `agent:fmg-backend:fmg-task:${run}`,
    requested_model: "openai/gpt-6.1-sol",
    requested_effort: "medium",
    instructions: "두 줄을 반환하세요.",
    model_binding: "b".repeat(64),
  },
};
function final() {
  return {
    runId: run,
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: "완료\n응답" }],
      meta: {
        stopReason: "stop",
        aborted: false,
        agentMeta: {
          terminalReceipt: {
            runId: run,
            sessionId: "session",
            turnId: run,
            requested: { provider: "openai", model: "gpt-6.1-sol" },
            effective: { provider: "openai", model: "gpt-6.1-sol" },
          },
        },
      },
    },
  };
}
function runtime() {
  const flags = {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
  };
  const completed = {
    ...flags,
    stopReason: "stop",
    promptErrorSource: null,
    finalPromptText: task.proposal.instructions,
    assistantTexts: ["완료\n응답"],
    messagesSnapshot: [
      { role: "user" },
      {
        role: "assistant",
        provider: "openai",
        model: "gpt-6.1-sol",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "완료\n응답",
            textSignature: JSON.stringify({
              id: "message",
              phase: "final_answer",
            }),
          },
        ],
        diagnostics: [
          {
            type: "openai_responses_terminal",
            details: { eventType: "response.completed", stopReason: "stop" },
          },
        ],
      },
    ],
  };
  const entries = [
    ["session.started", { agentId: "fmg-backend" }],
    ["trace.metadata", { model: { thinkLevel: "medium" } }],
    ["model.completed", completed],
    [
      "trace.artifacts",
      {
        ...flags,
        stopReason: "stop",
        finalStatus: "success",
        promptErrorSource: null,
        finalPromptText: task.proposal.instructions,
        assistantTexts: ["완료\n응답"],
        toolMetas: [],
        didSendViaMessagingTool: false,
        successfulCronAdds: 0,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
      },
    ],
    ["session.ended", { ...flags, status: "success", stopReason: "stop" }],
  ];
  return entries.map(([type, data], i) => ({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    source: "runtime",
    type,
    data,
    runId: run,
    sessionId: "session",
    sessionKey: task.proposal.session_key,
    provider: "openai",
    modelId: "gpt-6.1-sol",
    ts: new Date(Date.now() - 10000 + i).toISOString(),
    seq: i + 1,
  }));
}
test("SDK normal stop has bound success evidence", () => {
  const r = finalResult(final(), task, clean);
  assert.equal(r.status, "succeeded");
  assert.equal(r.reply, "완료\n응답");
  assert.equal(r.completion_evidence.source, "gateway.agent.final");
});

test("live dispatch with missing SDK receipt binds the durable no-tool end", async () => {
  const receipt = final();
  delete receipt.result.meta.agentMeta.terminalReceipt;
  let reads = 0;
  const result = await executionResult(
    receipt,
    task,
    clean,
    false,
    async (current, sanitize) => {
      reads++;
      assert.equal(current, task);
      return runtimeResult(runtime(), current, sanitize);
    },
  );
  assert.equal(reads, 1);
  assert.equal(result.status, "succeeded");
  assert.equal(result.run_id, task.run_id);
  assert.equal(result.reply, "완료\n응답");
  assert.equal(result.completion_evidence.source, "gateway.runtime.no_tools");
});

test("valid SDK completion never reads the runtime database", async () => {
  const result = await executionResult(
    final(),
    task,
    clean,
    false,
    async () => {
      assert.fail("unexpected fallback");
    },
  );
  assert.equal(result.completion_evidence.source, "gateway.agent.final");
});

for (const [name, mutateReceipt, mutateTask, canceled] of [
  ["wrong RPC run", (r) => (r.runId = "other")],
  ["accepted response", (r) => (r.summary = "accepted")],
  ["aborted receipt", (r) => (r.result.meta.aborted = true)],
  ["yielded receipt", (r) => (r.result.meta.yielded = true)],
  ["tool continuation", (r) => (r.result.meta.pendingToolCalls = [{}])],
  ["RPC error", (r) => (r.error = "failed")],
  ["error payload", (r) => (r.result.payloads[0].isError = true)],
  [
    "malformed inner receipt",
    (r) => (r.result.meta.agentMeta.terminalReceipt = {}),
  ],
  [
    "contradictory model metadata",
    (r) =>
      (r.result.meta.agentMeta = {
        provider: "anthropic",
        model: "claude-opus-5-5",
      }),
  ],
  [
    "incomplete model metadata",
    (r) => (r.result.meta.agentMeta.model = "gpt-6.1-sol"),
  ],
  ["missing durable intent", null, (t) => (t.dispatch_stage = null)],
  ["foreign task run", null, (t) => (t.task_id = "other")],
  ["historical uncertain task", null, (t) => (t.status = "needs_reconcile")],
  ["cancellation requested", null, null, true],
])
  test(`live completion does not fall back for ${name}`, async () => {
    const receipt = final(),
      current = structuredClone(task);
    delete receipt.result.meta.agentMeta.terminalReceipt;
    mutateReceipt?.(receipt);
    mutateTask?.(current);
    const result = await executionResult(
      receipt,
      current,
      clean,
      canceled,
      async () => {
        assert.fail("ineligible receipt must not access runtime evidence");
      },
    );
    assert.equal(result, null);
  });

for (const [name, mutate] of [
  ["missing end", (e) => e.pop()],
  ["tools used", (e) => (e[3].data.toolMetas = [{}])],
  ["wrong effort", (e) => (e[1].data.model.thinkLevel = "low")],
  ["different prompt", (e) => (e[2].data.finalPromptText = "other")],
  [
    "no final response",
    (e) => (e[2].data.messagesSnapshot.at(-1).diagnostics = []),
  ],
])
  test(`live completion preserves uncertainty for ${name}`, async () => {
    const receipt = final(),
      events = runtime();
    delete receipt.result.meta.agentMeta.terminalReceipt;
    mutate(events);
    assert.equal(
      await executionResult(
        receipt,
        task,
        clean,
        false,
        async (current, sanitize) => runtimeResult(events, current, sanitize),
      ),
      null,
    );
  });

test("RPC reply mismatch cannot borrow another stored reply", async () => {
  const receipt = final();
  delete receipt.result.meta.agentMeta.terminalReceipt;
  receipt.result.payloads[0].text = "different";
  assert.equal(
    await executionResult(
      receipt,
      task,
      clean,
      false,
      async (current, sanitize) => runtimeResult(runtime(), current, sanitize),
    ),
    null,
  );
});

test("read failure propagates to worker's durable uncertain outcome", async () => {
  const receipt = final();
  delete receipt.result.meta.agentMeta.terminalReceipt;
  await assert.rejects(
    executionResult(receipt, task, clean, false, async () => {
      throw new Error("sqlite unavailable");
    }),
    /sqlite unavailable/,
  );
});
for (const [name, mutate] of [
  ["wrong run", (r) => (r.runId = "other")],
  ["accepted only", (r) => (r.summary = "accepted")],
  [
    "missing inner receipt",
    (r) => delete r.result.meta.agentMeta.terminalReceipt,
  ],
  [
    "wrong requested model",
    (r) => (r.result.meta.agentMeta.terminalReceipt.requested.model = "other"),
  ],
  ["aborted", (r) => (r.result.meta.aborted = true)],
  ["pending tools", (r) => (r.result.meta.pendingToolCalls = [{}])],
  ["timeout", (r) => (r.result.meta.stopReason = "timeout")],
  ["yielded", (r) => (r.result.meta.yielded = true)],
  ["error payload", (r) => (r.result.payloads[0].isError = true)],
])
  test(`SDK rejects ${name}`, () => {
    const r = final();
    mutate(r);
    assert.equal(finalResult(r, task, clean), null);
  });
test("persistent runtime evidence recovers without a model call", () => {
  const r = runtimeResult(runtime(), task, clean);
  assert.equal(r.result.status, "succeeded");
  assert.equal(r.result.completion_evidence.source, "gateway.runtime.no_tools");
  assert.equal(
    r.result.completion_evidence.validation_contract,
    "fmg-terminal-v2",
  );
  assert.equal(
    r.result.completion_evidence.receipt_hash,
    r.evidence.receipt_hash,
  );
});
for (const [name, mutate] of [
  ["missing end", (e) => e.pop()],
  ["duplicate end", (e) => (e[0] = e[4])],
  ["wrong run", (e) => (e[4].runId = "other")],
  ["wrong session", (e) => (e[4].sessionId = "other")],
  ["wrong community session key", (e) => (e[4].sessionKey = "other")],
  ["wrong model", (e) => (e[2].modelId = "other")],
  ["wrong effort", (e) => (e[1].data.model.thinkLevel = "low")],
  ["aborted", (e) => (e[4].data.aborted = true)],
  ["timeout", (e) => (e[4].data.timedOut = true)],
  ["wrong prompt", (e) => (e[2].data.finalPromptText = "other")],
  ["tool run", (e) => (e[3].data.toolMetas = [{}])],
  ["message sent", (e) => (e[3].data.didSendViaMessagingTool = true)],
  [
    "non final phase",
    (e) =>
      (e[2].data.messagesSnapshot.at(-1).content[0].textSignature =
        JSON.stringify({ id: "m", phase: "commentary" })),
  ],
  [
    "tool message",
    (e) => e[2].data.messagesSnapshot.unshift({ role: "toolResult" }),
  ],
  ["future end", (e) => (e[4].ts = new Date(Date.now() + 60000).toISOString())],
  ["reply mismatch", (e) => (e[3].data.assistantTexts[0] = "other")],
  [
    "missing response completion",
    (e) => (e[2].data.messagesSnapshot.at(-1).diagnostics = []),
  ],
  ["oversized evidence", (e) => (e[0].data.padding = "x".repeat(270000))],
])
  test(`runtime rejects ${name}`, () => {
    const e = runtime();
    mutate(e);
    assert.equal(runtimeResult(e, task, clean), null);
  });
