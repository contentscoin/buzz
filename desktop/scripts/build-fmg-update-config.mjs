import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const config = JSON.parse(readFileSync(resolve("../.release/fmg-updates.json"), "utf8"));
const endpoint = new URL(config.desktop.endpoint);
if (config.schema !== 1 || endpoint.protocol !== "https:" ||
    endpoint.origin !== config.origin || endpoint.username || endpoint.password ||
    endpoint.pathname !== "/fmg-updates/windows/latest.json" ||
    !config.desktop.public_key || !process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("FMG updater configuration/signing is incomplete");
}
writeFileSync("src-tauri/tauri.fmg.conf.json", `${JSON.stringify({
  bundle: {
    createUpdaterArtifacts: true,
    externalBin: ["binaries/buzz-acp", "binaries/buzz-agent", "binaries/buzz-dev-mcp",
      "binaries/git-credential-nostr", "binaries/buzz", "binaries/git"],
    resources: ["resources/fmg-managed-git/"],
  },
  plugins: { updater: { pubkey: config.desktop.public_key, endpoints: [endpoint.href],
    windows: { installMode: "quiet" } } },
}, null, 2)}\n`);
if (!process.env.GITHUB_ENV) throw new Error("Use the FMG release workflow");
appendFileSync(process.env.GITHUB_ENV,
  `BUZZ_UPDATER_PUBLIC_KEY=${config.desktop.public_key}\nBUZZ_UPDATER_ENDPOINT=${endpoint.href}\n`);
