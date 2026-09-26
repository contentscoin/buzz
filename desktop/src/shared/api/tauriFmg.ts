import { invokeTauri } from "@/shared/api/tauri";

/** Non-sensitive runtime capability flags exposed by the FMG desktop build. */
export interface FmgRuntimeStatus {
  asideBrowserConfigured: boolean;
}

/** Read the FMG capabilities configured for the current desktop process. */
export async function getFmgRuntimeStatus(): Promise<FmgRuntimeStatus> {
  return invokeTauri<FmgRuntimeStatus>("get_fmg_runtime_status");
}
