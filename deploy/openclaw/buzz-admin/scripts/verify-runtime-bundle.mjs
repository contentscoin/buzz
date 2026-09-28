#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const entry = readFileSync(resolve("dist/index.js"), "utf8");
const imports = [
  ...entry.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
  ...entry.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
].map((match) => match[1]);
const unsupported = [...new Set(imports)].filter(
  (specifier) => !specifier.startsWith("node:") && !specifier.startsWith("openclaw/"),
);
if (unsupported.length > 0) {
  throw new Error(`unbundled runtime imports: ${unsupported.join(", ")}`);
}
if (!entry.includes("2ba479459f10626705f13f17a370d6c2aa4ec4309384c38a061738574cc40c87")) {
  throw new Error("compiled runtime is missing the Buzz Admin build identity");
}
process.stdout.write("Buzz Admin runtime bundle verified\n");
