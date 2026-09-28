#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  hashFmgBuzzAdminSourceTree,
  validateFmgLiveManifest,
  validateFmgLiveRepositoryArtifacts,
} from "./validate-fmg-live-release.mjs";
import { evaluateBuzzAdminReconciliation } from "./openclaw-buzz-admin-reconcile.mjs";

const manifest = JSON.parse(readFileSync(resolve(".release/fmg-live.json"), "utf8"));
const buzzAdminInstaller = readFileSync(
  resolve("scripts/install-openclaw-buzz-admin-plugin.sh"),
  "utf8",
);
const buzzAdminReconcile = readFileSync(
  resolve("scripts/openclaw-buzz-admin-reconcile.mjs"),
  "utf8",
);
const runtimeInstaller = readFileSync(
  resolve("scripts/install-openclaw-buzz-runtime.sh"),
  "utf8",
);
const buzzAdminReconcileSha256 = createHash("sha256")
  .update(buzzAdminReconcile)
  .digest("hex");

assert.match(buzzAdminInstaller, /openclaw gateway call plugins\.list/u);
assert.match(buzzAdminInstaller, /--expect-url "\$GATEWAY_URL" --timeout 30000/u);
assert.match(
  buzzAdminInstaller,
  /GATEWAY_URL="\$\{FMG_OPENCLAW_GATEWAY_URL:-ws:\/\/127\.0\.0\.1:18789\}"/u,
);
assert.match(
  buzzAdminInstaller,
  /openclaw plugins enable buzz-admin --accept-capabilities/u,
);
assert.match(
  buzzAdminInstaller,
  /reconciling postconditions for the exact active buzz-admin managed install/u,
);
assert.match(
  buzzAdminInstaller,
  /resuming the exact disabled buzz-admin managed install/u,
);
assert.match(buzzAdminReconcile, /active buzz-admin does not match the release descriptor/u);
assert.match(buzzAdminReconcile, /buzz-admin lifecycle state is neither quiescent nor active/u);
assert.match(
  buzzAdminInstaller,
  new RegExp(`EXPECTED_RECONCILE_HELPER_SHA256="${buzzAdminReconcileSha256}"`, "u"),
);
assert.match(buzzAdminInstaller, /if \(\( needs_install == 1 \)\); then/u);
assert.match(buzzAdminInstaller, /preinstall_identity.*preinstall_confirm_identity/su);
assert.match(buzzAdminInstaller, /final_reconciliation.*active_generation/su);
assert.match(runtimeInstaller, /^DOWNLOAD_CONNECT_TIMEOUT_SECONDS=15$/mu);
assert.match(runtimeInstaller, /^DOWNLOAD_TOTAL_TIMEOUT_SECONDS=120$/mu);
assert.match(runtimeInstaller, /^MAX_ARCHIVE_SIZE_BYTES=\$\(\(64 \* 1024 \* 1024\)\)$/mu);
assert.match(runtimeInstaller, /curl --disable --fail --location --max-redirs 5/u);
assert.match(runtimeInstaller, /--connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SECONDS"/u);
assert.match(runtimeInstaller, /--max-time "\$DOWNLOAD_TOTAL_TIMEOUT_SECONDS"/u);
assert.match(runtimeInstaller, /--max-filesize "\$expected_archive_size"/u);
assert.match(runtimeInstaller, /head -c "\$archive_read_limit" > "\$archive"/u);
assert.match(runtimeInstaller, /actual_archive_size="\$\(wc -c < "\$archive"\)"/u);
assert.match(runtimeInstaller, /Sprig archive byte size does not match the release descriptor/u);

const archiveSizeCheck = runtimeInstaller.indexOf(
  '[[ "$actual_archive_size" == "$expected_archive_size" ]]',
);
assert.ok(archiveSizeCheck >= 0);
assert.ok(archiveSizeCheck < runtimeInstaller.indexOf("sha256sum -c -"));
assert.ok(archiveSizeCheck < runtimeInstaller.indexOf('tar -tzf "$archive"'));

const expectedAdmin = {
  package: manifest.openclaw.buzz_admin_plugin.package,
  version: manifest.openclaw.buzz_admin_plugin.version,
  integrity: manifest.openclaw.buzz_admin_plugin.integrity,
  tools: manifest.openclaw.buzz_admin_plugin.tools,
};
const authoritativeList = (state, generation = 7) => ({
  generation,
  plugins:
    state === "absent"
      ? []
      : [
          {
            id: "buzz-admin",
            enabled: state === "active",
            state: state === "active" ? "enabled" : "disabled",
            runtime: { state: state === "active" ? "active" : "unloaded" },
          },
        ],
});
const authoritativeInspect = (enabled, overrides = {}) => ({
  ok: true,
  plugin: {
    id: "buzz-admin",
    installed: true,
    enabled,
    version: expectedAdmin.version,
  },
  source: {
    kind: "npm",
    packageName: expectedAdmin.package,
    spec: `${expectedAdmin.package}@${expectedAdmin.version}`,
    integrity: expectedAdmin.integrity,
    integrityKind: "ssri",
    ...(overrides.source ?? {}),
  },
  declared: {
    tools: expectedAdmin.tools,
    dangerousConfigFlags: [],
    ...(overrides.declared ?? {}),
  },
  ...overrides.root,
});
const reconcile = (phase, state, inspect, generation) =>
  evaluateBuzzAdminReconciliation({
    phase,
    list: authoritativeList(state, generation),
    listAfter: authoritativeList(state, generation),
    inspect,
    expected: expectedAdmin,
  });

assert.deepEqual(reconcile("initial", "absent", null), {
  generation: 7,
  state: "absent",
  match: "absent",
  action: "install",
});
assert.equal(reconcile("initial", "active", authoritativeInspect(true)).action, "resume-active");
assert.equal(reconcile("post", "active", authoritativeInspect(true)).action, "verify");
assert.equal(reconcile("initial", "disabled", authoritativeInspect(false)).action, "resume-disabled");
// A persisted cold enabled=true flag is deliberately not an input: the live
// disabled/unloaded record controls the action and must always request enable.
assert.equal(reconcile("post", "disabled", authoritativeInspect(false)).action, "enable");
assert.equal(
  reconcile(
    "initial",
    "disabled",
    authoritativeInspect(false, { source: { integrity: "sha512-mismatch==" } }),
  ).action,
  "install",
);
assert.throws(
  () =>
    reconcile(
      "initial",
      "active",
      authoritativeInspect(true, { source: { integrity: "sha512-mismatch==" } }),
    ),
  /active buzz-admin does not match the release descriptor/u,
);
assert.throws(
  () =>
    evaluateBuzzAdminReconciliation({
      phase: "probe",
      list: {
        ...authoritativeList("active"),
        result: authoritativeList("active"),
      },
    }),
  /exactly one supported envelope/u,
);
assert.throws(
  () =>
    evaluateBuzzAdminReconciliation({
      phase: "initial",
      list: authoritativeList("active"),
      listAfter: authoritativeList("active"),
      inspect: { ok: true },
      expected: expectedAdmin,
    }),
  /plugins\.inspect plugin must be an object/u,
);
assert.throws(
  () =>
    evaluateBuzzAdminReconciliation({
      phase: "initial",
      list: authoritativeList("disabled", 7),
      listAfter: authoritativeList("disabled", 8),
      inspect: authoritativeInspect(false),
      expected: expectedAdmin,
    }),
  /generation or buzz-admin state changed during inspection/u,
);
assert.throws(
  () =>
    evaluateBuzzAdminReconciliation({
      phase: "initial",
      list: authoritativeList("disabled", 7),
      listAfter: authoritativeList("active", 7),
      inspect: authoritativeInspect(true),
      expected: expectedAdmin,
    }),
  /generation or buzz-admin state changed during inspection/u,
);
assert.throws(
  () =>
    evaluateBuzzAdminReconciliation({
      phase: "initial",
      list: authoritativeList("disabled", 7),
      listAfter: authoritativeList("disabled", 7),
      inspect: authoritativeInspect(true),
      expected: expectedAdmin,
    }),
  /enabled state disagrees with plugins\.list/u,
);

assert.deepEqual(validateFmgLiveManifest(manifest), []);
assert.equal(manifest.agent_runtime.archive_size_bytes, 6567959);
assert.equal(manifest.rollback.agent_runtime.archive_size_bytes, 6567967);
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

const nonIntegerRuntimeArchiveSize = structuredClone(manifest);
nonIntegerRuntimeArchiveSize.agent_runtime.archive_size_bytes = "6567959";
assert.match(
  validateFmgLiveManifest(nonIntegerRuntimeArchiveSize).join("\n"),
  /agent_runtime\.archive_size_bytes must be a safe integer/u,
);

const emptyRuntimeArchive = structuredClone(manifest);
emptyRuntimeArchive.agent_runtime.archive_size_bytes = 0;
assert.match(
  validateFmgLiveManifest(emptyRuntimeArchive).join("\n"),
  /agent_runtime\.archive_size_bytes must be between 1 and 67108864/u,
);

const oversizedRuntimeArchive = structuredClone(manifest);
oversizedRuntimeArchive.agent_runtime.archive_size_bytes = 67108865;
assert.match(
  validateFmgLiveManifest(oversizedRuntimeArchive).join("\n"),
  /agent_runtime\.archive_size_bytes must be between 1 and 67108864/u,
);

const emptyRollbackRuntimeArchive = structuredClone(manifest);
emptyRollbackRuntimeArchive.rollback.agent_runtime.archive_size_bytes = 0;
assert.match(
  validateFmgLiveManifest(emptyRollbackRuntimeArchive).join("\n"),
  /rollback\.agent_runtime\.archive_size_bytes must be between 1 and 67108864/u,
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
