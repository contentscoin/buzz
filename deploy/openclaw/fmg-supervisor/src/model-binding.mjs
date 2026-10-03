import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function publicModel(reference) {
  if (typeof reference !== "string") return "not_reported";
  const model = reference.split("@")[0];
  return /^[a-z0-9_-]+\/[a-zA-Z0-9._:-]{1,100}$/.test(model)
    ? model
    : "not_reported";
}

export function roleModel(config, roleId) {
  const entry = config.agents?.entries?.[roleId];
  if (!entry) throw new Error("role_model_unavailable");
  const value = entry.model ?? config.agents?.defaults?.model;
  const reference = typeof value === "string" ? value : value?.primary;
  if (
    publicModel(reference) === "not_reported" ||
    reference.length > 500 ||
    Array.from(reference).some((char) => {
      const code = char.codePointAt(0);
      return code <= 32 || code === 127;
    })
  )
    throw new Error("role_model_unavailable");
  const effort =
    entry.thinkingDefault ??
    config.agents?.defaults?.thinkingDefault ??
    "medium";
  const model = publicModel(reference);
  const requiredReasoning = ["openai/gpt-6.1-sol", "openai/gpt-6-astra"];
  const optionalReasoning = ["openai/gpt-6-sol", "openai/gpt-6-luna"];
  const supportedEfforts = requiredReasoning.includes(model)
    ? ["low", "medium", "high", "xhigh", "max"]
    : optionalReasoning.includes(model)
      ? ["none", "low", "medium", "high", "xhigh", "max"]
      : [effort];
  if (
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    ) ||
    !supportedEfforts.includes(effort)
  )
    throw new Error("role_effort_invalid");
  return {
    reference,
    model,
    effort,
    supportedEfforts,
    binding: createHash("sha256")
      .update(`fmg-model-v2\0${roleId}\0${reference}\0${effort}`)
      .digest("hex"),
  };
}

export async function approvedExecution(proposal) {
  // Read the current local configuration, including its selected auth profile.
  // Only the public model and an opaque binding leave the Gateway.
  const config = JSON.parse(
    await readFile("/data/.openclaw/openclaw.json", "utf8"),
  );
  const selected = roleModel(config, proposal.role_id);
  if (
    proposal.schema !== 3 ||
    selected.model !== proposal.requested_model ||
    selected.binding !== proposal.model_binding ||
    !selected.supportedEfforts.includes(proposal.requested_effort)
  )
    throw new Error("approved_model_binding_changed");
  return { model: selected.reference, effort: proposal.requested_effort };
}
