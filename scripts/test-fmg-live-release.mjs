#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  hashFmgBuzzAdminSourceTree,
  validateFmgLiveManifest,
  validateFmgLiveRepositoryArtifacts,
} from "./validate-fmg-live-release.mjs";

const manifest = JSON.parse(readFileSync(resolve(".release/fmg-live.json"), "utf8"));
const buzzAdminInstaller = readFileSync(
  resolve("scripts/install-openclaw-buzz-admin-plugin.sh"),
  "utf8",
);

assert.match(buzzAdminInstaller, /openclaw gateway call plugins\.list/u);
assert.match(buzzAdminInstaller, /--expect-url "\$GATEWAY_URL" --timeout 30000/u);
assert.match(
  buzzAdminInstaller,
  /existing buzz-admin must be disabled before installation/u,
);
assert.match(buzzAdminInstaller, /existing buzz-admin runtime is still active/u);
assert.deepEqual(validateFmgLiveManifest(manifest), []);
assert.equal(
  manifest.openclaw.buzz_admin_plugin.source_tree_sha256,
  hashFmgBuzzAdminSourceTree(resolve("deploy/openclaw/buzz-admin")),
);
assert.deepEqual(validateFmgLiveRepositoryArtifacts(manifest, resolve(".")), []);

const mismatchedRuntimeEntry = structuredClone(manifest);
mismatchedRuntimeEntry.openclaw.buzz_admin_plugin.runtime_entry_sha256 =
  manifest.openclaw.buzz_admin_plugin.runtime_entry_sha256 === "a".repeat(64)
    ? "b".repeat(64)
    : "a".repeat(64);
assert.match(
  validateFmgLiveRepositoryArtifacts(mismatchedRuntimeEntry, resolve(".")).join("\n"),
  /runtime_entry_sha256 does not match repository dist\/index\.js/u,
);

const invalidAdminIntegrity = structuredClone(manifest);
invalidAdminIntegrity.openclaw.buzz_admin_plugin.integrity = "sha512-invalid=";
assert.match(
  validateFmgLiveManifest(invalidAdminIntegrity).join("\n"),
  /buzz_admin_plugin\.integrity must be an npm SHA-512 integrity value/u,
);

const mutableRelay = structuredClone(manifest);
mutableRelay.relay.immutable_ref = `${mutableRelay.relay.image}:main`;
assert.match(validateFmgLiveManifest(mutableRelay).join("\n"), /relay\.immutable_ref/u);

const missingTool = structuredClone(manifest);
missingTool.openclaw.buzz_admin_plugin.tools = ["buzz_runtime_check"];
assert.match(validateFmgLiveManifest(missingTool).join("\n"), /buzz_publish_work_report/u);

const secretField = structuredClone(manifest);
secretField.telegram_bot_token = "must-never-land";
assert.match(validateFmgLiveManifest(secretField).join("\n"), /unexpected field manifest\.telegram_bot_token/u);

for (const secretName of ["privateKey", "gatewayToken", "authTag"]) {
  const nestedSecret = structuredClone(manifest);
  nestedSecret.openclaw[secretName] = "must-never-land";
  assert.match(
    validateFmgLiveManifest(nestedSecret).join("\n"),
    new RegExp(`unexpected field manifest\\.openclaw\\.${secretName}`, "u"),
  );
}

const unknownNestedField = structuredClone(manifest);
unknownNestedField.agent_runtime.download_token = "must-never-land";
assert.match(
  validateFmgLiveManifest(unknownNestedField).join("\n"),
  /unexpected field manifest\.agent_runtime\.download_token/u,
);

const objectInLeaf = structuredClone(manifest);
objectInLeaf.desktop.product_name = { privateKey: "must-never-land" };
assert.match(validateFmgLiveManifest(objectInLeaf).join("\n"), /desktop\.product_name must be a string/u);
assert.match(validateFmgLiveManifest(objectInLeaf).join("\n"), /secret-like field/u);

const objectInSurface = structuredClone(manifest);
objectInSurface.features.work_reports.surfaces.push({ gatewayToken: "must-never-land" });
assert.match(validateFmgLiveManifest(objectInSurface).join("\n"), /surfaces must be an array of strings/u);
assert.match(validateFmgLiveManifest(objectInSurface).join("\n"), /secret-like field/u);

const objectInTools = structuredClone(manifest);
objectInTools.openclaw.buzz_admin_plugin.tools.push({ authTag: "must-never-land" });
assert.match(validateFmgLiveManifest(objectInTools).join("\n"), /tools must be an array of strings/u);
assert.match(validateFmgLiveManifest(objectInTools).join("\n"), /secret-like field/u);

const duplicateTool = structuredClone(manifest);
duplicateTool.openclaw.buzz_admin_plugin.tools.push("buzz_runtime_check");
assert.match(validateFmgLiveManifest(duplicateTool).join("\n"), /exact ordered values/u);

const traversalRuntime = structuredClone(manifest);
traversalRuntime.agent_runtime.version = "../victim";
traversalRuntime.agent_runtime.release = "sprig-v../victim";
traversalRuntime.agent_runtime.asset = "sprig-../victim-x86_64-unknown-linux-musl.tar.gz";
traversalRuntime.agent_runtime.install_path = "/data/.openclaw/runtimes/sprig/../victim";
assert.match(
  validateFmgLiveManifest(traversalRuntime).join("\n"),
  /agent_runtime\.version must be an FMG semantic version/u,
);

const unsafeAsset = structuredClone(manifest);
unsafeAsset.agent_runtime.asset = `nested/${unsafeAsset.agent_runtime.version}.tar.gz`;
assert.match(
  validateFmgLiveManifest(unsafeAsset).join("\n"),
  /exact versioned Linux musl archive basename/u,
);

