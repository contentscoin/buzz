import { constants } from "node:fs";
import { open, mkdir, realpath, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buzzProjectGuidance } from "./buzz-project-guidance.mjs";

const [role, request] = process.argv.slice(2);
if (process.getuid?.() !== 1000 || !/^fmg-(planner|frontend|backend|qa|release)$/.test(role ?? "") ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request ?? ""))
  throw new Error("guidance_arguments_invalid");
const workspace = `/data/.openclaw/workspaces/${role}`;
const worktree = `${workspace}/projects/buzz`, branch = `fmg-buzz/${role}`;
const path = `${workspace}/AGENTS.md`, backup = `${workspace}/.fmg-project-backups/${request}`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function read(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 1000 || stat.size > 524288 || (stat.mode & 0o022) !== 0)
      throw new Error("guidance_file_invalid");
    return await file.readFile();
  } finally { await file.close(); }
}
async function write(path, bytes) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
if (await realpath(workspace) !== workspace || await realpath(worktree) !== worktree)
  throw new Error("workspace_path_changed");
const config = JSON.parse(await read('/data/.openclaw/openclaw.json'));
const manifest = JSON.parse(await read('/data/.openclaw/projects/buzz/manifest.json'));
if (config.agents?.entries?.[role]?.workspace !== workspace || manifest.status !== "prepared" ||
  !manifest.roles.some(r => r.role_id === role && r.stage === "guide_installed" && r.worktree === worktree && r.branch === branch))
  throw new Error("prepared_workspace_changed");
const before = await read(path), updated = buzzProjectGuidance(before.toString("utf8"), role, worktree, branch);
await mkdir(backup, { recursive: true, mode: 0o700 });
if (await realpath(backup) !== backup) throw new Error("backup_path_changed");
await write(`${backup}/AGENTS.md`, before);
await write(`${backup}/prepared.json`, JSON.stringify({ request, role, before_sha256: hash(before), planned_sha256: hash(updated), stage: "backup_saved" }));
await syncDirectory(backup);
await syncDirectory(`${workspace}/.fmg-project-backups`);
const temporary = `${path}.${request}.tmp`;
await write(temporary, updated);
if (hash(await read(path)) !== hash(before)) throw new Error("guidance_changed_concurrently");
await rename(temporary, path);
await syncDirectory(workspace);
if (hash(await read(path)) !== hash(updated)) throw new Error("guidance_readback_mismatch");
const report = { request, role, stage: "complete", before_sha256: hash(before), after_sha256: hash(updated), backup_directory: backup, config_changed: false, model_dispatched: false };
await write(`${backup}/receipt.json`, JSON.stringify(report));
await syncDirectory(backup);
console.log(JSON.stringify(report));
