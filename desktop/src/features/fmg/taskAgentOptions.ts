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
      identifier: agent.pubkey.slice(0, length),
      label:
        siblings.length > 1
          ? `${agent.name} · ${agent.pubkey.slice(0, length)}`
          : agent.name,
      sameNameCount: siblings.length,
    };
  });
}

/** Each name appears once; its exact identities remain separate connections. */
export function taskAgentGroups(
  agents: readonly RelayAgent[],
  owner: string | undefined,
) {
  const byName = new Map<string, ReturnType<typeof taskAgentOptions>>();
  for (const agent of taskAgentOptions(agents, owner)) {
    const connections = byName.get(agent.name) ?? [];
    connections.push(agent);
    byName.set(agent.name, connections);
  }
  return [...byName].map(([name, connections]) => ({
    name,
    value: JSON.stringify(name),
    connections,
  }));
}

/** An ambiguous name or a removed explicit selection never chooses a target. */
export function resolveTaskAgentSelection(
  groups: ReturnType<typeof taskAgentGroups>,
  selectedGroup: string | undefined,
  selectedPubkey: string,
) {
  const group =
    selectedGroup === undefined
      ? (groups.find((item) =>
          item.connections.some(
            (agent) =>
              agent.agentType === "openclaw" || /openclaw/i.test(agent.name),
          ),
        ) ?? groups[0])
      : groups.find((item) => item.value === selectedGroup);
  const agent = selectedPubkey
    ? group?.connections.find((item) => item.pubkey === selectedPubkey)
    : group?.connections.length === 1
      ? group.connections[0]
      : undefined;
  return { group, agent };
}