const unsafeImage = structuredClone(manifest);
unsafeImage.relay.image = "ghcr.io/contentscoin/buzz;touch-pwned";
unsafeImage.relay.immutable_ref = `${unsafeImage.relay.image}@${unsafeImage.relay.digest}`;
assert.match(validateFmgLiveManifest(unsafeImage).join("\n"), /relay\.image must be/u);

const unsafeAdminRollback = structuredClone(manifest);
unsafeAdminRollback.rollback.buzz_admin_plugin.action = "restore-legacy-source";
assert.match(
  validateFmgLiveManifest(unsafeAdminRollback).join("\n"),
  /rollback\.buzz_admin_plugin\.action must be disable-and-uninstall/u,
);

const mutableOpenClaw = structuredClone(manifest);
mutableOpenClaw.openclaw.container_image.immutable_image_id = "ghcr.io/hostinger/hvps-openclaw:latest";
assert.match(
  validateFmgLiveManifest(mutableOpenClaw).join("\n"),
  /openclaw\.container_image\.immutable_image_id/u,
);

const missingBuzzIntegrity = structuredClone(manifest);
missingBuzzIntegrity.openclaw.buzz_channel_plugin.integrity = "latest";
assert.match(
  validateFmgLiveManifest(missingBuzzIntegrity).join("\n"),
  /openclaw\.buzz_channel_plugin\.integrity/u,
);

const unsafeBuzzInstallPath = structuredClone(manifest);
unsafeBuzzInstallPath.openclaw.buzz_channel_plugin.install_path = "/data/.openclaw/npm/projects/../buzz";
assert.match(
  validateFmgLiveManifest(unsafeBuzzInstallPath).join("\n"),
  /openclaw\.buzz_channel_plugin\.install_path/u,
);

const wrongBuzzRuntimeEntry = structuredClone(manifest);
wrongBuzzRuntimeEntry.openclaw.buzz_channel_plugin.runtime_entry = "dist/latest.js";
assert.match(
  validateFmgLiveManifest(wrongBuzzRuntimeEntry).join("\n"),
  /openclaw\.buzz_channel_plugin\.runtime_entry/u,
);

const missingBuzzTreeHash = structuredClone(manifest);
missingBuzzTreeHash.openclaw.buzz_channel_plugin.package_tree_sha256 = "0".repeat(64);
assert.match(
  validateFmgLiveManifest(missingBuzzTreeHash).join("\n"),
  /openclaw\.buzz_channel_plugin\.package_tree_sha256/u,
);

const wrongBuzzRoom = structuredClone(manifest);
wrongBuzzRoom.openclaw.buzz_channel_plugin.required_room_id_sha256 = "0".repeat(64);
assert.match(
  validateFmgLiveManifest(wrongBuzzRoom).join("\n"),
  /required_room_id_sha256/u,
);

const duplicateAgent = structuredClone(manifest);
duplicateAgent.openclaw.buzz_admin_plugin.agent_ids.push("fmg-release");
assert.match(
  validateFmgLiveManifest(duplicateAgent).join("\n"),
  /agent_ids must contain the exact ordered values/u,
);

const unsupportedGateModel = structuredClone(manifest);
unsupportedGateModel.openclaw.live_gate_agent.model = "openai/gpt-6-luna";
assert.match(
  validateFmgLiveManifest(unsupportedGateModel).join("\n"),
  /openclaw\.live_gate_agent\.model must be openai\/gpt-6-sol/u,
);

const unsafeGateRuntime = structuredClone(manifest);
unsafeGateRuntime.openclaw.live_gate_agent.runtime = "codex";
assert.match(
  validateFmgLiveManifest(unsafeGateRuntime).join("\n"),
  /openclaw\.live_gate_agent\.runtime must be openclaw/u,
);

const unsafeGateCodeMode = structuredClone(manifest);
unsafeGateCodeMode.openclaw.live_gate_agent.code_mode = "auto";
assert.match(
  validateFmgLiveManifest(unsafeGateCodeMode).join("\n"),
  /openclaw\.live_gate_agent\.code_mode must be disabled/u,
);

const broadGateTools = structuredClone(manifest);
broadGateTools.openclaw.live_gate_agent.tools.push("buzz_send_thread_summary");
assert.match(
  validateFmgLiveManifest(broadGateTools).join("\n"),
  /live_gate_agent\.tools must contain the exact ordered values buzz_runtime_check/u,
);

const mismatchedAdminBuild = structuredClone(manifest);
mismatchedAdminBuild.openclaw.buzz_admin_plugin.build_identity = "a".repeat(64);
assert.match(
  validateFmgLiveManifest(mismatchedAdminBuild).join("\n"),
  /build_identity must match the plugin source constant/u,
);

const mutableOpenClawBuild = structuredClone(manifest);
mutableOpenClawBuild.openclaw.server_build_id = "2026.9.6";
assert.match(
  validateFmgLiveManifest(mutableOpenClawBuild).join("\n"),
  /openclaw\.server_build_id/u,
);

const mismatchedOpenClawVersion = structuredClone(manifest);
mismatchedOpenClawVersion.openclaw.version = "2026.9.7";
mismatchedOpenClawVersion.openclaw.buzz_channel_plugin.version = "2026.9.7";
assert.match(
  validateFmgLiveManifest(mismatchedOpenClawVersion).join("\n"),
  /buzz-admin package peerDependencies\.openclaw must match openclaw\.version/u,
);

process.stdout.write("FMG live release descriptor tests passed\n");
