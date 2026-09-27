import { toast } from "sonner";

import { useStartManagedAgentMutation } from "@/features/agents/hooks";
import type { ManagedAgentCommandScope } from "@/features/agents/lib/managedAgentControlActions";

/** Start action used by save-complete toasts, scoped to the render that saved. */
export function useStartManagedAgentToastAction(
  commandScope?: ManagedAgentCommandScope | null,
) {
  const startMutation = useStartManagedAgentMutation();
  const expectedRelayUrl = commandScope?.expectedRelayUrl;
  const expectedSignerPubkey = commandScope?.expectedSignerPubkey;

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
