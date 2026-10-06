/** Prepare bounded, isolated Git worktrees without running any model or job. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";

const root = "/data/.openclaw/projects/buzz";
const repository = "https://github.com/contentscoin/buzz.git";
const sourceBranch = "feat/fmg-desktop-graph-aside";
const roleIds = [
  "main",
  "fmg-planner",
  "fmg-frontend",
  "fmg-backend",
  "fmg-qa",
  "fmg-release",
];
const baseline = process.argv[2];
const requestId = process.argv[3];
const guideStart = "<!-- FMG_BUZZ_PROJECT_START -->";
const guideEnd = "<!-- FMG_BUZZ_PROJECT_END -->";

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function run(command, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks = [];
    let size = 0,
      failed = false,
      killTimer;
    const stop = () => {
      failed = true;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
      if (!killTimer)
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") child.kill("SIGKILL");
          }
        }, 2000);
    };
    const timer = setTimeout(stop, timeout);
    const bounded = (buffer, output) => {
      size += buffer.length;
      if (size > 1048576) stop();
      else if (output && !failed) chunks.push(buffer);
    };
    child.stdout.on("data", (data) => bounded(data, true));
    child.stderr.on("data", (data) => bounded(data, false));
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failed || code !== 0) reject(new Error("bounded_command_failed"));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

function inside(parent, child) {
  const delta = relative(parent, child);
  return delta && !delta.startsWith("..") && !isAbsolute(delta);
}

async function regular(path, optional = false) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size <= 524288, "guide_file_invalid");
    const data = Buffer.alloc(524289);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    requireValue(bytesRead <= 524288, "guide_file_limit");
    return data.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  requireValue(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "workspace_link_rejected",
  );
  requireValue((await realpath(path)) === path, "workspace_path_changed");
}

async function atomic(path, bytes) {
  const temporary = `${path}.${requestId}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const dir = await open(
    join(path, ".."),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function guidance(workspace, worktree, branch, roleId, receipt) {
  const agentPath = join(workspace, "AGENTS.md");
  const guidePath = join(workspace, "BUZZ_PROJECT.md");
  const old = await regular(agentPath);
  const previousGuide = await regular(guidePath, true);
  const text = old.toString("utf8");
  const count = (marker) => text.split(marker).length - 1;
  requireValue(
    count(guideStart) === count(guideEnd) && count(guideStart) <= 1,
    "guide_markers_invalid",
  );
  const block = `${guideStart}\n### Hostinger 중앙 총괄 · Buzz 코드\n\nBuzz 개발 작업을 받으면 BUZZ_PROJECT.md를 읽고 정확한 저장소·작업 브랜치를 확인한다.\n코드 준비는 실행 승인이나 완료 근거가 아니다. 기존 도구 권한과 소유자 승인 절차를 따른다.\n${guideEnd}`;
  let updated;
  if (text.includes(guideStart)) {
    const start = text.indexOf(guideStart),
      end = text.indexOf(guideEnd);
    requireValue(end > start, "guide_markers_invalid");
    updated = text.slice(0, start) + block + text.slice(end + guideEnd.length);
  } else updated = `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
  const guide = `# Hostinger 중앙 관리 · Buzz\n\n관리자: OpenClaw main (Hostinger)\n저장소: ${repository}\n개발 원격 브랜치: ${sourceBranch}\n준비 기준 commit: ${baseline}\n역할: ${roleId}\n코드 경로: ${worktree}\n작업 브랜치: ${branch}\n\n이 문서는 코드 작업 공간 준비 기록이다. 새로운 작업의 실행 승인은 아니다.\n기존 역할 도구 권한을 사용한다. 다른 역할의 작업 트리를 수정하거나 일괄 stage하지 않는다.\n새 작업을 시작할 때 현재 HEAD·변경 파일·실제 작업 지시문의 범위를 확인한다.\n이 기준 commit이 영구적인 최신 commit이라고 가정하지 않는다. 승인 후 코드를 변경하면\n현재 HEAD가 바뀔 수 있다. 기존 변경을 reset하거나 삭제해서 이 기준으로 되돌리지 않는다.\nmain이 배정안·상태·결과를 관리한다. 원격 push·병합·배포·메시지 게시는 별도 지시가\n있는 경우 수행한다. 작업 성공은 실제 종료 receipt와 코드 변경 근거로 보고한다.\nfmg·BD는 대화 연결 이름이며 서로 다른 코드 저장소라는 뜻은 아니다.\n\n이 작업 공간만으로 프로젝트별 제안 hash 바인딩·강제 접근 격리·자동 배정·자동 게시가\n구현됐다고 판단하지 않는다. 현재 코드 변경이나 모델 작업은 실행하지 않았다.\n`;
  const backup = join(workspace, ".fmg-project-backups", requestId);
  await directory(backup);
  const saved = await open(join(backup, "AGENTS.md"), "wx", 0o600);
  try {
    await saved.writeFile(old);
    await saved.sync();
  } finally {
    await saved.close();
  }
  if (previousGuide) {
    const savedGuide = await open(join(backup, "BUZZ_PROJECT.md"), "wx", 0o600);
    try {
      await savedGuide.writeFile(previousGuide);
      await savedGuide.sync();
    } finally {
      await savedGuide.close();
    }
  }
  for (const path of [backup, join(backup, ".."), workspace]) {
    const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  // Preserve a recoverable backup before installing the guide, then its pointer.
  receipt.guide_stage = "backup_saved";
  await atomic(
    join(root, "preparation-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  await atomic(guidePath, guide);
  await atomic(agentPath, updated);
}

requireValue(
  /^[0-9a-f]{40}$/.test(baseline ?? "") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      requestId ?? "",
    ),
  "preparation_arguments_invalid",
);
const receipt = {
  schema: 1,
  request_id: requestId,
  manager: "main",
  execution_host: "hostinger",
  repository,
  source_branch: sourceBranch,
  prepared_baseline_commit: baseline,
  status: "preparing",
  roles: [],
  model_tasks_executed: false,
  messages_sent: false,
  project_execution_binding: "not_implemented",
};
let lock;
try {
  const trustedRoot = await realpath("/data/.openclaw");
  requireValue(trustedRoot === "/data/.openclaw", "gateway_root_changed");
  await directory(root);
  lock = await open(join(root, ".prepare.lock"), "wx", 0o600);
  await lock.writeFile(requestId);
  await lock.sync();
  requireValue(
    (await regular(join(root, "manifest.json"), true)) === null,
    "project_already_prepared_review_existing_manifest",
  );
  await atomic(
    join(root, "preparation-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  const roles = JSON.parse(
    await run("/usr/local/bin/openclaw", ["agents", "list", "--json"]),
  );
  requireValue(
    Array.isArray(roles) && roles.length <= 50,
    "role_catalog_invalid",
  );
  const workspaces = [];
  for (const roleId of roleIds) {
    const matches = roles.filter((role) => role.id === roleId);
    requireValue(
      matches.length === 1 && typeof matches[0].workspace === "string",
      "role_workspace_missing",
    );
    const workspace = await realpath(matches[0].workspace);
    requireValue(
      inside(trustedRoot, workspace) &&
        !workspaces.some((row) => row.workspace === workspace),
      "role_workspace_invalid",
    );
    requireValue(
      await regular(join(workspace, "AGENTS.md")),
      "role_guide_missing",
    );
    await directory(join(workspace, "projects"));
    const worktree = join(workspace, "projects", "buzz");
    try {
      await lstat(worktree);
      throw new Error("existing_worktree_requires_review");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    workspaces.push({
      roleId,
      workspace,
      worktree,
      branch: `fmg-buzz/${roleId}`,
    });
  }
  const git = join(root, "source.git");
  try {
    await lstat(git);
    throw new Error("existing_source_requires_review");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await run(
    "git",
    [
      "clone",
      "--bare",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      sourceBranch,
      repository,
      git,
    ],
    180000,
  );
  requireValue(
    (await run("git", [
      "--git-dir",
      git,
      "rev-parse",
      `${baseline}^{commit}`,
    ])) === baseline,
    "repository_baseline_changed",
  );
  for (const row of workspaces) {
    await run("git", [
      "--git-dir",
      git,
      "worktree",
      "add",
      "-b",
      row.branch,
      row.worktree,
      baseline,
    ]);
    requireValue(
      (await run("git", ["-C", row.worktree, "rev-parse", "HEAD"])) ===
        baseline &&
        (await run("git", ["-C", row.worktree, "status", "--porcelain"])) ===
          "",
      "prepared_worktree_invalid",
    );
    receipt.roles.push({
      role_id: row.roleId,
      worktree: row.worktree,
      branch: row.branch,
      stage: "code_prepared",
    });
    await atomic(
      join(root, "preparation-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    await guidance(
      row.workspace,
      row.worktree,
      row.branch,
      row.roleId,
      receipt,
    );
    receipt.roles.at(-1).stage = "guide_installed";
    await atomic(
      join(root, "preparation-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
  }
  receipt.status = "prepared";
  receipt.prepared_at = new Date().toISOString();
  await atomic(join(root, "manifest.json"), JSON.stringify(receipt, null, 2));
  if (lock)
    await atomic(
      join(root, "preparation-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
  console.log(
    JSON.stringify({
      status: receipt.status,
      baseline_commit: baseline,
      role_ids: roleIds,
      model_tasks_executed: false,
      project_execution_binding: "not_implemented",
    }),
  );
} catch {
  receipt.status = "needs_review";
  receipt.error_code = "project_preparation_incomplete_no_automatic_reset";
  await atomic(
    join(root, "preparation-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    JSON.stringify({
      status: receipt.status,
      error_code: receipt.error_code,
      prepared_role_count: receipt.roles.length,
      model_tasks_executed: false,
    }),
  );
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(join(root, ".prepare.lock"));
  }
}
