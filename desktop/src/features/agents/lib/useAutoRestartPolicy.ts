import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  managedAgentsQueryKey,
  useManagedAgentsQuery,
} from "@/features/agents/hooks";
import { clearScopedActiveTurnsForAgentOnStop } from "@/features/agents/managedAgentRuntimeHooks";
import {
  startManagedAgent,
  stopManagedAgent,
} from "@/shared/api/tauriManagedAgents";
import { getRelayWsUrl, listManagedAgents } from "@/shared/api/tauri";
import type { ManagedAgent } from "@/shared/api/types";
import { useDocumentVisible } from "@/shared/lib/useDocumentVisible";
import { getAgentObserverSnapshot } from "../observerRelayStore";
import { getAgentWorkingState } from "../agentWorkingSignal";
import {
  decideAutoRestart,
  nextEdgeState,
  type AutoRestartEdgeState,
} from "./autoRestartPolicy";
import {
  beginManualRestartRetry,
  clearAutoRestartFailure,
  recordAutomaticRestartFailure,
  recordManualRestartRetryFailure,
} from "./autoRestartFailureStore";

/** How often the policy re-evaluates between summary refetches. Keeps the
 * continuity clock honest without waiting for the next 5s poll. */
const POLICY_TICK_MS = 15_000;

/** Shared across the policy loop and the explicit retry action in this
 * renderer. It prevents a card retry from racing the automatic attempt. */
const restartAttempts = new Set<string>();

function attemptKey(scope: string, pubkey: string) {
  return `${scope.trim().toLowerCase()}\n${pubkey.trim().toLowerCase()}`;
}

export function getAutoRestartFailureScope(
  relayUrl: string | null | undefined,
  signerPubkey: string | null | undefined,
): string | null {
  const relay = relayUrl?.trim().replace(/\/+$/, "").toLowerCase();
  const signer = signerPubkey?.trim().toLowerCase();
  return relay && signer ? `${relay}\n${signer}` : null;
}

function sameRelay(left: string, right: string) {
  return (
    left.trim().replace(/\/+$/, "").toLowerCase() ===
    right.trim().replace(/\/+$/, "").toLowerCase()
  );
}

async function performAutomaticRestart(
  scope: string,
  pubkey: string,
  expectedSignerPubkey: string,
): Promise<boolean> {
  // Pre-fire re-fetch: shrink the stale-decision window to ~0 and repeat every
  // safety gate whose value can change after the three-minute window elapses.
  const [fresh, activeRelayUrl] = await Promise.all([
    listManagedAgents(),
    getRelayWsUrl(),
  ]);
  const current = fresh.find((agent) => agent.pubkey === pubkey);
  const working = getAgentWorkingState(pubkey);
  const observer = getAgentObserverSnapshot(pubkey, true);
  if (
    !sameRelay(activeRelayUrl, scope) ||
    !current?.needsRestart ||
    !current.autoRestartOnConfigChange ||
    current.backend.type !== "local" ||
    current.status !== "running" ||
    observer.connectionState !== "open" ||
    working.working ||
    working.source !== "none"
  ) {
    return false;
  }

  await stopManagedAgent(pubkey, {
    expectedRelayUrl: scope,
    expectedSignerPubkey,
  });
  clearScopedActiveTurnsForAgentOnStop(
    pubkey,
    scope,
    expectedSignerPubkey,
  );
  await startManagedAgent(pubkey, {
    expectedRelayUrl: scope,
    expectedSignerPubkey,
  });
  return true;
}

/**
 * Run the single user-triggered retry exposed after an automatic restart
 * failure. A stopped agent means the automatic stop completed before start
 * failed, so retry only starts it. A still-running agent repeats the live
 * safety gates before doing another stop/start. No path schedules another
 * automatic or manual attempt.
 */
export async function retryFailedAutoRestart(
  relayScope: string,
  pubkey: string,
  expectedSignerPubkey: string,
): Promise<void> {
  const failureScope = getAutoRestartFailureScope(
    relayScope,
    expectedSignerPubkey,
  );
  if (!failureScope) return;
  if (!beginManualRestartRetry(failureScope, pubkey)) return;

  const key = attemptKey(failureScope, pubkey);
  if (restartAttempts.has(key)) {
    recordManualRestartRetryFailure(failureScope, pubkey);
    return;
  }
  restartAttempts.add(key);

  try {
    const [fresh, activeRelayUrl] = await Promise.all([
      listManagedAgents(),
      getRelayWsUrl(),
    ]);
    if (!sameRelay(activeRelayUrl, relayScope)) {
      throw new Error(
        "The active community changed. Return to the original community before retrying.",
      );
    }
    const normalizedPubkey = pubkey.trim().toLowerCase();
    const current = fresh.find(
      (agent) => agent.pubkey.trim().toLowerCase() === normalizedPubkey,
    );
    if (!current) {
      throw new Error("The agent is no longer available on this device.");
    }
    if (current.backend.type !== "local") {
      throw new Error("Only a local agent can be retried from this device.");
    }
    if (!current.autoRestartOnConfigChange) {
      throw new Error(
        "Automatic restart is disabled for this agent. Start it from the agent profile instead.",
      );
    }

    if (current.status === "running") {
      const working = getAgentWorkingState(pubkey);
      const observer = getAgentObserverSnapshot(pubkey, true);
      if (
        observer.connectionState !== "open" ||
        working.working ||
        working.source !== "none"
      ) {
        throw new Error(
          "The agent is active or disconnected. Wait until it is connected and idle, then restart it from the agent profile.",
        );
      }
      await stopManagedAgent(pubkey, {
        expectedRelayUrl: relayScope,
        expectedSignerPubkey,
      });
      clearScopedActiveTurnsForAgentOnStop(
        pubkey,
        relayScope,
        expectedSignerPubkey,
      );
    } else if (current.status !== "stopped") {
      throw new Error(
        "This agent is not in a local state that can be restarted here.",
      );
    }

    await startManagedAgent(pubkey, {
      expectedRelayUrl: relayScope,
      expectedSignerPubkey,
    });
    clearAutoRestartFailure(failureScope, pubkey);
  } catch {
    recordManualRestartRetryFailure(failureScope, pubkey);
  } finally {
    restartAttempts.delete(key);
  }
}

