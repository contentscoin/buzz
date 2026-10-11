/** Bind closed read/shell tools and one-level runtime code orchestration to transcript roots. */
export function closedToolRoots(calls, results, transcriptCalls, transcriptResults) {
  const roots = [], nested = new Set();
  const facadeRows = [];
  for (const call of calls) {
    const id = call.data.toolCallId, name = call.data.name;
    const result = results.find((r) => r.data.toolCallId === id);
    const details = result.data.result?.details;
    const facade = name === "exec" && typeof call.data.args?.code === "string";
    if (name === "exec" && !facade && (details?.status !== "completed" ||
        details.exitCode !== 0 || details.exitSignal != null || details.exitReason !== "exit" ||
        details.noOutputTimedOut !== false || details.sessionId != null)) return null;
    if (!facade) continue;
    const telemetry = details?.telemetry;
    if (details?.status !== "completed" || details.sessionId != null || details.replaySafe !== false ||
        typeof telemetry?.counterScope !== "string" || !/^[a-f0-9]{24,64}$/.test(telemetry.counterScope) ||
        !["searchCount", "describeCount", "callCount", "catalogSize"].every((key) =>
          Number.isInteger(telemetry[key]) && telemetry[key] >= 0 && telemetry[key] <= 256) ||
        telemetry.sources?.mcp !== 0 || telemetry.sources?.client !== 0 ||
        telemetry.sources?.openclaw !== telemetry.catalogSize ||
        !Array.isArray(telemetry.visibleTools) || telemetry.visibleTools.length !== 2 ||
        telemetry.visibleTools[0] !== "exec" || telemetry.visibleTools[1] !== "wait") return null;
    const prefix = `tool_search_code:${id.replace(/[^a-zA-Z0-9_-]/g, "_")}:`;
    const children = calls.filter((c) => c !== call && c.data.toolCallId.startsWith(prefix));
    if (children.some((c) => nested.has(c) || typeof c.data.args?.code === "string" ||
        !new RegExp(`^(read|exec):[1-9][0-9]*$`).test(c.data.toolCallId.slice(prefix.length)) ||
        !c.data.toolCallId.slice(prefix.length).startsWith(c.data.name + ":") ||
        c.seq <= call.seq || results.find((r) => r.data.toolCallId === c.data.toolCallId).seq >= result.seq)) return null;
    children.forEach((c) => nested.add(c));
    facadeRows.push({ call, result, telemetry, children });
  }
  let previous;
  for (const row of facadeRows) {
    if (previous && (previous.result.seq >= row.call.seq ||
        row.telemetry.counterScope !== previous.telemetry.counterScope ||
        ["searchCount", "describeCount", "callCount"].some((k) => row.telemetry[k] < previous.telemetry[k]))) return null;
    if (row.telemetry.callCount - (previous?.telemetry.callCount ?? 0) !== row.children.length) return null;
    previous = row;
  }
  for (const call of calls) {
    if (nested.has(call)) continue;
    if (call.data.toolCallId.startsWith("tool_search_code:")) return null;
    roots.push(call);
    const matching = transcriptCalls.filter((item) => item.id === call.data.toolCallId && item.name === call.data.name);
    const matchingResults = transcriptResults.filter((m) => m.toolCallId === call.data.toolCallId &&
      m.toolName === call.data.name && m.isError === false);
    // Runtime diagnostic arguments are redacted/truncated. Bind exact runtime IDs,
    // their closed child lifecycle and the original private transcript, not the
    // diagnostic projection of source code. This proves completion, not semantic
    // enforcement of read-only instructions inside shell/code arguments.
    if (matching.length !== 1 || matchingResults.length !== 1 ||
        (typeof call.data.args?.code === "string" &&
          typeof matching[0].arguments?.code !== "string")) return null;
  }
  return transcriptCalls.length === roots.length && transcriptResults.length === roots.length ? roots : null;
}
