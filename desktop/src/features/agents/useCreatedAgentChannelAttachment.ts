import { toast } from "sonner";

import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  attachManagedAgentToChannel,
  type ManagedAgentStartScopeInput,
} from "./channelAgents";
import type { Channel, CreateManagedAgentResponse } from "@/shared/api/types";

type TargetChannel = Pick<Channel, "id" | "name">;

async function attach(
  created: CreateManagedAgentResponse,
  targetChannel: TargetChannel,
  scope: ManagedAgentStartScopeInput,
) {
  const attached = await attachManagedAgentToChannel(targetChannel.id, {
    agent: created.agent,
    role: "bot",
    ensureRunning: true,
    ...scope,
  });
  created.agent = attached.agent;
}

function showAttachmentFailure(
  created: CreateManagedAgentResponse,
  targetChannel: TargetChannel,
  scope: ManagedAgentStartScopeInput,
  cause: unknown,
  toastId?: string | number,
) {
  const error = cause instanceof Error ? cause.message : "Failed to add agent.";
  const id = toast.warning("Agent created", {
    description: `${created.agent.name} couldn’t be added to #${targetChannel.name}. ${error}`,
    id: toastId,
    action: {
      label: "Try again",
      onClick: (event) => {
        event.preventDefault();
        toast.loading("Agent created", {
          description: `Adding ${created.agent.name} to #${targetChannel.name}…`,
          id,
        });
        void attach(created, targetChannel, scope).then(
          () => {
            toast.success("Agent created", {
              description: `Added ${created.agent.name} to #${targetChannel.name}`,
              id,
            });
          },
          (retryCause: unknown) => {
            showAttachmentFailure(
              created,
              targetChannel,
              scope,
              retryCause,
              id,
            );
          },
        );
      },
    },
  });
}

/** Keeps creation successful when its optional channel attachment fails. */
export function useCreatedAgentChannelAttachment() {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();

  async function presentCreatedAgent(
    created: CreateManagedAgentResponse,
    targetChannel?: TargetChannel | null,
    capturedScope?: ManagedAgentStartScopeInput,
  ) {
    if (created.spawnError || !targetChannel) {
      toast.success("Agent created");
      return;
    }

    const scope: ManagedAgentStartScopeInput = {
      expectedRelayUrl:
        capturedScope?.expectedRelayUrl ??
        (activeCommunity?.relayUrl?.trim()
          ? activeCommunity.relayUrl
          : undefined),
      expectedSignerPubkey:
        capturedScope?.expectedSignerPubkey ??
        (normalizePubkey(identityQuery.data?.pubkey ?? "") || undefined),
    };
    try {
      await attach(created, targetChannel, scope);
      toast.success("Agent created");
    } catch (cause) {
      showAttachmentFailure(created, targetChannel, scope, cause);
    }
  }

  return { presentCreatedAgent };
}
