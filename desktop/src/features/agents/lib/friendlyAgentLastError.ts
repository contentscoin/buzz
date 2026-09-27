/**
 * Promote certain machine-readable `lastError` strings to user-facing copy.
 *
 * The error classification seam flows like this:
 *   buzz-agent — classifies LLM failures into `AgentError` variants with
 *                  JSON-RPC codes (`-32001` auth, `-32002` model-not-found,
 *                  `-32000` generic), defined in `crates/buzz-agent/src/types.rs`.
 *   buzz-acp   — preserves the code structurally in
 *                  `AcpError::AgentError { code, message }`, whose Display is
 *                  `"Agent reported error (code N): message"`, and includes
 *                  `code` in `turn_error` observer events.
 *   desktop supervisor — on nonzero exit, recovers `{ message, code }` from
 *                  the log tail (`managed_agents/storage.rs`) into
 *                  `ManagedAgent.lastError` / `lastErrorCode`.
 *
 * This function first preserves explicit community/relay source language,
 * then dispatches on a structured numeric code. It can recover that code from
 * the message when `lastErrorCode` was lost, and finally falls back to legacy
 * string prefixes for records written before structured codes existed.
 *
 * `friendlyAgentLastError` keeps the established display-only return shape.
 * Interactive renderers use `classifyAgentLastError`, which adds a typed
 * category and recovery route without making them inspect copy or codes.
 */
export type AgentErrorCategory =
  | "community-access"
  | "provider-auth"
  | "model"
  | "runtime-setup"
  | "generic";

export type AgentRecoveryTarget =
  | "community-membership"
  | "edit-agent"
  | "edit-model"
  | "agent-runtimes"
  | "runtime-details";

export type FriendlyAgentLastError = {
  severity: "denied" | "generic";
  copy: string;
};

export type ClassifiedAgentLastError = FriendlyAgentLastError & {
  category: AgentErrorCategory;
  recovery: {
    target: AgentRecoveryTarget;
    label: string;
  };
};

/**
 * Exact copy for a denial that explicitly identifies community access or
 * membership as its source.
 */
export const COMMUNITY_ACCESS_DENIED_COPY =
  "Community access denied this agent — check its community membership.";

export const PROVIDER_AUTH_DENIED_COPY =
  "The model provider rejected this agent's credentials — update its provider or API key.";

/**
 * Backward-compatible export name. The old implementation used this constant
 * for `-32001`, which is a provider-auth code, so its value now reflects that
 * source rather than claiming the community denied access.
 */
export const RELAY_MESH_DENIED_COPY = PROVIDER_AUTH_DENIED_COPY;

export const MODEL_NOT_FOUND_COPY =
  "The configured model is not available — open agent settings and select a different one from the dropdown.";

export const CLI_ACP_INTERNAL_ERROR_COPY =
  "The agent adapter reported an internal error. Open Agent runtimes to update or reinstall the adapter, then check the selected model.";

const EMBEDDED_CODE_RE = /^Agent reported error \(code (-?\d+)\): /;
/** Bare form of the standard JSON-RPC -32603 message (after stripping the ACP wrapper prefix). */
const BARE_INTERNAL_ERROR = "Internal error";
const COMMUNITY_ACCESS_RE =
  /(?:community access denied|community membership|relay membership|not a channel member|channel .*access denied|restricted:\s*not a channel member)/i;
const RUNTIME_SETUP_RE =
  /(?:failed to spawn|not found in path|command not found|is not recognized as an internal or external command|no such file or directory|cannot find the (?:file|path) specified|os error 2|adapter (?:is )?(?:missing|outdated|not installed)|runtime (?:is )?not installed|cli (?:is )?not installed|executable .*not found)/i;

function classified(
  category: AgentErrorCategory,
  severity: ClassifiedAgentLastError["severity"],
  copy: string,
  target: AgentRecoveryTarget,
  label: string,
): ClassifiedAgentLastError {
  return { category, severity, copy, recovery: { target, label } };
}

function recoverEmbeddedCode(trimmed: string): {
  code: number;
  remainder: string;
} | null {
  const match = EMBEDDED_CODE_RE.exec(trimmed);
  if (!match) return null;
  return {
    code: Number(match[1]),
    remainder: trimmed.slice(match[0].length),
  };
}

