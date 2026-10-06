import { constants } from "node:fs";
import { open, mkdir, rename, unlink, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

// Operator maintenance only. This script is never registered as an agent tool.
const configPath = "/data/.openclaw/openclaw.json";
const root = "/data/.openclaw/fmg-supervisor/telegram-owner-menu";
const commands = [
  { command: "fmg_project", description: "FMG·BD 프로젝트 연결과 역할 조회" },
  { command: "fmg_task", description: "Buzz 작업 목록·조회·승인·취소·복구" },
  {
    command: "fmg_document",
    description: "작업 결과 문서 접근 조회·허용·철회",
  },
  { command: "fmg_dot", description: "GPT dot 커뮤니티 접근 조회·허용·철회" },
  { command: "status", description: "현재 OpenClaw 상태 조회" },
  { command: "models", description: "사용 가능한 모델 목록" },
  { command: "model", description: "현재 대화 모델 조회·선택" },
  { command: "think", description: "현재 대화 reasoning effort 조회·설정" },
  { command: "stop", description: "현재 대화의 응답 생성 중지" },
  { command: "commands", description: "전체 명령과 사용법 확인" },
  { command: "help", description: "도움말" },
];
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left, right) => hash(left) === hash(right);
function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}
async function readPrivate(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    requireValue(
      info.isFile() &&
        info.uid === process.getuid() &&
        (info.mode & 0o077) === 0 &&
        info.size <= limit,
      "menu_private_file_invalid",
    );
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead <= limit, "menu_file_limit");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(root);
}

