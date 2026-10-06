import { constants } from "node:fs";
import { open, realpath, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile as callbackExecFile } from "node:child_process";
import { promisify } from "node:util";
import { assertAudienceProject, codingRoles } from "./project-routing.mjs";

const execFile = promisify(callbackExecFile);
const root = "/data/.openclaw/projects/buzz";
const repository = "https://github.com/contentscoin/buzz.git";

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

async function git(worktree, args, signal) {
  const { stdout } = await execFile(
    "git",
    ["-c", "core.fsmonitor=false", "-C", worktree, ...args],
    {
      timeout: 8000,
      maxBuffer: 65536,
      encoding: "utf8",
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return stdout.trim();
}

/** Observe one prepared coding worktree; paths and authentication remain local. */
export async function projectBinding(config, roleId, signal) {
  requireValue(codingRoles.includes(roleId), "project_role_unavailable");
  requireValue((await realpath(root)) === root, "project_root_changed");
  const file = await open(
    `${root}/manifest.json`,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let manifest;
  try {
    const stat = await file.stat();
    requireValue(
      stat.isFile() &&
        stat.size <= 32768 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      "project_manifest_permissions",
    );
    manifest = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  requireValue(
    manifest.schema === 1 &&
      manifest.status === "prepared" &&
      manifest.repository === repository &&
      manifest.manager === "main" &&
      manifest.execution_host === "hostinger" &&
      Array.isArray(manifest.roles) &&
      manifest.roles.length === 6,
    "project_manifest_invalid",
  );
  const workspace = config.agents?.entries?.[roleId]?.workspace;
  const expectedWorkspace = `/data/.openclaw/workspaces/${roleId}`;
  requireValue(
    workspace === expectedWorkspace &&
      (await realpath(workspace)) === workspace,
    "project_role_workspace_changed",
  );
  const worktree = `${workspace}/projects/buzz`;
  const rows = manifest.roles.filter((row) => row.role_id === roleId);
  const branch = `fmg-buzz/${roleId}`;
  requireValue(
    rows.length === 1 &&
      rows[0].stage === "guide_installed" &&
      rows[0].worktree === worktree &&
      rows[0].branch === branch &&
      (await realpath(worktree)) === worktree,
    "project_worktree_changed",
  );
  requireValue(
    (await realpath(
      await git(worktree, ["rev-parse", "--git-common-dir"], signal),
    )) === `${root}/source.git`,
    "project_git_store_changed",
  );
  requireValue(
    (await git(worktree, ["remote", "get-url", "origin"], signal)) ===
      repository &&
      (await git(worktree, ["branch", "--show-current"], signal)) === branch,
    "project_repository_changed",
  );
  const commit = await git(worktree, ["rev-parse", "HEAD"], signal);
  requireValue(
    /^[0-9a-f]{40}$/.test(commit) &&
      (await git(
        worktree,
        ["status", "--porcelain", "--untracked-files=normal"],
        signal,
      )) === "",
    "project_worktree_requires_review",
  );
  const binding = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        roleId,
        workspace,
        worktree,
        repository,
        branch,
        commit,
        preparation: manifest.request_id,
      }),
    )
    .digest("hex");
  return {
    schema: 1,
    project_id: "buzz",
    repository_url: repository,
    role_id: roleId,
    branch,
    source_commit: commit,
    execution_host: "hostinger",
    workspace_binding: binding,
  };
}

/** Include only independently observed worktrees; a missing binding denies proposals. */
export async function projectBindings(config, signal) {
  const results = await Promise.allSettled(
    codingRoles.map((role) => projectBinding(config, role, signal)),
  );
  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
}

/** Recheck the immutable execution binding before admission; never reset a checkout. */
export async function assertProjectBinding(proposal, signal) {
  if (proposal.schema === 3 && proposal.project === undefined) return;
  requireValue(
    proposal.schema === 4 && proposal.project?.project_id === "buzz",
    "project_contract_invalid",
  );
  const config = JSON.parse(
    await readFile("/data/.openclaw/openclaw.json", "utf8"),
  );
  await assertAudienceProject(config, proposal);
  const observed = await projectBinding(config, proposal.role_id, signal);
  requireValue(
    Object.keys(observed).length === Object.keys(proposal.project).length &&
      Object.entries(observed).every(
        ([key, value]) => proposal.project[key] === value,
      ),
    "approved_project_binding_changed",
  );
}
