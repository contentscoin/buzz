import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile, rename } from "node:fs/promises";
import { identity } from "../../fmg-computer/src/binding.mjs";

const root = "/data/.openclaw/fmg-supervisor";

/** Publish only public registered audiences; each selected snapshot still proves live ownership. */
export async function createCommunityRegistry(entries, owner) {
  const generation = randomUUID(),
    rows = [];
  for (const entry of entries) {
    const binding = await identity(entry.config);
    try {
      rows.push({
        community_id: entry.id ?? "default",
        default: entry.accountId === "default",
        owner_pubkey: owner,
        relay_origin: binding.origin,
        gateway_agent_pubkey: binding.agent,
      });
    } finally {
      binding.key.fill(0);
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  async function save(status) {
    const temporary = `${root}/communities.${generation}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema: 1,
        status,
        generation,
        owner_pubkey: owner,
        communities: rows,
      }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, `${root}/communities.json`);
  }
  await save("ready");
  return {
    generation,
    async stop() {
      const file = await open(
        `${root}/communities.json`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let current;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 32768)
          throw new Error("community_registry_invalid");
        const buffer = Buffer.alloc(32769);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 32768) throw new Error("community_registry_limit");
        current = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await file.close();
      }
      if (current.generation === generation) await save("stopped");
    },
  };
}
