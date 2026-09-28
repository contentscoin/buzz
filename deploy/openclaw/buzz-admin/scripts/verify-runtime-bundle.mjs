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
if (!entry.includes("0011f1410716da2542868c29a5530088c8601775210d36ae1f9849925c995f2e")) {
  throw new Error("compiled runtime is missing the Buzz Admin build identity");
}
process.stdout.write("Buzz Admin runtime bundle verified\n");
