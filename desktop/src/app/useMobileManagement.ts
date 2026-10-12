import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { startMobileBridge } from "@/shared/mobile/mobileBridge";
import { mobileAgentManagement } from "@/features/agents/mobileAgentManagement";
import { mobileProjectManagement } from "@/features/projects/mobileProjectManagement";

/** App composition connects mobile controls to existing feature-owned native handlers. */
export function useMobileManagement(owner?: string, relayUrl?: string) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!owner || !relayUrl) return;
    let retired = false;
    const controller = new AbortController();
    let stop: (() => void) | undefined;
    void startMobileBridge(
      owner,
      relayUrl,
      async (action, input, scope) => {
        try {
          if (action.startsWith("agents."))
            return await mobileAgentManagement(action, input, scope);
          if (/^(projects|repositories|issues|reviews)\./.test(action))
            return await mobileProjectManagement(action, input, scope);
          throw new Error("action_unavailable");
        } finally {
          if (!/\.(list|get|catalog|models|snapshot|file)$/.test(action)) {
            void queryClient.invalidateQueries({
              queryKey: ["managed-agents"],
            });
            void queryClient.invalidateQueries({
              queryKey: ["managed-agent-runtimes"],
            });
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            void queryClient.invalidateQueries({ queryKey: ["channels"] });
            void queryClient.invalidateQueries({ queryKey: ["relay-agents"] });
          }
        }
      },
      controller.signal,
    )
      .then((cleanup) => {
        if (retired) cleanup();
        else stop = cleanup;
      })
      .catch(() => {
        if (!retired)
          toast.error(
            "모바일 제어 기록을 열지 못했습니다. Buzz를 다시 시작해 주세요.",
          );
      });
    return () => {
      retired = true;
      controller.abort();
      stop?.();
    };
  }, [owner, relayUrl, queryClient]);
}
