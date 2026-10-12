import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

// Minisign's Ed/ED packet and detached trusted-comment signature. See
// jedisct1/minisign src/minisign.c verify() for the production wire format.
const [artifact, signatureFile, configFile] = process.argv.slice(2);
if (statSync(artifact).size > 300 * 1024 * 1024 || statSync(signatureFile).size > 8192) {
  throw new Error("Updater artifact exceeds its bound");
}
const config = JSON.parse(readFileSync(configFile, "utf8"));
const publicLines = Buffer.from(config.desktop.public_key, "base64").toString("utf8").trim().split(/\r?\n/);
const signature = readFileSync(signatureFile, "utf8").trim();
const lines = Buffer.from(signature, "base64").toString("utf8").trim().split(/\r?\n/);
const keyPacket = Buffer.from(publicLines[1] ?? "", "base64");
const packet = Buffer.from(lines[1] ?? "", "base64");
if (keyPacket.length !== 42 || packet.length !== 74 || lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") || !lines[2].startsWith("trusted comment: ") ||
    !keyPacket.subarray(2, 10).equals(packet.subarray(2, 10))) {
  throw new Error("Invalid updater signature identity");
}
const key = createPublicKey({ key: Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"), keyPacket.subarray(10),
]), format: "der", type: "spki" });
const bytes = readFileSync(artifact);
const algorithm = packet.subarray(0, 2).toString("ascii");
if (algorithm !== "ED" && algorithm !== "Ed") throw new Error("Unsupported signature algorithm");
const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
if (!verify(null, message, key, packet.subarray(10)) || !verify(null,
    Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice("trusted comment: ".length))]),
    key, Buffer.from(lines[3], "base64"))) {
  throw new Error("FMG updater signature verification failed");
}
console.log(JSON.stringify({ updater_signature_verified: true,
  sha256: createHash("sha256").update(bytes).digest("hex") }));
