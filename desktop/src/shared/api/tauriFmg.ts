import { invokeTauri } from "@/shared/api/tauri";

/** Non-sensitive runtime capability flags exposed by the FMG desktop build. */
export interface FmgRuntimeStatus {
  asideBrowserConfigured: boolean;
}

/** Read the FMG capabilities configured for the current desktop process. */
export async function getFmgRuntimeStatus(): Promise<FmgRuntimeStatus> {
  return invokeTauri<FmgRuntimeStatus>("get_fmg_runtime_status");
}

/** Saved browser selection for newly started local ACP agents. */
export interface FmgBrowserConfig {
  mode: "environment" | "disabled" | "custom";
  command: string;
}

/** Read saved browser configuration without exposing inherited environment values. */
export function getFmgBrowserConfig(): Promise<FmgBrowserConfig> {
  return invokeTauri("get_fmg_browser_config");
}

/** Atomically persist a validated browser selection. */
export function setFmgBrowserConfig(config: FmgBrowserConfig): Promise<void> {
  return invokeTauri("set_fmg_browser_config", { config });
}

/** Issue identity plus the relay and signer captured for its review. */
export interface FmgGraphTask {
  issue: string;
  repoOwner: string;
  repoId: string;
  relayUrl: string;
  signerPubkey: string;
}

/** Authoritative graph state and causal head, distinct from project status. */
export interface FmgGraphContext {
  state: string | null;
  head: string | null;
}

/** Run the packaged CLI preflight without publishing an event. */
export function getFmgGraphContext(
  task: FmgGraphTask,
): Promise<FmgGraphContext> {
  return invokeTauri("get_fmg_graph_context", { task });
}

/** Revalidate the reviewed head and publish one signed graph transition. */
export function transitionFmgGraphTask(transition: {
  task: FmgGraphTask;
  from: string;
  to: string;
  content: string;
  gate: string | null;
  expectedHead: string | null;
}): Promise<{ accepted: true; event_id: string }> {
  return invokeTauri("transition_fmg_graph_task", { transition });
}
