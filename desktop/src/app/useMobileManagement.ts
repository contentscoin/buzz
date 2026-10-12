import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { startMobileBridge } from "@/shared/mobile/mobileBridge";
import { mobileAgentManagement } from "@/features/agents/mobileAgentManagement";
import { mobileProjectManagement } from "@/features/projects/mobileProjectManagement";
import { relayClient } from "@/shared/api/relayClient";
import {
  beginMobileBridgeStatus,
  updateMobileBridgeStatus,
} from "@/shared/mobile/mobileBridgeStatus";

/** App composition connects mobile controls to existing feature-owned native handlers. */
export function useMobileManagement(owner?: string, relayUrl?: string) {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!owner || !relayUrl) return;
    const relay = new URL(
      relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
    ).origin;
    if (relay !== "https://fmg.communities.buzz.xyz") return;
    let retired = false;
    let controller: AbortController | undefined;
    let stop: (() => void) | undefined;
    let retryTimer: number | undefined;
    let deadline: number | undefined;
    let attempts = 0;
    let generation: string | undefined;
    const handler: Parameters<typeof startMobileBridge>[2] = async (
      action,
      input,
      scope,
    ) => {
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
    };
    const start = () => {
      if (retired) return;
      window.clearTimeout(retryTimer);
      window.clearTimeout(deadline);
      controller?.abort();
      stop?.();
      stop = undefined;
      const active = new AbortController();
      controller = active;
      generation = beginMobileBridgeStatus(owner, relay);
      const currentGeneration = generation;
      attempts++;
      let timedOut = false;
      deadline = window.setTimeout(() => {
        timedOut = true;
        active.abort();
      }, 20_000);
      void startMobileBridge(
        owner,
        relayUrl,
        handler,
        active.signal,
        currentGeneration,
      )
        .then((cleanup) => {
          if (retired || controller !== active || active.signal.aborted)
            cleanup();
          else {
            window.clearTimeout(deadline);
            stop = cleanup;
            attempts = 0;
          }
        })
        .catch((reason) => {
          if (retired || controller !== active) return;
          window.clearTimeout(deadline);
          const message = reason instanceof Error ? reason.message : "";
          const code = timedOut
            ? "receiver_start_timeout"
            : /^[a-z_]{1,64}$/.test(message)
              ? message
              : "receiver_start_failed";
          updateMobileBridgeStatus(currentGeneration, {
            phase: "failed",
            lastError: code,
          });
          if (
            attempts < 4 &&
            code !== "journal_invalid" &&
            code !== "coordination_unavailable"
          ) {
            retryTimer = window.setTimeout(start, 1000 * 2 ** (attempts - 1));
          } else {
            toast.error(
              "모바일 제어 수신기를 열지 못했습니다. FMG 센터에서 연결 상태를 확인하고 다시 연결해 주세요.",
            );
          }
        });
    };
    const retry = () => {
      attempts = 0;
      start();
    };
    // Connection restoration must recreate an initially rejected receiver.
    const unsubscribe = relayClient.subscribeToConnectionState((state) => {
      if (state === "connected" && stop) start();
    });
    window.addEventListener("fmg-mobile-bridge-retry", retry);
    start();
    return () => {
      retired = true;
      unsubscribe();
      window.removeEventListener("fmg-mobile-bridge-retry", retry);
      window.clearTimeout(retryTimer);
      window.clearTimeout(deadline);
      controller?.abort();
      stop?.();
      if (generation)
        updateMobileBridgeStatus(generation, { phase: "stopped" });
    };
  }, [owner, relayUrl, queryClient]);
}
