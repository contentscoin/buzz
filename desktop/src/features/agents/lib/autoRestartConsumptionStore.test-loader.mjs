const stubUrls = new Map([
  ["@/features/agents/hooks", "buzz-restart-stub:hooks"],
  [
    "@/features/agents/managedAgentRuntimeHooks",
    "buzz-restart-stub:runtime-hooks",
  ],
  ["@/shared/api/tauriManagedAgents", "buzz-restart-stub:managed-api"],
  ["@/shared/api/tauri", "buzz-restart-stub:tauri"],
  ["@/shared/lib/useDocumentVisible", "buzz-restart-stub:visible"],
]);

export function resolve(specifier, context, nextResolve) {
  const direct = stubUrls.get(specifier);
  if (direct) return { shortCircuit: true, url: direct };
  if (context.parentURL?.endsWith("/lib/useAutoRestartPolicy.ts")) {
    if (specifier === "../observerRelayStore") {
      return { shortCircuit: true, url: "buzz-restart-stub:observer" };
    }
    if (specifier === "../agentWorkingSignal") {
      return { shortCircuit: true, url: "buzz-restart-stub:working" };
    }
    if (specifier === "./autoRestartFailureStore") {
      return { shortCircuit: true, url: "buzz-restart-stub:failures" };
    }
  }
  if (specifier.startsWith("buzz-restart-stub:")) {
    return { shortCircuit: true, url: specifier };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  const sources = {
    "buzz-restart-stub:hooks": `
      export const managedAgentsQueryKey = ["managed-agents"];
      export function useManagedAgentsQuery() {
        return { data: globalThis.__restartTest.agents };
      }
    `,
    "buzz-restart-stub:runtime-hooks": `
      export function clearScopedActiveTurnsForAgentOnStop() {}
    `,
    "buzz-restart-stub:managed-api": `
      export async function stopManagedAgent(...args) {
        return globalThis.__restartTest.stopManagedAgent(...args);
      }
      export async function startManagedAgent(...args) {
        return globalThis.__restartTest.startManagedAgent(...args);
      }
    `,
    "buzz-restart-stub:tauri": `
      export async function getRelayWsUrl() {
        return globalThis.__restartTest.relayUrl;
      }
      export async function listManagedAgents() {
        return globalThis.__restartTest.agents;
      }
    `,
    "buzz-restart-stub:visible": `
      export function useDocumentVisible() { return true; }
    `,
    "buzz-restart-stub:observer": `
      export function getAgentObserverSnapshot() {
        return { connectionState: "open" };
      }
    `,
    "buzz-restart-stub:working": `
      export function getAgentWorkingState() {
        return { working: false, source: "none" };
      }
    `,
    "buzz-restart-stub:failures": `
      export function beginManualRestartRetry() { return false; }
      export function clearAutoRestartFailure() {}
      export function recordAutomaticRestartFailure() {
        globalThis.__restartTest.failureCount += 1;
      }
      export function recordManualRestartRetryFailure() {}
    `,
  };
  if (url in sources) {
    return { format: "module", shortCircuit: true, source: sources[url] };
  }
  return nextLoad(url, context);
}
