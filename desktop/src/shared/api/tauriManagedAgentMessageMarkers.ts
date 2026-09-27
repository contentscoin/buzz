import { invokeTauri } from "@/shared/api/tauri";

export async function hasManagedAgentChannelMessageMarker(input: {
  channelId: string;
  marker: string;
  agentPubkey?: string;
  markerScope?: "agent" | "channel";
  expectedRelayUrl: string;
  expectedSignerPubkey: string;
}): Promise<boolean> {
  return invokeTauri<boolean>("has_managed_agent_channel_message_marker", {
    channelId: input.channelId,
    marker: input.marker,
    agentPubkey: input.agentPubkey ?? null,
    markerScope: input.markerScope ?? null,
    expectedRelayUrl: input.expectedRelayUrl,
    expectedSignerPubkey: input.expectedSignerPubkey,
  });
}