/**
 * Chunk F policy loop: watches managed-agent summaries and auto-restarts
 * drifted, idle, connected, local agents (per-agent opt-out, default ON).
 *
 * All decision logic lives in `decideAutoRestart` (pure, exhaustively
 * tested). This hook only wires inputs, owns per-pubkey edge state, and
 * calls the existing stop/start commands — both idempotent and serialized
 * on the backend store lock, so a cross-window double-fire is benign (and
 * further shrunk by the pre-fire summary re-fetch).
 */
export function useAutoRestartPolicy(
  scope: string | null | undefined,
  expectedSignerPubkey: string | null | undefined,
) {
  const queryClient = useQueryClient();
  const agents: ManagedAgent[] | undefined = useManagedAgentsQuery().data;
  const edgesRef = React.useRef(new Map<string, AutoRestartEdgeState>());
  const failureScope = getAutoRestartFailureScope(scope, expectedSignerPubkey);
  const tenantKey = failureScope ?? "";
  const edgeTenantRef = React.useRef(tenantKey);
  const [, setTick] = React.useState(0);
  const documentVisible = useDocumentVisible();

  // Re-evaluate on an interval so the quiescence clock advances even when
  // summaries and observer stores are quiet.
  React.useEffect(() => {
    if (!documentVisible) return;

    setTick((t) => t + 1);
    const timer = setInterval(() => setTick((t) => t + 1), POLICY_TICK_MS);
    return () => clearInterval(timer);
  }, [documentVisible]);

  // No dependency array by design: the tick pattern re-runs this effect
  // every render so it reads live store state; all mutation is ref-local.
  React.useEffect(() => {
    if (!agents || !scope || !expectedSignerPubkey || !failureScope) return;
    const now = Date.now();
    const edges = edgesRef.current;
    if (edgeTenantRef.current !== tenantKey) {
      edges.clear();
      edgeTenantRef.current = tenantKey;
    }

    for (const agent of agents) {
      const isRunning = agent.status === "running";
      const edge = nextEdgeState(edges.get(agent.pubkey), {
        needsRestart: agent.needsRestart,
        isRunning,
      });

      const working = getAgentWorkingState(agent.pubkey);
      const observer = getAgentObserverSnapshot(agent.pubkey, true);

      const decision = decideAutoRestart({
        autoRestartEnabled: agent.autoRestartOnConfigChange,
        needsRestart: agent.needsRestart,
        working: working.working,
        workingSource: working.source,
        connected: observer.connectionState === "open",
        isLocalBackend: agent.backend.type === "local",
        isRunning,
        edgeConsumed: edge.consumed,
        quiescentForMs: edge.armedAt === null ? 0 : now - edge.armedAt,
      });

      // A successful start elsewhere resolves an earlier automatic failure.
      // Keep the failure for a stopped agent: stop may have succeeded before
      // the failed start, and `needsRestart` is always false while stopped.
      if (isRunning && !agent.needsRestart) {
        clearAutoRestartFailure(failureScope, agent.pubkey);
      }

      if (decision === "hold") {
        edges.set(agent.pubkey, { ...edge, armedAt: null });
        continue;
      }
      if (decision === "arm") {
        edges.set(agent.pubkey, {
          ...edge,
          armedAt: edge.armedAt ?? now,
        });
        continue;
      }

      // decision === "fire"
      const key = attemptKey(failureScope, agent.pubkey);
      if (restartAttempts.has(key)) continue;
      restartAttempts.add(key);
      // The in-flight set prevents duplicate attempts. Reset continuity now,
      // but consume the edge only if the pre-fire recheck reaches a restart or
      // fails. A transient recheck that returns false must be able to re-arm.
      edges.set(agent.pubkey, { consumed: false, armedAt: null });

      void (async () => {
        try {
          const restarted = await performAutomaticRestart(
            scope,
            agent.pubkey,
            expectedSignerPubkey,
          );
          if (edgeTenantRef.current === tenantKey) {
            edgesRef.current.set(agent.pubkey, {
              consumed: restarted,
              armedAt: null,
            });
          }
          if (restarted) {
            clearAutoRestartFailure(failureScope, agent.pubkey);
          }
        } catch {
          if (edgeTenantRef.current === tenantKey) {
            edgesRef.current.set(agent.pubkey, {
              consumed: true,
              armedAt: null,
            });
          }
          // Keep the edge consumed and publish a durable renderer-level
          // failure with exactly one explicit user retry. There is no timer or
          // effect that consumes that retry, so persistent failures cannot
          // turn into a loop.
          recordAutomaticRestartFailure(failureScope, agent.pubkey);
        } finally {
          restartAttempts.delete(key);
          void queryClient.invalidateQueries({
            queryKey: managedAgentsQueryKey,
          });
        }
      })();
    }

    // Drop edge state for agents that no longer exist.
    const known = new Set(agents.map((a) => a.pubkey));
    for (const pubkey of edges.keys()) {
      if (!known.has(pubkey)) {
        edges.delete(pubkey);
        clearAutoRestartFailure(failureScope, pubkey);
      }
    }
  });
}
