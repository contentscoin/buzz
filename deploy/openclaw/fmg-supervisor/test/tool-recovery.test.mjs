import assert from "node:assert/strict";
import { test } from "node:test";
import { toolRuntimeResult } from "../src/tool-recovery.mjs";
import { executionResult } from "../src/execution-result.mjs";

const run = "76fc8565-8b9e-4c71-8a80-736b6eca5178";
const clean = (text, n) => typeof text === "string" ? text.slice(0, n) : null;
function fixture() {
  const now = Date.now() - 10000;
  const task = { task_id: run, run_id: run, created_at: (now-1000)/1000,
    dispatch_stage: "intent_recorded", proposal_hash: "a".repeat(64),
    proposal: { role_id: "fmg-frontend", session_key: `agent:fmg-frontend:fmg-task:${run}`,
      requested_model: "openai/gpt-6.1-sol", requested_effort: "medium",
      instructions: "승인된 작업", model_binding: "b".repeat(64) } };
  const flags = { aborted: false, externalAbort: false, timedOut: false,
    idleTimedOut: false, timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false, timedOutByRunBudget: false };
  const metas = [{ toolCallId: "read-1", toolName: "read", isError: false },
    { toolCallId: "exec-1", toolName: "exec", isError: false }];
  const data = [
    ["session.started", { agentId: task.proposal.role_id }],
    ["trace.metadata", { model: { thinkLevel: "medium" } }],
    ["tool.call", { toolCallId: "read-1", name: "read" }],
    ["tool.result", { toolCallId: "read-1", name: "read", success: true, result: {} }],
    ["tool.call", { toolCallId: "exec-1", name: "exec" }],
    ["tool.result", { toolCallId: "exec-1", name: "exec", success: true,
      result: { details: { status: "completed", exitCode: 0, exitReason: "exit", noOutputTimedOut: false } } }],
    ["model.completed", { ...flags, stopReason: "stop", promptErrorSource: null,
      finalPromptText: task.proposal.instructions, assistantTexts: ["완료"],
      messagesSnapshot: ["<truncated>"] }],
    ["trace.artifacts", { ...flags, stopReason: "stop", finalStatus: "success",
      promptErrorSource: null, finalPromptText: task.proposal.instructions,
      assistantTexts: ["완료"], toolMetas: metas,
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
      didSendViaMessagingTool: false, successfulCronAdds: 0, messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [], messagingToolSentTargets: [] }],
    ["session.ended", { ...flags, status: "success", stopReason: "stop" }],
  ];
  const events = data.map(([type, data], seq) => ({ type, data, seq,
    traceSchema: "openclaw-trajectory", schemaVersion: 1, source: "runtime",
    runId: run, sessionId: "session", sessionKey: task.proposal.session_key,
    provider: "openai", modelId: "gpt-6.1-sol", ts: new Date(now+seq*100).toISOString() }));
  const final = { role: "assistant", provider: "openai", model: "gpt-6.1-sol", stopReason: "stop",
    content: [{ type: "text", text: "완료", textSignature: JSON.stringify({ id: "message", phase: "final_answer" }) }],
    diagnostics: [{ type: "openai_responses_terminal", details: { eventType: "response.completed", stopReason: "stop" } }] };
  const messages = [{ role: "user" }];
  for (const meta of metas) messages.push(
    { role: "assistant", provider: "openai", model: "gpt-6.1-sol", stopReason: "toolUse",
      content: [{ type: "toolCall", id: meta.toolCallId, name: meta.toolName }] },
    { role: "toolResult", toolCallId: meta.toolCallId, toolName: meta.toolName, isError: false });
  messages.push(final);
  const transcript = messages.map((message) => ({ type: "message", message, timestamp: new Date(now+650).toISOString() }));
  return { task, events, transcript, entry: { sessionId: "session", status: "done",
    lastRunId: run, endedAt: now+800, abortedLastRun: false } };
}

