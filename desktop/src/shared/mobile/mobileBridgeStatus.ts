/** Local connection diagnostics. Never records request input, output or credentials. */
export type MobileBridgeStatus = {
  owner: string;
  relay: string;
  generation: string;
  phase: "starting" | "ready" | "failed" | "stopped";
  received: number;
  responded: number;
  lastAction?: string;
  lastError?: string;
};

let snapshot: MobileBridgeStatus | null = null;
const listeners = new Set<() => void>();
export function getMobileBridgeStatus() {
  return snapshot;
}
export function subscribeMobileBridgeStatus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function beginMobileBridgeStatus(owner: string, relay: string) {
  const generation = crypto.randomUUID();
  snapshot = {
    owner,
    relay,
    generation,
    phase: "starting",
    received: 0,
    responded: 0,
  };
  for (const listener of listeners) listener();
  return generation;
}
export function updateMobileBridgeStatus(
  generation: string,
  patch: Partial<
    Pick<MobileBridgeStatus, "phase" | "lastAction" | "lastError">
  >,
  count?: "received" | "responded",
) {
  if (snapshot?.generation !== generation) return;
  snapshot = {
    ...snapshot,
    ...patch,
    ...(count ? { [count]: snapshot[count] + 1 } : {}),
  };
  for (const listener of listeners) listener();
}

/** Recreate the current receiver; never sends or retries an agent mutation. */
export function retryMobileBridge() {
  window.dispatchEvent(new Event("fmg-mobile-bridge-retry"));
}
