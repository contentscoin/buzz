import { createHash, randomUUID } from "node:crypto";
import { realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { finalizeEvent, verifyEvent, getPublicKey, nip19 } from "nostr-tools";
import { schnorr } from "@noble/curves/secp256k1.js";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

export async function identity(config) {
  const channel = config.channels?.buzz;
  requireCondition(channel?.enabled && channel.relayUrl, "buzz_unconfigured");
  const relay = new URL(channel.relayUrl);
  requireCondition(
    ["https:", "wss:"].includes(relay.protocol) &&
      !relay.username &&
      !relay.password &&
      relay.pathname === "/" &&
      !relay.search &&
      !relay.hash,
    "relay_invalid",
  );
  relay.protocol = "https:";
  const origin = relay.origin;
  let encoded = channel.privateKey;
  if (typeof encoded !== "string") {
    const provider = config.secrets?.providers?.[encoded?.provider];
    requireCondition(
      encoded?.source === "file" &&
        encoded.id === "value" &&
        provider?.mode === "singleValue",
      "credential_unavailable",
    );
    const root = await realpath("/data/.openclaw/secrets");
    const path = await realpath(provider.path);
    const delta = relative(root, path);
    requireCondition(
      delta && !delta.startsWith("..") && !isAbsolute(delta),
      "credential_path_invalid",
    );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      requireCondition((await file.stat()).size < 1024, "credential_invalid");
      encoded = (await file.readFile("utf8")).trim();
    } finally {
      await file.close();
    }
  }
  const key = /^[0-9a-f]{64}$/.test(encoded)
    ? new Uint8Array(Buffer.from(encoded, "hex"))
    : nip19.decode(encoded).data;
  requireCondition(
    key instanceof Uint8Array && key.length === 32,
    "credential_invalid",
  );
  let authTag;
  if (channel.authTag) {
    requireCondition(
      typeof channel.authTag === "string",
      "attestation_config_invalid",
    );
    authTag = JSON.parse(channel.authTag);
    requireCondition(
      Array.isArray(authTag) && authTag.length === 4 && authTag[0] === "auth",
      "attestation_config_invalid",
    );
  }
  return { key, agent: getPublicKey(key), origin, encoded, authTag };
}

/** Fetch the authenticated relay profile and verify its author signature. */
export async function readAgentProfile(binding, signal, kinds = [0]) {
  const { key, agent, origin } = binding;
  const url = `${origin}/query`,
    body = JSON.stringify([{ kinds, authors: [agent], limit: 10 }]);
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", sha(body)],
        ["nonce", randomUUID()],
      ],
      content: "",
    },
    key,
  );
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      ...(binding.authTag
        ? { "x-auth-tag": JSON.stringify(binding.authTag) }
        : {}),
    },
    body,
  });
  requireCondition(response.ok, "ownership_unavailable");
  const raw = await response.text();
  requireCondition(raw.length < 65536, "ownership_invalid");
  const events = JSON.parse(raw);
  const profile = events.find(
    (event) =>
      event.pubkey === agent &&
      kinds.includes(event.kind) &&
      verifyEvent(event),
  );
  requireCondition(profile, "agent_profile_missing");
  return profile;
}

export async function profileOwner(binding, signal) {
  const { agent } = binding;
  const profile = await readAgentProfile(binding, signal);
  const tags = profile?.tags?.filter((tag) => tag[0] === "auth") ?? [];
  requireCondition(
    tags.length === 1 &&
      tags[0].length === 4 &&
      /^[0-9a-f]{64}$/.test(tags[0][1]),
    "owner_binding_invalid",
  );
  const [_, owner, conditions, signature] = tags[0];
  requireCondition(
    typeof conditions === "string" &&
      conditions.length < 1000 &&
      /^[0-9a-f]{128}$/.test(signature) &&
      schnorr.verify(
        Buffer.from(signature, "hex"),
        Buffer.from(sha(`nostr:agent-auth:${agent}:${conditions}`), "hex"),
        Buffer.from(owner, "hex"),
      ),
    "owner_attestation_invalid",
  );
  const now = Math.floor(Date.now() / 1000);
  requireCondition(
    !conditions ||
      conditions.split("&").every((clause) => {
        const match = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/.exec(
          clause,
        );
        if (!match) return false;
        const value = Number(match[2]);
        return match[1] === "kind="
          ? value === 24200
          : value <= 4294967295 &&
              (match[1] === "created_at<" ? now < value : now > value);
      }),
    "owner_attestation_expired",
  );
  return tags[0][1];
}

/** Install-time binding discovery; never exports the signing key. */
export async function inspectComputerBinding(config) {
  const binding = await identity(config);
  try {
    return {
      ownerPubkey: await profileOwner(binding, AbortSignal.timeout(8000)),
      agentPubkey: binding.agent,
    };
  } finally {
    binding.key.fill(0);
  }
}