function facadeFixture() {
  const f = fixture();
  const parent = f.events[2], result = f.events[3];
  const id = "call_root|response_root", child = "tool_search_code:call_root_response_root:read:1";
  parent.data = { toolCallId: id, name: "exec", args: { code: "return await read({path:'README.md'});" } };
  result.data = { toolCallId: id, name: "exec", success: true, result: { details: {
    status: "completed", replaySafe: false, telemetry: { counterScope: "a".repeat(32),
      catalogSize: 39, sources: { openclaw: 39, mcp: 0, client: 0 },
      searchCount: 0, describeCount: 0, callCount: 1, visibleTools: ["exec", "wait"] } } } };
  const childCall = { ...structuredClone(parent), data: { toolCallId: child, name: "read", args: {path:"README.md"} } };
  const childResult = { ...structuredClone(result), data: { toolCallId: child, name: "read", success: true, result: {} } };
  f.events.splice(3, 0, childCall, childResult);
  const start = Date.parse(f.events[0].ts);
  f.events.forEach((e, i) => { e.seq = i; e.ts = new Date(start+i*100).toISOString(); });
  f.entry.endedAt = Date.parse(f.events.at(-1).ts);
  const artifacts = f.events.find(e=>e.type==="trace.artifacts");
  artifacts.data.toolMetas[0] = { toolCallId: id, toolName: "exec", isError: false };
  artifacts.data.toolMetas.push({ toolCallId: child, toolName: "read", isError: false });
  artifacts.data.itemLifecycle.startedCount = artifacts.data.itemLifecycle.completedCount = 3;
  f.transcript[1].message.content[0] = { type: "toolCall", id, name: "exec", arguments: parent.data.args };
  f.transcript[2].message.toolCallId = id;
  f.transcript[2].message.toolName = "exec";
  parent.data.args = {code:"[Malfo…ted]"};
  result.data.result.details.telemetry.counterScope = "a".repeat(24);
  return f;
}

test("persisted Luna final text with private reasoning metadata recovers after cache expiry", () => {
  const f = facadeFixture();
  f.task.proposal.requested_model = "openai/gpt-6-luna";
  f.events.forEach(e => { e.modelId = "gpt-6-luna"; });
  f.transcript.filter(e => e.message?.role === "assistant").forEach(e => { e.message.model = "gpt-6-luna"; });
  const final = f.transcript.at(-1).message;
  final.content.unshift({type:"thinking",thinking:"private metadata must never be returned"});
  const recovered = toolRuntimeResult(f.events, f.transcript, f.entry, f.task, clean);
  assert.equal(recovered.result.reply, "완료");
  assert.equal(recovered.result.actual_model, "openai/gpt-6-luna");
  assert.equal(JSON.stringify(recovered).includes("private metadata"), false);
});
for (const [name, mutate] of [
  ["unsigned visible text", c => c.unshift({type:"text",text:"other"})],
  ["unfinished tool call", c => c.unshift({type:"toolCall",id:"unfinished",name:"exec"})],
  ["unknown block", c => c.unshift({type:"unknown"})],
  ["reasoning after final", c => c.push({type:"thinking"})],
  ["oversized block count", c => c.unshift(...Array.from({length:16},()=>({type:"thinking"})))],
]) test(`persisted final metadata rejects ${name}`, () => {
  const f=facadeFixture(); mutate(f.transcript.at(-1).message.content);
  assert.equal(toolRuntimeResult(f.events,f.transcript,f.entry,f.task,clean),null);
});

test("closed runtime facade read binds its root transcript and nested lifecycle", () => {
  const f = facadeFixture();
  const recovered = toolRuntimeResult(f.events, f.transcript, f.entry, f.task, clean);
  assert.equal(recovered.result.status, "succeeded");
  assert.equal(recovered.result.completion_evidence.validation_contract, "fmg-terminal-v3");
});

for (const [name, mutate] of [
  ["parent mismatch", f=>f.events[3].data.toolCallId = "tool_search_code:foreign:read:1"],
  ["untraced facade call", f=>f.events[5].data.result.details.telemetry.callCount = 2],
  ["unfinished facade", f=>f.events[5].data.result.details.status = "running"],
  ["background facade", f=>f.events[5].data.result.details.sessionId = "running"],
  ["foreign runtime source", f=>f.events[5].data.result.details.telemetry.sources.mcp = 1],
  ["missing telemetry", f=>delete f.events[5].data.result.details.telemetry],
  ["missing original code", f=>f.transcript[1].message.content[0].arguments = {}],
  ["borrowed child order", f=>f.events[3].seq = 1],
  ["nested unclosed shell", f=>{f.events[3].data.name = "exec";}],
  ["borrowed root transcript", f=>f.transcript[1].message.content[0].id = "other"],
]) test(`facade completion rejects ${name}`, () => {
  const f=facadeFixture();mutate(f);
  assert.equal(toolRuntimeResult(f.events,f.transcript,f.entry,f.task,clean),null);
});

test("live dispatch connects the same strict closed-tool reader without execution retry", async () => {
  const f=facadeFixture();f.task.status="dispatching";
  const receipt={runId:f.task.run_id,status:"ok",summary:"completed",result:{payloads:[{text:"완료"}],meta:{stopReason:"stop",livenessState:"working",agentMeta:{provider:"openai",model:"gpt-6.1-sol"}}}};
  let reads=0;
  const result=await executionResult(receipt,f.task,clean,false,async()=>null,async(task,sanitize)=>{
    reads++;return toolRuntimeResult(f.events,f.transcript,f.entry,task,sanitize);
  });
  assert.equal(reads,1);assert.equal(result.status,"succeeded");
  assert.equal(result.completion_evidence.source,"gateway.runtime.read_exec");
  f.task.status="needs_reconcile";
  assert.equal(await executionResult(receipt,f.task,clean,false,async()=>null,async()=>{
    assert.fail("historical task requires direct owner recovery");
  }),null);
});