async function main() {
  requireValue(process.getuid() === 1000, "gateway_runtime_user_required");
  const request = process.argv[2];
  requireValue(
    process.argv.length === 3 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        request,
      ),
    "menu_request_uuid_required",
  );
  const config = await readPrivate(configPath, 1048576);
  const settings = config.plugins?.entries?.["fmg-supervisor"]?.config;
  const owner = settings?.telegramOwnerId;
  requireValue(
    config.plugins?.entries?.["fmg-supervisor"]?.enabled === true &&
      /^[1-9][0-9]{0,14}$/.test(owner) &&
      config.commands?.ownerAllowFrom?.includes(`telegram:${owner}`),
    "menu_owner_unavailable",
  );
  const token =
    config.channels?.telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  requireValue(
    config.channels?.telegram?.enabled === true &&
      typeof token === "string" &&
      /^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token),
    "menu_token_resolution_required",
  );
  const expectedConfig = hash(config);
  async function api(method, parameters = {}) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parameters),
          signal: AbortSignal.timeout(10000),
        },
      );
      requireValue(response.body, "menu_api_response_missing");
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          requireValue(size <= 65536, "menu_api_response_limit");
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const value = JSON.parse(text);
      requireValue(response.ok && value.ok === true, "menu_api_rejected");
      return value.result;
    } catch {
      throw new Error("menu_api_unconfirmed");
    }
  }
  async function assertCurrent() {
    requireValue(
      hash(await readPrivate(configPath, 1048576)) === expectedConfig,
      "menu_configuration_changed",
    );
  }
  const bot = await api("getMe");
  requireValue(
    bot.id === Number(token.split(":")[0]) && bot.is_bot === true,
    "menu_bot_identity_changed",
  );
  const global = await api("getMyCommands");
  requireValue(
    Array.isArray(global) &&
      global.length <= 100 &&
      commands.every((row) =>
        global.some((current) => current.command === row.command),
      ),
    "menu_command_registration_missing",
  );
  const scope = { type: "chat", chat_id: Number(owner) };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await stat(root);
  requireValue(
    (await realpath(root)) === root &&
      rootInfo.isDirectory() &&
      rootInfo.uid === process.getuid() &&
      (rootInfo.mode & 0o077) === 0,
    "menu_receipt_directory_invalid",
  );
  const lock = await open(`${root}/.apply.lock`, "wx", 0o600);
  let journal, path;
  try {
    path = `${root}/${request}.json`;
    const inputHash = hash({
      bot_id: bot.id,
      owner,
      commands,
      languages: ["", "ko"],
      menu_button: { type: "commands" },
    });
    try {
      journal = await readPrivate(path, 131072);
      requireValue(journal.input_hash === inputHash, "menu_request_conflict");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const previous = [];
      for (const language_code of ["", "ko"])
        previous.push({
          language_code,
          commands: await api("getMyCommands", { scope, language_code }),
        });
      journal = {
        schema: 1,
        request_id: request,
        input_hash: inputHash,
        bot_id: bot.id,
        owner_chat_id: owner,
        before: previous,
        before_button: await api("getChatMenuButton", {
          chat_id: Number(owner),
        }),
        desired_commands: commands,
        stage: "prepared",
        global_command_count: global.length,
        global_commands_hash: hash(global),
        created_at: new Date().toISOString(),
      };
      await save(path, journal);
    }
    for (const previous of journal.before) {
      const current = await api("getMyCommands", {
        scope,
        language_code: previous.language_code,
      });
      requireValue(
        equal(current, previous.commands) || equal(current, commands),
        "menu_concurrent_change_requires_review",
      );
      if (!equal(current, commands)) {
        await assertCurrent();
        journal.stage = `applying_${previous.language_code || "neutral"}`;
        await save(path, journal);
        requireValue(
          (await api("setMyCommands", {
            scope,
            language_code: previous.language_code,
            commands,
          })) === true,
          "menu_write_unconfirmed",
        );
      }
    }
    const button = await api("getChatMenuButton", { chat_id: Number(owner) });
    requireValue(
      equal(button, journal.before_button) || button.type === "commands",
      "menu_button_concurrent_change",
    );
    if (button.type !== "commands") {
      await assertCurrent();
      journal.stage = "applying_button";
      await save(path, journal);
      requireValue(
        (await api("setChatMenuButton", {
          chat_id: Number(owner),
          menu_button: { type: "commands" },
        })) === true,
        "menu_button_unconfirmed",
      );
    }
    for (const language_code of ["", "ko"])
      requireValue(
        equal(await api("getMyCommands", { scope, language_code }), commands),
        "menu_readback_unconfirmed",
      );
    requireValue(
      (await api("getChatMenuButton", { chat_id: Number(owner) })).type ===
        "commands",
      "menu_button_readback_unconfirmed",
    );
    await assertCurrent();
    requireValue(
      hash(await api("getMyCommands")) === journal.global_commands_hash,
      "global_menu_changed_requires_review",
    );
    journal.stage = "complete";
    journal.observed_at = new Date().toISOString();
    await save(path, journal);
    console.log(
      JSON.stringify({
        request_id: request,
        bot_username: bot.username,
        stage: "complete",
        menu_scope: "owner_private_chat",
        languages: ["neutral", "ko"],
        command_count: commands.length,
        first_commands: commands.slice(0, 4).map((row) => row.command),
        menu_button_type: "commands",
        readback_verified: true,
        global_command_count: journal.global_command_count,
        global_menu_preserved: true,
        gateway_configuration_preserved: true,
        model_tasks_executed: false,
        messages_sent: false,
        observed_at: journal.observed_at,
      }),
    );
  } catch (error) {
    if (journal && path) {
      journal.stage = "needs_reconcile";
      journal.error_code = /^[a-z0-9_]{1,80}$/.test(error.message)
        ? error.message
        : "menu_update_unconfirmed";
      await save(path, journal);
    }
    throw error;
  } finally {
    await lock.close();
    await unlink(`${root}/.apply.lock`);
    await syncDirectory(root);
  }
}
main().catch(() => {
  console.error(
    "Owner menu update unconfirmed; preserve the request UUID and inspect its private journal.",
  );
  process.exitCode = 1;
});
