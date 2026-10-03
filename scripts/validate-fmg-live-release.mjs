#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const buzzAdminPackage = JSON.parse(
  readFileSync(resolve(root, "deploy/openclaw/buzz-admin/package.json"), "utf8"),
);
const buzzAdminPluginManifest = JSON.parse(
  readFileSync(resolve(root, "deploy/openclaw/buzz-admin/openclaw.plugin.json"), "utf8"),
);
const buzzAdminSource = readFileSync(
  resolve(root, "deploy/openclaw/buzz-admin/src/index.ts"),
  "utf8",
);

const manifestShape = {
  schema: true,
  channel: true,
  desktop: {
    version: true,
    tag: true,
    product_name: true,
    identifier: true,
    artifact: true,
    signing: true,
    update_policy: true,
  },
  upstream: { tag: true, commit: true },
  relay: {
    image: true,
    digest: true,
    immutable_ref: true,
    source_commit: true,
    deployment_policy: true,
    public_origin: true,
    websocket_url: true,
  },
  agent_runtime: {
    release: true,
    asset: true,
    archive_size_bytes: true,
    sha256: true,
    executable_sha256: true,
    version: true,
    source_commit: true,
    deployment_policy: true,
    deployment_target: true,
    install_path: true,
    buzz_cli_path: true,
    integrity_control: true,
    source_control: true,
    version_control: true,
  },
  openclaw: {
    version: true,
    server_build_id: true,
    integration: true,
    container_image: {
      configured_reference: true,
      immutable_image_id: true,
      source_revision: true,
      deployment_policy: true,
    },
    buzz_channel_plugin: {
      package: true,
      version: true,
      integrity: true,
      install_path: true,
      package_json_sha256: true,
      package_tree_sha256: true,
      runtime_entry: true,
      runtime_entry_sha256: true,
      activation_policy: true,
      account_id: true,
      required_room_name: true,
      required_room_id_sha256: true,
    },
    buzz_admin_plugin: {
      id: true,
      package: true,
      version: true,
      integrity: true,
      build_identity: true,
      runtime_dependencies: true,
      source_tree_sha256: true,
      runtime_entry_sha256: true,
      agent_ids: true,
      tools: true,
    },
    live_gate_agent: {
      id: true,
      model: true,
      reasoning_effort: true,
      runtime: true,
      code_mode: true,
      tools: true,
    },
  },
  rollback: {
    relay_image: true,
    agent_runtime: {
      release: true,
      asset: true,
      archive_size_bytes: true,
      sha256: true,
      executable_sha256: true,
      version: true,
      source_commit: true,
    },
    buzz_admin_plugin: {
      id: true,
      action: true,
      fallback_integration: true,
    },
  },
  features: {
    work_reports: { state: true, surfaces: true, control: true },
    task_graph: { state: true, surfaces: true, control: true, control_value: true },
    aside_browser: {
      state: true,
      surfaces: true,
      control: true,
      control_name: true,
      disabled_value: true,
    },
    mobile_report_fallback: {
      state: true,
      surfaces: true,
      control: true,
      delivery: true,
    },
  },
};

const stringArrayPaths = new Set([
  "manifest.openclaw.buzz_admin_plugin.tools",
  "manifest.openclaw.buzz_admin_plugin.agent_ids",
  "manifest.openclaw.live_gate_agent.tools",
  "manifest.features.work_reports.surfaces",
  "manifest.features.task_graph.surfaces",
  "manifest.features.aside_browser.surfaces",
  "manifest.features.mobile_report_fallback.surfaces",
]);

const integerPaths = new Set([
  "manifest.agent_runtime.archive_size_bytes",
  "manifest.rollback.agent_runtime.archive_size_bytes",
]);

const expectedStringArrays = new Map([
  [
    "manifest.openclaw.buzz_admin_plugin.tools",
    ["buzz_runtime_check", "buzz_publish_work_report", "buzz_send_thread_summary"],
  ],
  [
    "manifest.openclaw.buzz_admin_plugin.agent_ids",
    ["fmg-planner", "fmg-frontend", "fmg-backend", "fmg-qa", "fmg-release"],
  ],
  ["manifest.openclaw.live_gate_agent.tools", ["buzz_runtime_check"]],
  ["manifest.features.work_reports.surfaces", ["desktop", "relay", "cli", "sdk"]],
  ["manifest.features.task_graph.surfaces", ["desktop-transitions", "cli", "sdk"]],
  ["manifest.features.aside_browser.surfaces", ["desktop-settings", "acp"]],
  ["manifest.features.mobile_report_fallback.surfaces", ["mobile", "acp"]],
]);

