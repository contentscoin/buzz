import esbuild from "../../buzz-admin/node_modules/esbuild/lib/main.js";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const desktopRequire = createRequire(
  new URL("../../../../desktop/package.json", import.meta.url),
);
const nostrRequire = createRequire(desktopRequire.resolve("nostr-tools"));
await esbuild.build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: { index: "src/index.mjs", binding: "src/binding.mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist",
  external: ["openclaw", "openclaw/*"],
  alias: {
    "@noble/curves/secp256k1.js": nostrRequire.resolve(
      "@noble/curves/secp256k1.js",
    ),
  },
  nodePaths: [
    fileURLToPath(new URL("../../buzz-admin/node_modules", import.meta.url)),
    fileURLToPath(new URL("../../../../desktop/node_modules", import.meta.url)),
  ],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
console.log("FMG Computer bundle built.");
