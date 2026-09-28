#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function asObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => typeof value === "string" && value === b[index]);
}

export function probeAuthoritativeBuzzAdminList(response) {
  const envelope = asObject(response, "plugins.list response");
  const direct = Array.isArray(envelope.plugins);
  const wrapped =
    envelope.result !== null &&
    typeof envelope.result === "object" &&
    !Array.isArray(envelope.result) &&
    Array.isArray(envelope.result.plugins);
  if (direct === wrapped) {
    throw new Error("plugins.list response must contain exactly one supported envelope");
  }
  const payload = direct ? envelope : envelope.result;
  if (!Number.isSafeInteger(payload.generation) || payload.generation < 1) {
    throw new Error("plugins.list generation must be a positive safe integer");
  }
  const matches = payload.plugins.filter((plugin) => plugin?.id === "buzz-admin");
  if (matches.length === 0) {
    return { generation: payload.generation, state: "absent" };
  }
  if (matches.length !== 1) throw new Error("plugins.list contains duplicate buzz-admin records");
  const plugin = asObject(matches[0], "buzz-admin list record");
  const runtime = asObject(plugin.runtime, "buzz-admin runtime record");
  if (
    plugin.enabled === false &&
    plugin.state === "disabled" &&
    (runtime.state === "disabled" || runtime.state === "unloaded")
  ) {
    return { generation: payload.generation, state: "disabled" };
  }
  if (plugin.enabled === true && plugin.state === "enabled" && runtime.state === "active") {
    return { generation: payload.generation, state: "active" };
  }
  throw new Error("buzz-admin lifecycle state is neither quiescent nor active");
}

export function classifyAuthoritativeBuzzAdmin({ list, listAfter, inspect, expected }) {
  const probe = probeAuthoritativeBuzzAdminList(list);
  const confirmation = probeAuthoritativeBuzzAdminList(listAfter);
  if (
    probe.generation !== confirmation.generation ||
    probe.state !== confirmation.state
  ) {
    throw new Error("plugins.list generation or buzz-admin state changed during inspection");
  }
  if (probe.state === "absent") return { ...probe, match: "absent" };

  const report = asObject(inspect, "plugins.inspect response");
  const plugin = asObject(report.plugin, "plugins.inspect plugin");
  const source = asObject(report.source, "plugins.inspect source");
  const declared = asObject(report.declared, "plugins.inspect declared surface");
  const wanted = asObject(expected, "expected plugin identity");
  if (
    typeof plugin.enabled !== "boolean" ||
    typeof plugin.installed !== "boolean" ||
    !Array.isArray(declared.tools) ||
    !Array.isArray(declared.dangerousConfigFlags) ||
    !Array.isArray(wanted.tools)
  ) {
    throw new Error("plugins.inspect response has an invalid identity schema");
  }
  if (plugin.enabled !== (probe.state === "active")) {
    throw new Error("plugins.inspect enabled state disagrees with plugins.list");
  }
  const exact =
    report.ok === true &&
    plugin.id === "buzz-admin" &&
    plugin.installed === true &&
    String(plugin.version) === wanted.version &&
    source.kind === "npm" &&
    source.packageName === wanted.package &&
    source.spec === `${wanted.package}@${wanted.version}` &&
    source.integrity === wanted.integrity &&
    source.integrityKind === "ssri" &&
    sameStrings(declared.tools, wanted.tools) &&
    declared.dangerousConfigFlags.length === 0;
  return { ...probe, match: exact ? "exact" : "mismatch" };
}

export function planBuzzAdminReconciliation(classification, phase) {
  const { state, match } = classification;
  if (phase === "initial") {
    if (state === "absent" && match === "absent") return "install";
    if (state === "disabled" && match === "mismatch") return "install";
    if (state === "disabled" && match === "exact") return "resume-disabled";
    if (state === "active" && match === "exact") return "resume-active";
    if (state === "active" && match === "mismatch") {
      throw new Error("active buzz-admin does not match the release descriptor");
    }
  } else if (phase === "post") {
    if (state === "disabled" && match === "exact") return "enable";
    if (state === "active" && match === "exact") return "verify";
  } else {
    throw new Error("reconciliation phase must be initial or post");
  }
  throw new Error(`unsupported buzz-admin reconciliation state: ${state}:${match}`);
}

export function evaluateBuzzAdminReconciliation(payload) {
  const input = asObject(payload, "reconciliation input");
  if (input.phase === "probe") return probeAuthoritativeBuzzAdminList(input.list);
  const classification = classifyAuthoritativeBuzzAdmin(input);
  return {
    ...classification,
    action: planBuzzAdminReconciliation(classification, input.phase),
  };
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(evaluateBuzzAdminReconciliation(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