function validateExactShape(value, shape, path, errors) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) errors.push(`manifest contains unexpected field ${path}.${key}`);
  }
  for (const [key, childShape] of Object.entries(shape)) {
    const childPath = `${path}.${key}`;
    if (!Object.hasOwn(value, key)) {
      errors.push(`${childPath} is required`);
    } else if (childShape !== true) {
      validateExactShape(value[key], childShape, childPath, errors);
    } else if (childPath === "manifest.schema") {
      if (!Number.isInteger(value[key])) errors.push(`${childPath} must be an integer`);
    } else if (integerPaths.has(childPath)) {
      if (!Number.isSafeInteger(value[key])) errors.push(`${childPath} must be a safe integer`);
    } else if (stringArrayPaths.has(childPath)) {
      if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
        errors.push(`${childPath} must be an array of strings`);
      }
    } else if (typeof value[key] !== "string") {
      errors.push(`${childPath} must be a string`);
    }
  }
}

function rejectSecretLikeKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLikeKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (/(?:token|password|secret|apikey|privatekey|authtag|credential|nsec)/u.test(normalized)) {
      errors.push(`manifest must not contain secret-like field ${path}.${key}`);
    }
    rejectSecretLikeKeys(child, `${path}.${key}`, errors);
  }
}

export function hashFmgBuzzAdminSourceTree(directory) {
  const sourceRoot = resolve(directory);
  const excluded = new Set(["node_modules", "dist", ".pack"]);
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`unsupported plugin source-tree entry: ${absolute}`);
    }
  };
  walk(sourceRoot);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const name = relative(sourceRoot, file).split(sep).join("/");
    const fileDigest = createHash("sha256").update(readFileSync(file)).digest("hex");
    digest.update(name).update("\0").update(fileDigest).update("\n");
  }
  return digest.digest("hex");
}

export function validateFmgLiveRepositoryArtifacts(manifest, repositoryRoot = root) {
  const errors = [];
  const pluginRoot = resolve(repositoryRoot, "deploy/openclaw/buzz-admin");

  try {
    const sourceTreeSha = hashFmgBuzzAdminSourceTree(pluginRoot);
    if (manifest?.openclaw?.buzz_admin_plugin?.source_tree_sha256 !== sourceTreeSha) {
      errors.push("openclaw.buzz_admin_plugin.source_tree_sha256 does not match the repository source tree");
    }
  } catch (error) {
    errors.push(`unable to hash the buzz-admin repository source tree: ${String(error)}`);
  }

  const runtimeEntry = resolve(pluginRoot, "dist/index.js");
  try {
    const entryStat = lstatSync(runtimeEntry);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      errors.push("buzz-admin dist/index.js must be a regular non-symlink file");
    } else {
      const runtimeEntrySha = createHash("sha256").update(readFileSync(runtimeEntry)).digest("hex");
      if (manifest?.openclaw?.buzz_admin_plugin?.runtime_entry_sha256 !== runtimeEntrySha) {
        errors.push("openclaw.buzz_admin_plugin.runtime_entry_sha256 does not match repository dist/index.js");
      }
    }
  } catch (error) {
    errors.push(`unable to hash buzz-admin dist/index.js: ${String(error)}`);
  }

  return errors;
}

