import { toast } from "sonner";

import { useStartManagedAgentMutation } from "@/features/agents/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** Start action used by save-complete toasts, scoped to the render that saved. */
export function useStartManagedAgentToastAction() {
  const startMutation = useStartManagedAgentMutation();
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const expectedRelayUrl = activeCommunity?.relayUrl?.trim()
    ? activeCommunity.relayUrl
    : undefined;
  const expectedSignerPubkey =
    normalizePubkey(identityQuery.data?.pubkey ?? "") || undefined;

  return (pubkey: string, name: string) => {
    if (!expectedRelayUrl || !expectedSignerPubkey) {
      toast.error(
        "Buzz is still connecting to this community. Try starting the agent from its card in a moment.",
      );
      return;
    }
    startMutation.mutate(
      { pubkey, expectedRelayUrl, expectedSignerPubkey },
      {
        onSuccess: () => toast.success(`${name} started.`),
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? `${name} failed to start: ${error.message}`
              : `${name} failed to start.`,
          ),
      },
    );
  };
}