test("durable closed read/exec turn requires the original transcript final answer", () => {
  const { events, transcript, entry, task } = fixture();
  const recovered = toolRuntimeResult(events, transcript, entry, task, clean);
  assert.equal(recovered.result.status, "succeeded");
  assert.equal(recovered.result.reply, "완료");
  assert.equal(recovered.result.completion_evidence.source, "gateway.runtime.read_exec");
  assert.equal(recovered.result.completion_evidence.validation_contract, "fmg-terminal-v3");
  assert.equal(recovered.evidence.receipt_hash, recovered.result.completion_evidence.receipt_hash);
});

for (const [name, mutate] of [
  ["wrong run", (f) => f.events[0].runId = "other"],
  ["foreign session", (f) => f.events[0].sessionId = "other"],
  ["foreign community session key", (f) => f.events[0].sessionKey = "other"],
  ["wrong model", (f) => f.events[0].modelId = "other"],
  ["wrong effort", (f) => f.events[1].data.model.thinkLevel = "low"],
  ["wrong prompt", (f) => f.events[6].data.finalPromptText = "other"],
  ["missing end", (f) => f.events.pop()],
  ["duplicate end", (f) => f.events[0] = f.events.at(-1)],
  ["unordered events", (f) => [f.events[2],f.events[3]] = [f.events[3],f.events[2]]],
  ["future event", (f) => f.events[8].ts = new Date(Date.now()+10000).toISOString()],
  ["aborted", (f) => f.events[8].data.aborted = true],
  ["missing end flag", (f) => delete f.events[8].data.timedOut],
  ["timed out", (f) => f.events[6].data.timedOut = true],
  ["tool continuation stop", (f) => f.events[8].data.stopReason = "toolUse"],
  ["active tool", (f) => f.events[7].data.itemLifecycle.activeCount = 1],
  ["missing tool result", (f) => f.events.splice(3,1)],
  ["duplicate tool ID", (f) => f.events[4].data.toolCallId = "read-1"],
  ["foreign tool result", (f) => f.events[3].data.toolCallId = "other"],
  ["unknown tool", (f) => f.events[2].data.name = "message"],
  ["tool failure", (f) => f.events[3].data.success = false],
  ["reported tool error", (f) => f.events[3].data.result.isError = true],
  ["meta error", (f) => f.events[7].data.toolMetas[0].isError = true],
  ["background exec", (f) => f.events[5].data.result.details.status = "running"],
  ["exec session still present", (f) => f.events[5].data.result.details.sessionId = "running"],
  ["exec failure", (f) => f.events[5].data.result.details.exitCode = 1],
  ["exec timeout", (f) => f.events[5].data.result.details.noOutputTimedOut = true],
  ["delivery", (f) => f.events[7].data.didSendViaMessagingTool = true],
  ["cron", (f) => f.events[7].data.successfulCronAdds = 1],
  ["session working", (f) => f.entry.status = "working"],
  ["foreign session last run", (f) => f.entry.lastRunId = "other"],
  ["foreign session ID", (f) => f.entry.sessionId = "other"],
  ["session aborted", (f) => f.entry.abortedLastRun = true],
  ["missing final response", (f) => f.transcript.pop()],
  ["extra user turn", (f) => f.transcript.unshift({ type: "message", message: { role: "user" } })],
  ["foreign final model", (f) => f.transcript.at(-1).message.model = "other"],
  ["nonfinal signature", (f) => f.transcript.at(-1).message.content[0].textSignature = JSON.stringify({ id: "msg", phase: "commentary" })],
  ["missing provider completion", (f) => f.transcript.at(-1).message.diagnostics = []],
  ["final reply mismatch", (f) => f.transcript.at(-1).message.content[0].text = "other"],
  ["transcript tool failure", (f) => f.transcript[2].message.isError = true],
  ["truncated final message", (f) => f.transcript.at(-1).message = { truncated: true }],
  ["oversized transcript", (f) => f.transcript[0].padding = "x".repeat(262144)],
  ["oversized events", (f) => f.events[0].padding = "x".repeat(262144)],
  ["unknown event", (f) => f.events[2].type = "runtime.restarted"],
]) test(`durable recovery denies ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.equal(toolRuntimeResult(f.events, f.transcript, f.entry, f.task, clean), null);
});
