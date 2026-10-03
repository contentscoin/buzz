"""Install bounded Buzz task guidance while preserving the owner workspace."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid


def digest(data):
    """Return the SHA-256 of a persisted instruction document."""
    return hashlib.sha256(data).hexdigest()


def read_regular(path, optional=False):
    """Reject links, non-files and oversized documents before reading."""
    if path.is_symlink():
        raise SystemExit("Workspace target is a symlink.")
    if not path.exists() and optional:
        return None
    if not path.is_file() or path.stat().st_size > 512 * 1024:
        raise SystemExit("Expected a bounded regular workspace document.")
    return path.read_bytes()


def sync_directory(path):
    """Persist replacement directory entries on the Linux Gateway host."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def install(root):
    """Install guide first, then its managed pointer, with durable backups."""
    if root.is_symlink():
        raise SystemExit("Workspace root is a symlink.")
    root = root.resolve(strict=True)
    agents = root / "AGENTS.md"
    guide = root / "BUZZ_SUPERVISOR.md"
    old_agents = read_regular(agents)
    old_guide = read_regular(guide, optional=True)
    guide_bytes = read_regular(Path(__file__).resolve().parents[1] / "WORKFLOW.md")
    source_stat = agents.stat()
    mode = stat.S_IMODE(source_stat.st_mode) & 0o660
    start = "<!-- FMG_BUZZ_SUPERVISOR_START -->"
    end = "<!-- FMG_BUZZ_SUPERVISOR_END -->"
    block = f"""{start}
### GPT dot · Buzz 작업 연결

소유자가 Buzz 연결·닷 총괄·모델·effort·작업 상태를 요청하면
`BUZZ_SUPERVISOR.md`를 먼저 읽는다. 현재 snapshot과 실제 조회 결과로 답한다.
ChatGPT MCP와 Gateway 도구를 구분하며, 도구 목록에 이름이 없다고 미설치로
단정하지 않는다. 작업 실행은 소유자의 직접 Telegram `/fmg_task` 명령 승인이다.
모델이 승인을 대신하거나 불명확한 작업을 자동 재실행하지 않는다.
{end}"""
    text = old_agents.decode("utf-8")
    if text.count(start) != text.count(end) or text.count(start) > 1:
        raise SystemExit("Managed guidance markers are inconsistent.")
    if start in text:
        first, last = text.index(start), text.index(end)
        if last < first:
            raise SystemExit("Managed guidance markers are out of order.")
        updated = text[:first] + block + text[last + len(end):]
    else:
        anchor = "### Local notes (migrated from TOOLS.md)"
        updated = text.replace(anchor, block + "\n\n" + anchor, 1) if anchor in text else text.rstrip() + "\n\n" + block + "\n"
    new_agents = updated.encode("utf-8")
    if old_guide == guide_bytes and old_agents == new_agents:
        print(json.dumps({"changed": False, "guide_sha256": digest(guide_bytes)}))
        return

    backup_base = root / ".fmg-guide-backups"
    if backup_base.is_symlink():
        raise SystemExit("Backup directory is a symlink.")
    backup_base.mkdir(mode=0o700, exist_ok=True)
    backup = backup_base / f"buzz-{int(time.time())}-{uuid.uuid4().hex}"
    backup.mkdir(mode=0o700)
    sync_directory(backup_base)
    sync_directory(root)
    journal = {"stage": "prepared", "guide_sha256": digest(guide_bytes), "agents_before_sha256": digest(old_agents), "agents_after_sha256": digest(new_agents)}

    def save_record():
        record = backup / "receipt.json"
        temp = backup / (".receipt-" + uuid.uuid4().hex)
        try:
            with temp.open("x", encoding="utf-8") as handle:
                handle.write(json.dumps(journal, indent=2))
                handle.flush()
                os.fsync(handle.fileno())
            temp.chmod(0o600)
            os.replace(temp, record)
            sync_directory(backup)
        finally:
            if temp.exists():
                temp.unlink()

    for target, previous in [(agents, old_agents), (guide, old_guide)]:
        if previous is not None:
            saved = backup / target.name
            with saved.open("xb") as handle:
                handle.write(previous)
                handle.flush()
                os.fsync(handle.fileno())
            saved.chmod(0o600)
    save_record()

    def replace(target, data, expected):
        if read_regular(target, optional=True) != expected:
            raise SystemExit("Workspace changed; deployment requires a fresh read.")
        temp = root / ("." + target.name + "." + uuid.uuid4().hex)
        try:
            with temp.open("xb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            temp.chmod(mode)
            if os.geteuid() == 0:
                os.chown(temp, source_stat.st_uid, source_stat.st_gid)
            if read_regular(target, optional=True) != expected:
                raise SystemExit("Workspace changed; deployment aborted.")
            os.replace(temp, target)
            sync_directory(root)
        finally:
            if temp.exists():
                temp.unlink()

    replace(guide, guide_bytes, old_guide)
    journal["stage"] = "guide_installed"
    save_record()
    replace(agents, new_agents, old_agents)
    journal["stage"] = "complete"
    save_record()
    print(json.dumps({"changed": True, "guide_sha256": digest(guide_bytes), "agents_sha256": digest(new_agents), "backup": str(backup), "stage": journal["stage"]}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: install-workspace.py EXISTING_WORKSPACE")
    install(Path(sys.argv[1]))
