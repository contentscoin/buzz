import type { RelayAgent } from "@/shared/api/types";

/** Keep owner-bound identities exact while distinguishing equal display names. */
export function taskAgentOptions(
  agents: readonly RelayAgent[],
  owner: string | undefined,
) {
  const identities = new Map<string, RelayAgent>();
  for (const agent of agents) {
    if (owner && agent.ownerPubkey === owner && !identities.has(agent.pubkey)) {
      identities.set(agent.pubkey, agent);
    }
  }
  const owned = [...identities.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "ko-KR") ||
      left.pubkey.localeCompare(right.pubkey),
  );
  const byName = new Map<string, string[]>();
  for (const agent of owned) {
    const keys = byName.get(agent.name) ?? [];
    keys.push(agent.pubkey);
    byName.set(agent.name, keys);
  }
  return owned.map((agent) => {
    const siblings = byName.get(agent.name) ?? [];
    let length = 8;
    // Extend the prefix when two same-name identities share its first bytes.
    while (
      length < agent.pubkey.length &&
      siblings.some(
        (key) =>
          key !== agent.pubkey &&
          key.slice(0, length) === agent.pubkey.slice(0, length),
      )
    ) {
      length++;
    }
    return {
      ...agent,
      label:
        siblings.length > 1
          ? `${agent.name} · ${agent.pubkey.slice(0, length)}`
          : agent.name,
      sameNameCount: siblings.length,
    };
  });
}