export function classifyAgentLastError(
  raw: string | null,
  code?: number | null,
): ClassifiedAgentLastError | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Structured code first; a code embedded in the message string is the
  // same signal recovered from a record that lost the field.
  const embedded = recoverEmbeddedCode(trimmed);
  const unwrapped = embedded?.remainder ?? trimmed;

  // Relay/community denials carry explicit source language. Check that before
  // the JSON-RPC number because -32001 is the native buzz-agent LLM-provider
  // auth code and must not turn every provider credential failure into a
  // community membership diagnosis.
  if (COMMUNITY_ACCESS_RE.test(unwrapped)) {
    return classified(
      "community-access",
      "denied",
      COMMUNITY_ACCESS_DENIED_COPY,
      "community-membership",
      "Review channels",
    );
  }

  const effectiveCode = Number.isFinite(code)
    ? (code as number)
    : (embedded?.code ?? null);
  if (effectiveCode != null) {
    switch (effectiveCode) {
      case -32001:
        return classified(
          "provider-auth",
          "denied",
          PROVIDER_AUTH_DENIED_COPY,
          "edit-agent",
          "Review agent settings",
        );
      case -32002:
        return classified(
          "model",
          "denied",
          MODEL_NOT_FOUND_COPY,
          "edit-model",
          "Change model",
        );
      case -32603: {
        // Standard JSON-RPC "Internal error" — emitted by external harnesses
        // (e.g. codex-acp) when the configured model is unsupported. Only
        // substitute the hint when the message is the bare "Internal error"
        // form; if the adapter included specific detail, preserve it so we
        // don't bury actionable information with a broad codex-specific hint.
        //
        // "Bare" means the remainder after stripping the ACP wrapper prefix
        // (if present) is exactly "Internal error". This covers both the raw
        // form ("Internal error") and the ACP-wrapped form
        // ("Agent reported error (code -32603): Internal error").
        const remainder = embedded?.remainder ?? trimmed;
        if (remainder === BARE_INTERNAL_ERROR) {
          return classified(
            "runtime-setup",
            "generic",
            CLI_ACP_INTERNAL_ERROR_COPY,
            "agent-runtimes",
            "Open Agent runtimes",
          );
        }
        return classified(
          "generic",
          "generic",
          remainder,
          "runtime-details",
          "View logs and restart",
        );
      }
    }
    // A structured code we don't recognize is authoritative — don't let
    // string patterns cross-classify it.
    return classified(
      "generic",
      "generic",
      trimmed,
      "runtime-details",
      "View logs and restart",
    );
  }

  // Legacy string fallback for records written before codes existed.
  // Match either the unwrapped buzz-agent prefix or the buzz-acp v0 wrap.
  if (
    trimmed.startsWith("Agent reported error: llm auth:") ||
    trimmed.startsWith("llm auth:")
  ) {
    return classified(
      "provider-auth",
      "denied",
      PROVIDER_AUTH_DENIED_COPY,
      "edit-agent",
      "Review agent settings",
    );
  }

  if (RUNTIME_SETUP_RE.test(trimmed)) {
    return classified(
      "runtime-setup",
      "generic",
      trimmed,
      "agent-runtimes",
      "Open Agent runtimes",
    );
  }

  return classified(
    "generic",
    "generic",
    trimmed,
    "runtime-details",
    "View logs and restart",
  );
}

export function friendlyAgentLastError(
  raw: string | null,
  code?: number | null,
): FriendlyAgentLastError | null {
  const result = classifyAgentLastError(raw, code);
  return result ? { severity: result.severity, copy: result.copy } : null;
}

/**
 * Convenience for `turn_error` / `agent_panic` observer payloads: coerce the
 * payload's untyped `code` JSON value and return the display copy, falling
 * back to the raw error text when no classification applies.
 */
export function friendlyTurnErrorCopy(raw: string, code: unknown): string {
  const numeric = code == null ? null : Number(code);
  const safe = Number.isFinite(numeric) ? (numeric as number) : null;
  return friendlyAgentLastError(raw, safe)?.copy ?? raw;
}
