import * as React from "react";
import { toast } from "sonner";

import {
  isManagedAgentActive,
  type ManagedAgentCommandScope,
  respawnManagedAgentWithRules,
  type StartManagedAgentCommand,
  startManagedAgentWithRules,
  type StopManagedAgentCommand,
  stopManagedAgentWithRules,
} from "@/features/agents/lib/managedAgentControlActions";
import { agentPresenceStartBlockReason } from "@/features/agents/lib/useAgentAvailability";
import { clearScopedActiveTurnsForAgentOnStop } from "@/features/agents/managedAgentRuntimeHooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import type {
  Channel,
  ManagedAgent,
  RelayAgent,
  PresenceStatus,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export function useAgentLifecycleActions({
  availability,
  channels,
  managedAgent,
  relayAgents,
  startManagedAgent,
  stopManagedAgent,
}: {
  availability: PresenceStatus | undefined;
  channels: readonly Channel[] | undefined;
  managedAgent: ManagedAgent | undefined;
  relayAgents: readonly RelayAgent[] | undefined;
  startManagedAgent: (
    input:
      | string
      | {
          pubkey: string;
          expectedRelayUrl?: string;
          expectedSignerPubkey?: string;
        },
  ) => Promise<unknown>;
  stopManagedAgent: (
    input:
      | string
      | {
          pubkey: string;
          expectedRelayUrl?: string;
          expectedSignerPubkey?: string;
        },
  ) => Promise<unknown>;
}) {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const captureCommandScope =
    React.useCallback((): ManagedAgentCommandScope => {
      const expectedRelayUrl = activeCommunity?.relayUrl?.trim()
        ? activeCommunity.relayUrl
        : undefined;
      const expectedSignerPubkey =
        normalizePubkey(identityQuery.data?.pubkey ?? "") || undefined;
      if (!expectedRelayUrl || !expectedSignerPubkey) {
        throw new Error(
          "Buzz is still connecting to this community. Try again in a moment.",
        );
      }
      return { expectedRelayUrl, expectedSignerPubkey };
    }, [activeCommunity?.relayUrl, identityQuery.data?.pubkey]);
  const startManagedAgentCommand = React.useCallback<StartManagedAgentCommand>(
    (pubkey, options) => startManagedAgent({ pubkey, ...options }),
    [startManagedAgent],
  );
  const stopManagedAgentCommand = React.useCallback<StopManagedAgentCommand>(
    (pubkey, options) => stopManagedAgent({ pubkey, ...options }),
    [stopManagedAgent],
  );

  const handleAgentPrimaryAction = React.useCallback(async () => {
    if (!managedAgent) return;

    try {
      const scope = captureCommandScope();
      if (isManagedAgentActive(managedAgent)) {
        const result = await stopManagedAgentWithRules({
          agent: managedAgent,
          channels: channels ?? [],
          relayAgents: relayAgents ?? [],
          scope,
          stopManagedAgent: stopManagedAgentCommand,
        });
        if (managedAgent.backend.type === "local") {
          clearScopedActiveTurnsForAgentOnStop(
            managedAgent.pubkey,
            scope.expectedRelayUrl,
            scope.expectedSignerPubkey,
          );
        }
        toast.success(result.noticeMessage ?? `Stopped ${managedAgent.name}.`);
        return;
      }

      const blockReason = agentPresenceStartBlockReason(false, availability);
      if (blockReason) throw new Error(blockReason);
      await startManagedAgentWithRules({
        agent: managedAgent,
        scope,
        startManagedAgent: startManagedAgentCommand,
      });
      toast.success(
        managedAgent.backend.type === "provider"
          ? `Deploying ${managedAgent.name}.`
          : `Started ${managedAgent.name}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Agent action failed.",
      );
    }
  }, [
    availability,
    captureCommandScope,
    channels,
    managedAgent,
    relayAgents,
    startManagedAgentCommand,
    stopManagedAgentCommand,
  ]);

  const handleAgentRestart = React.useCallback(async () => {
    if (!managedAgent) return;

    try {
      const scope = captureCommandScope();
      const blockReason = agentPresenceStartBlockReason(
        isManagedAgentActive(managedAgent),
        availability,
      );
      if (blockReason) throw new Error(blockReason);
      await respawnManagedAgentWithRules({
        agent: managedAgent,
        scope,
        startManagedAgent: startManagedAgentCommand,
        stopManagedAgent: stopManagedAgentCommand,
        onStopped: () =>
          clearScopedActiveTurnsForAgentOnStop(
            managedAgent.pubkey,
            scope.expectedRelayUrl,
            scope.expectedSignerPubkey,
          ),
      });
      toast.success(`Restarted ${managedAgent.name}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Agent restart failed.",
      );
    }
  }, [
    availability,
    captureCommandScope,
    managedAgent,
    startManagedAgentCommand,
    stopManagedAgentCommand,
  ]);

  return { handleAgentPrimaryAction, handleAgentRestart };
}