export function validateFmgLiveManifest(manifest) {
  const errors = [];
  const maxSprigArchiveSizeBytes = 64 * 1024 * 1024;
  const hex = (length) => new RegExp(`^[0-9a-f]{${length}}$`, "u");
  const nonzeroHex = (value, length) => hex(length).test(value ?? "") && !/^0+$/u.test(value);
  const digest = /^sha256:[0-9a-f]{64}$/u;
  const fmgVersion = /^\d+\.\d+\.\d+-fmg\.\d+$/u;
  const requireString = (value, path) => {
    if (typeof value !== "string" || value.length === 0) errors.push(`${path} must be a non-empty string`);
  };

  validateExactShape(manifest, manifestShape, "manifest", errors);
  rejectSecretLikeKeys(manifest, "manifest", errors);
  if (manifest?.schema !== 2) errors.push("schema must be 2");
  if (manifest?.channel !== "fmg-live") errors.push("channel must be fmg-live");
  requireString(manifest?.desktop?.version, "desktop.version");
  requireString(manifest?.desktop?.tag, "desktop.tag");
  if (!fmgVersion.test(manifest?.desktop?.version ?? "")) {
    errors.push("desktop.version must be an FMG semantic version");
  }
  if (manifest?.desktop?.tag !== `fmg-desktop-v${manifest?.desktop?.version}`) {
    errors.push("desktop.tag must match desktop.version");
  }
  for (const [path, actual, expected] of [
    ["desktop.product_name", manifest?.desktop?.product_name, "Buzz"],
    ["desktop.identifier", manifest?.desktop?.identifier, "xyz.block.buzz.app"],
    ["desktop.artifact", manifest?.desktop?.artifact, "windows-nsis-x86_64"],
    ["desktop.signing", manifest?.desktop?.signing, "unsigned"],
    ["desktop.update_policy", manifest?.desktop?.update_policy, "manual-non-updating"],
    ["relay.deployment_policy", manifest?.relay?.deployment_policy, "digest-pinned"],
    [
      "agent_runtime.deployment_policy",
      manifest?.agent_runtime?.deployment_policy,
      "versioned-release-sha256-pinned",
    ],
    ["agent_runtime.deployment_target", manifest?.agent_runtime?.deployment_target, "openclaw-gateway-volume"],
    ["agent_runtime.integrity_control", manifest?.agent_runtime?.integrity_control, "BUZZ_SPRIG_SHA256"],
    ["agent_runtime.source_control", manifest?.agent_runtime?.source_control, "BUZZ_SPRIG_GIT_SHA"],
    ["agent_runtime.version_control", manifest?.agent_runtime?.version_control, "BUZZ_SPRIG_VERSION"],
    ["openclaw.buzz_channel_plugin.package", manifest?.openclaw?.buzz_channel_plugin?.package, "@openclaw/buzz"],
    [
      "openclaw.buzz_channel_plugin.install_path",
      manifest?.openclaw?.buzz_channel_plugin?.install_path,
      "/data/.openclaw/npm/projects/openclaw-buzz-8413d3ef60/node_modules/@openclaw/buzz",
    ],
    [
      "openclaw.buzz_channel_plugin.runtime_entry",
      manifest?.openclaw?.buzz_channel_plugin?.runtime_entry,
      "dist/index.js",
    ],
    [
      "openclaw.buzz_channel_plugin.activation_policy",
      manifest?.openclaw?.buzz_channel_plugin?.activation_policy,
      "gateway-pid-started-after-package-and-stable-generation",
    ],
    ["openclaw.buzz_admin_plugin.id", manifest?.openclaw?.buzz_admin_plugin?.id, "buzz-admin"],
    [
      "openclaw.buzz_admin_plugin.package",
      manifest?.openclaw?.buzz_admin_plugin?.package,
      "openclaw-plugin-buzz-admin",
    ],
    ["openclaw.live_gate_agent.id", manifest?.openclaw?.live_gate_agent?.id, "fmg-live-gate"],
    ["openclaw.live_gate_agent.model", manifest?.openclaw?.live_gate_agent?.model, "openai/gpt-6.1-sol"],
    ["openclaw.live_gate_agent.reasoning_effort", manifest?.openclaw?.live_gate_agent?.reasoning_effort, "medium"],
    ["openclaw.live_gate_agent.runtime", manifest?.openclaw?.live_gate_agent?.runtime, "openclaw"],
    ["openclaw.live_gate_agent.code_mode", manifest?.openclaw?.live_gate_agent?.code_mode, "disabled"],
    [
      "openclaw.container_image.configured_reference",
      manifest?.openclaw?.container_image?.configured_reference,
      "ghcr.io/hostinger/hvps-openclaw:latest",
    ],
    [
      "openclaw.container_image.deployment_policy",
      manifest?.openclaw?.container_image?.deployment_policy,
      "runtime-image-id-and-source-pinned",
    ],
    [
      "openclaw.buzz_admin_plugin.runtime_dependencies",
      manifest?.openclaw?.buzz_admin_plugin?.runtime_dependencies,
      "bundled-into-entrypoint",
    ],
  ]) {
    if (actual !== expected) errors.push(`${path} must be ${expected}`);
  }

  if (manifest?.relay?.image !== "ghcr.io/contentscoin/buzz") {
    errors.push("relay.image must be ghcr.io/contentscoin/buzz");
  }
  if (!digest.test(manifest?.relay?.digest ?? "")) errors.push("relay.digest must be sha256:<64 lowercase hex>");
  if (manifest?.relay?.immutable_ref !== `${manifest?.relay?.image}@${manifest?.relay?.digest}`) {
    errors.push("relay.immutable_ref must be relay.image@relay.digest");
  }
  if (!nonzeroHex(manifest?.upstream?.commit, 40)) {
    errors.push("upstream.commit must be 40 lowercase hex characters");
  }
  if (!nonzeroHex(manifest?.relay?.source_commit, 40)) {
    errors.push("relay.source_commit must be 40 lowercase hex characters");
  }
  try {
    const publicOrigin = new URL(manifest?.relay?.public_origin);
    const websocket = new URL(manifest?.relay?.websocket_url);
    if (
      publicOrigin.protocol !== "https:" ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.search ||
      publicOrigin.hash ||
      publicOrigin.pathname !== "/" ||
      websocket.protocol !== "wss:" ||
      websocket.host !== publicOrigin.host ||
      websocket.username ||
      websocket.password ||
      websocket.search ||
      websocket.hash ||
      websocket.pathname !== "/"
    ) {
      errors.push("relay public and WebSocket URLs must be credential-free HTTPS/WSS URLs for the same host");
    }
  } catch {
    errors.push("relay public and WebSocket URLs must be valid URLs");
  }

  const runtime = manifest?.agent_runtime;
  requireString(runtime?.release, "agent_runtime.release");
  requireString(runtime?.asset, "agent_runtime.asset");
  requireString(runtime?.version, "agent_runtime.version");
  if (!fmgVersion.test(runtime?.version ?? "")) {
    errors.push("agent_runtime.version must be an FMG semantic version");
  }
  if (runtime?.release !== `sprig-v${runtime?.version}`) {
    errors.push("agent_runtime.release must match agent_runtime.version");
  }
  if (runtime?.asset !== `sprig-${runtime?.version}-x86_64-unknown-linux-musl.tar.gz`) {
    errors.push("agent_runtime.asset must be the exact versioned Linux musl archive basename");
  }
  if (
    !Number.isSafeInteger(runtime?.archive_size_bytes) ||
    runtime.archive_size_bytes <= 0 ||
    runtime.archive_size_bytes > maxSprigArchiveSizeBytes
  ) {
    errors.push(`agent_runtime.archive_size_bytes must be between 1 and ${maxSprigArchiveSizeBytes}`);
  }
  if (!nonzeroHex(runtime?.sha256, 64)) {
    errors.push("agent_runtime.sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(runtime?.executable_sha256, 64)) {
    errors.push("agent_runtime.executable_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(runtime?.source_commit, 40)) {
    errors.push("agent_runtime.source_commit must be 40 lowercase hex characters");
  }
  if (runtime?.install_path !== `/data/.openclaw/runtimes/sprig/${runtime?.version}`) {
    errors.push("agent_runtime.install_path must match agent_runtime.version");
  }
  if (runtime?.buzz_cli_path !== "/data/.openclaw/bin/buzz") {
    errors.push("agent_runtime.buzz_cli_path must be /data/.openclaw/bin/buzz");
  }
  if (runtime?.source_commit !== manifest?.relay?.source_commit) {
    errors.push("the current relay and Sprig runtime must record the same reviewed source commit");
  }

  if (manifest?.openclaw?.integration !== "native-buzz-channel-plus-fmg-tools") {
    errors.push("openclaw.integration must describe the native channel plus FMG tools");
  }
  const tools = manifest?.openclaw?.buzz_admin_plugin?.tools;
  if (!/^\d+\.\d+\.\d+$/u.test(manifest?.openclaw?.version ?? "")) {
    errors.push("openclaw.version must be a semantic version");
  }
  if (!/^\d+\.\d+\.\d+-release-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/u.test(
    manifest?.openclaw?.server_build_id ?? "",
  )) {
    errors.push("openclaw.server_build_id must be an exact release build identity");
  }
  if (manifest?.openclaw?.buzz_channel_plugin?.version !== manifest?.openclaw?.version) {
    errors.push("openclaw.buzz_channel_plugin.version must match openclaw.version");
  }
  const openclawVersion = manifest?.openclaw?.version;
  for (const [path, actual] of [
    ["buzz-admin package peerDependencies.openclaw", buzzAdminPackage?.peerDependencies?.openclaw],
    ["buzz-admin package devDependencies.openclaw", buzzAdminPackage?.devDependencies?.openclaw],
    ["buzz-admin package openclaw.build.openclawVersion", buzzAdminPackage?.openclaw?.build?.openclawVersion],
  ]) {
    if (actual !== openclawVersion) errors.push(`${path} must match openclaw.version`);
  }
  const [openclawMajor, openclawMinor] = String(openclawVersion ?? "").split(".").map(Number);
  const expectedPluginApi = Number.isInteger(openclawMajor) && Number.isInteger(openclawMinor)
    ? `>=${openclawVersion} <${openclawMajor}.${openclawMinor + 1}.0`
    : "";
  if (buzzAdminPackage?.openclaw?.compat?.pluginApi !== expectedPluginApi) {
    errors.push("buzz-admin package pluginApi range must start at openclaw.version and stop at the next minor");
  }
  if (
    buzzAdminPackage?.version !== manifest?.openclaw?.buzz_admin_plugin?.version ||
    buzzAdminPluginManifest?.version !== manifest?.openclaw?.buzz_admin_plugin?.version ||
    buzzAdminPluginManifest?.id !== manifest?.openclaw?.buzz_admin_plugin?.id
  ) {
    errors.push("buzz-admin package and plugin metadata must match the release descriptor");
  }
  if (!digest.test(manifest?.openclaw?.container_image?.immutable_image_id ?? "")) {
    errors.push("openclaw.container_image.immutable_image_id must be sha256:<64 lowercase hex>");
  }
  if (!nonzeroHex(manifest?.openclaw?.container_image?.source_revision, 40)) {
    errors.push("openclaw.container_image.source_revision must be 40 lowercase hex characters");
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(manifest?.openclaw?.buzz_channel_plugin?.integrity ?? "")) {
    errors.push("openclaw.buzz_channel_plugin.integrity must be an npm SHA-512 integrity value");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_channel_plugin?.package_json_sha256, 64)) {
    errors.push("openclaw.buzz_channel_plugin.package_json_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_channel_plugin?.package_tree_sha256, 64)) {
    errors.push("openclaw.buzz_channel_plugin.package_tree_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_channel_plugin?.runtime_entry_sha256, 64)) {
    errors.push("openclaw.buzz_channel_plugin.runtime_entry_sha256 must be 64 lowercase hex characters");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(manifest?.openclaw?.buzz_channel_plugin?.account_id ?? "")) {
    errors.push("openclaw.buzz_channel_plugin.account_id must be a canonical account key");
  }
  if (manifest?.openclaw?.buzz_channel_plugin?.required_room_name !== "openclaw-workspace") {
    errors.push("openclaw.buzz_channel_plugin.required_room_name must be openclaw-workspace");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_channel_plugin?.required_room_id_sha256, 64)) {
    errors.push("openclaw.buzz_channel_plugin.required_room_id_sha256 must be 64 lowercase hex characters");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(manifest?.openclaw?.buzz_admin_plugin?.version ?? "")) {
    errors.push("openclaw.buzz_admin_plugin.version must be a semantic version");
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(manifest?.openclaw?.buzz_admin_plugin?.integrity ?? "")) {
    errors.push("openclaw.buzz_admin_plugin.integrity must be an npm SHA-512 integrity value");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_admin_plugin?.source_tree_sha256, 64)) {
    errors.push("openclaw.buzz_admin_plugin.source_tree_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_admin_plugin?.runtime_entry_sha256, 64)) {
    errors.push("openclaw.buzz_admin_plugin.runtime_entry_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(manifest?.openclaw?.buzz_admin_plugin?.build_identity, 64)) {
    errors.push("openclaw.buzz_admin_plugin.build_identity must be 64 lowercase hex characters");
  }
  if (!buzzAdminSource.includes(`"${manifest?.openclaw?.buzz_admin_plugin?.build_identity}"`)) {
    errors.push("openclaw.buzz_admin_plugin.build_identity must match the plugin source constant");
  }
  for (const name of [
    "buzz_runtime_check",
    "buzz_publish_work_report",
    "buzz_send_thread_summary",
  ]) {
    if (!Array.isArray(tools) || !tools.includes(name)) errors.push(`openclaw tool is missing: ${name}`);
  }
  for (const [path, expected] of expectedStringArrays) {
    const actual = path
      .replace(/^manifest\./u, "")
      .split(".")
      .reduce((value, key) => value?.[key], manifest);
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${path} must contain the exact ordered values ${expected.join(", ")}`);
    }
  }
  const rollbackRelayImage = manifest?.rollback?.relay_image;
  if (!/^ghcr\.io\/contentscoin\/buzz@sha256:[0-9a-f]{64}$/u.test(rollbackRelayImage ?? "")) {
    errors.push("rollback.relay_image must be the Buzz image pinned by SHA-256 digest");
  }
  const rollbackRuntime = manifest?.rollback?.agent_runtime;
  if (!/^\d+\.\d+\.\d+\+git\.[0-9a-f]{7,40}$/u.test(rollbackRuntime?.version ?? "")) {
    errors.push("rollback.agent_runtime.version must be a git-qualified semantic version");
  }
  const rollbackSuffix = rollbackRuntime?.release?.match(/^sprig-rollback-([0-9a-f]{7,40})$/u)?.[1];
  if (!rollbackSuffix || !rollbackRuntime?.source_commit?.startsWith(rollbackSuffix)) {
    errors.push("rollback.agent_runtime.release must identify its source commit prefix");
  }
  if (rollbackRuntime?.asset !== "sprig-x86_64-unknown-linux-musl.tar.gz") {
    errors.push("rollback.agent_runtime.asset must be the fixed Linux musl archive basename");
  }
  if (
    !Number.isSafeInteger(rollbackRuntime?.archive_size_bytes) ||
    rollbackRuntime.archive_size_bytes <= 0 ||
    rollbackRuntime.archive_size_bytes > maxSprigArchiveSizeBytes
  ) {
    errors.push(`rollback.agent_runtime.archive_size_bytes must be between 1 and ${maxSprigArchiveSizeBytes}`);
  }
  if (!nonzeroHex(rollbackRuntime?.sha256, 64)) {
    errors.push("rollback.agent_runtime.sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(rollbackRuntime?.executable_sha256, 64)) {
    errors.push("rollback.agent_runtime.executable_sha256 must be 64 lowercase hex characters");
  }
  if (!nonzeroHex(rollbackRuntime?.source_commit, 40)) {
    errors.push("rollback.agent_runtime.source_commit must be 40 lowercase hex characters");
  }
  for (const [path, actual, expected] of [
    ["rollback.buzz_admin_plugin.id", manifest?.rollback?.buzz_admin_plugin?.id, "buzz-admin"],
    [
      "rollback.buzz_admin_plugin.action",
      manifest?.rollback?.buzz_admin_plugin?.action,
      "disable-and-uninstall",
    ],
    [
      "rollback.buzz_admin_plugin.fallback_integration",
      manifest?.rollback?.buzz_admin_plugin?.fallback_integration,
      "official-buzz-channel",
    ],
  ]) {
    if (actual !== expected) errors.push(`${path} must be ${expected}`);
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(root, ".release/fmg-live.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const errors = [
    ...validateFmgLiveManifest(manifest),
    ...validateFmgLiveRepositoryArtifacts(manifest, root),
  ];
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`error: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`FMG live release descriptor valid: ${manifestPath}\n`);
  }
}
