import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  deleteManagedAgentWithRules,
  type ManagedAgentActionResult,
  type ManagedAgentCommandScope,
} from "@/features/agents/lib/managedAgentControlActions";
import { invalidateChannelMembersRosters } from "@/features/channels/rosterFreshness";
import { removeChannelMember } from "@/shared/api/tauri";
import type {
  AgentPersona,
  Channel,
  ManagedAgent,
  RelayAgent,
} from "@/shared/api/types";
import { getRelayAgentChannelIds } from "@/features/profile/ui/UserProfilePanelUtils";

type DeleteManagedAgentRulesContext = Omit<
  Parameters<typeof deleteManagedAgentWithRules>[0],
  "agent"
>;

type DeleteProfileManagedAgentContext = DeleteManagedAgentRulesContext & {
  removeAgentFromAllChannels: (
    pubkey: string,
    scope?: ManagedAgentCommandScope,
  ) => Promise<void>;
};

type DeleteProfileManagedAgentsForPersonaContext =
  DeleteProfileManagedAgentContext & {
    managedAgents: readonly ManagedAgent[];
    selectedAgent?: ManagedAgent;
  };

type UseProfileAgentDeletionInput = {
  channels?: readonly Channel[];
  commandScope?: ManagedAgentCommandScope | null;
  deleteManagedAgent: DeleteManagedAgentRulesContext["deleteManagedAgent"];
  managedAgent?: ManagedAgent;
  managedAgents?: readonly ManagedAgent[];
  getAvailability: DeleteManagedAgentRulesContext["getAvailability"];
  relayAgents?: readonly RelayAgent[];
};

export function useProfileAgentDeletion({
  channels,
  commandScope,
  deleteManagedAgent,
  managedAgent,
  managedAgents,
  getAvailability,
  relayAgents,
}: UseProfileAgentDeletionInput) {
  const queryClient = useQueryClient();
  const captureCommandScope = React.useCallback(() => {
    if (commandScope === null) {
      throw new Error(
        "Buzz is still connecting to this community. Try again in a moment.",
      );
    }
    return commandScope;
  }, [commandScope]);
  const removeAgentFromAllChannels = React.useCallback(
    async (agentPubkey: string, scope?: ManagedAgentCommandScope) => {
      const normalizedPubkey = agentPubkey.toLowerCase();
      const channelIds = new Set(
        getRelayAgentChannelIds(relayAgents, agentPubkey),
      );
      for (const channel of channels ?? []) {
        if (
          channel.memberPubkeys.some(
            (memberPubkey) => memberPubkey.toLowerCase() === normalizedPubkey,
          )
        ) {
          channelIds.add(channel.id);
        }
      }
      if (channelIds.size === 0) return;
      const removalResults = await Promise.allSettled(
        [...channelIds].map((channelId) =>
          removeChannelMember(channelId, agentPubkey, scope),
        ),
      );
      // Direct writes bypass the member mutations' invalidation; without
      // this, the deleted agent stays in cached rosters for the freshness
      // window.
      await invalidateChannelMembersRosters(queryClient, channelIds);
      const failedRemovalCount = removalResults.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failedRemovalCount > 0) {
        throw new Error(
          `Agent deleted, but Buzz could not remove it from ${failedRemovalCount} channel${failedRemovalCount === 1 ? "" : "s"}. Refresh and retry the channel cleanup.`,
        );
      }
    },
    [channels, queryClient, relayAgents],
  );

  const deleteManagedAgentRecord = React.useCallback(
    async (agentToDelete: ManagedAgent) =>
      deleteProfileManagedAgent(agentToDelete, {
        channels: channels ?? [],
        deleteManagedAgent,
        getAvailability,
        relayAgents: relayAgents ?? [],
        removeAgentFromAllChannels,
        scope: captureCommandScope(),
        skipRemoteDeleteConfirm: true,
      }),
    [
      channels,
      captureCommandScope,
      deleteManagedAgent,
      getAvailability,
      relayAgents,
      removeAgentFromAllChannels,
    ],
  );

  const deleteManagedAgentsForPersona = React.useCallback(
    async (persona: AgentPersona) =>
      deleteProfileManagedAgentsForPersona(persona, {
        channels: channels ?? [],
        deleteManagedAgent,
        managedAgents: managedAgents ?? [],
        getAvailability,
        relayAgents: relayAgents ?? [],
        removeAgentFromAllChannels,
        scope: captureCommandScope(),
        selectedAgent: managedAgent,
      }),
    [
      channels,
      captureCommandScope,
      deleteManagedAgent,
      managedAgent,
      managedAgents,
      getAvailability,
      relayAgents,
      removeAgentFromAllChannels,
    ],
  );

  return {
    deleteManagedAgentRecord,
    deleteManagedAgentsForPersona,
    removeAgentFromAllChannels,
  };
}

export async function deleteProfileManagedAgent(
  agent: ManagedAgent,
  context: DeleteProfileManagedAgentContext,
): Promise<ManagedAgentActionResult> {
  const { removeAgentFromAllChannels, ...deleteContext } = context;
  const result = await deleteManagedAgentWithRules({
    agent,
    ...deleteContext,
  });
  if (result.cancelled) return result;

  await removeAgentFromAllChannels(agent.pubkey, deleteContext.scope);
  return result;
}

export async function deleteProfileManagedAgentsForPersona(
  persona: AgentPersona,
  context: DeleteProfileManagedAgentsForPersonaContext,
): Promise<ManagedAgentActionResult> {
  const { managedAgents, selectedAgent, ...deleteContext } = context;
  const agentsByPubkey = new Map<string, ManagedAgent>();

  for (const agent of managedAgents) {
    if (agent.personaId === persona.id) {
      agentsByPubkey.set(agent.pubkey, agent);
    }
  }

  if (selectedAgent?.personaId === persona.id) {
    agentsByPubkey.set(selectedAgent.pubkey, selectedAgent);
  }

  for (const agent of agentsByPubkey.values()) {
    const result = await deleteProfileManagedAgent(agent, deleteContext);
    if (result.cancelled) return result;
  }

  return {};
}
