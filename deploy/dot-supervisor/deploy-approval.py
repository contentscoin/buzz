"""Deploy the owner browser approval server without approving work or changing Gateway."""
import ast
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import uuid

os.umask(0o077)
root = Path("/docker/fmg-dot-supervisor")
gateway = Path("/docker/openclaw-cknk/data/.openclaw")
manifest = json.loads(Path(sys.argv[1]).read_text())
request = str(uuid.UUID(manifest["request_id"]))
assert request == manifest["request_id"] and len(manifest["source_commit"]) == 40, "invalid_deployment_identity"
bundle = Path(manifest["bundle_path"])
assert bundle.parent == Path("/tmp") and hashlib.sha256(bundle.read_bytes()).hexdigest() == manifest["bundle_sha256"], "bundle_identity_mismatch"
backup = root / "backups" / ("dot-owner-approval-" + request)
receipt_path = root / ("dot-owner-approval-" + request + ".json")
report = {"schema": 1, "request_id": request, "source_commit": manifest["source_commit"],
          "bundle_sha256": manifest["bundle_sha256"], "stage": "prepared", "backup_directory": str(backup)}


def save():
    temporary = receipt_path.with_suffix(".tmp")
    with temporary.open("w") as output:
        json.dump(report, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, receipt_path)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def state():
    with sqlite3.connect("file:"+str(root / "data/oauth.sqlite3")+"?mode=ro", uri=True) as database:
        assert database.execute("SELECT COUNT(*) FROM tasks WHERE status IN ('approved','dispatching','cancel_requested','needs_reconcile')").fetchone()[0] == 0, "active_or_uncertain_tasks_block_rollout"
        tables = ("tasks", "document_sources", "documents", "document_versions", "document_requests",
                  "document_desktop_access", "document_owner_access_requests", "clients", "tokens",
                  "dot_community_access", "dot_community_access_requests")
        # Credential hashes and private bodies are compared in memory only.
        return {table: list(database.execute("SELECT * FROM "+table+" ORDER BY rowid")) for table in tables}


def command(arguments, log, timeout=60):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)
    (backup / log).write_text((result.stdout+result.stderr)[:524288])
    return result


lock = None
try:
    lock = os.open(root / ".dot-owner-approval.lock", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(lock, request.encode())
    os.fsync(lock)
    if receipt_path.exists():
        old = json.loads(receipt_path.read_text())
        assert old["source_commit"] == manifest["source_commit"] and old["bundle_sha256"] == manifest["bundle_sha256"], "deployment_request_conflict"
        assert old["stage"] == "complete", "previous_rollout_requires_reconcile"
        print(json.dumps(old))
        sys.exit(0)
    before = state()
    protected = (gateway / "openclaw.json", gateway / "projects/buzz/manifest.json",
                 gateway / "secrets/fmg-supervisor-operator.token", root / "data/owner.hash", root / "data/operator.token")
    protected_hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in protected]
    backup.mkdir(mode=0o700)
    shutil.copy2(root / "compose.json", backup / "compose.json")
    shutil.copy2(gateway / "openclaw.json", backup / "openclaw.json")
    with sqlite3.connect("file:"+str(root / "data/oauth.sqlite3")+"?mode=ro", uri=True) as source:
        with sqlite3.connect(backup / "oauth.sqlite3") as destination:
            source.backup(destination)
    save()
    release = root / "releases" / ("dot-owner-approval-" + request)
    release.mkdir(mode=0o700)
    expected = {"server.py", "store.py", "tools.py", "tasks.py", "auth.py", "deploy.py", "completion.py",
                "documents.py", "document_access.py", "document_owner.py", "communities.py", "approvals.py",
                "approval_pages.py", "approval_widget.html"}
    with tarfile.open(bundle) as archive:
        members = archive.getmembers()
        assert len(members) == len(expected) and {member.name for member in members} == expected, "release_members_invalid"
        assert all(member.isfile() and member.size <= 100000 for member in members), "release_size_invalid"
        archive.extractall(release, filter="data")
    os.chown(release, 1000, 1000)
    for path in release.iterdir():
        os.chown(path, 1000, 1000)
        path.chmod(0o600)
        if path.suffix == ".py":
            ast.parse(path.read_text(), filename=str(path))
    assert state() == before, "state_changed_before_server_apply"
    compose = json.loads((root / "compose.json").read_text())
    volumes = compose["services"]["bridge"]["volumes"]
    assert sum(isinstance(value, str) and value.endswith(":/app:ro") for value in volumes) == 1, "app_volume_ambiguous"
    compose["services"]["bridge"]["volumes"] = [str(release)+":/app:ro" if value.endswith(":/app:ro") else value for value in volumes]
    temporary = root / "compose.approval.tmp"
    with temporary.open("w") as output:
        json.dump(compose, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, root / "compose.json")
    report.update(stage="applying_server", release_directory=str(release))
    save()
    result = command(["docker", "compose", "-p", "fmg-dot-supervisor", "-f", str(root / "compose.json"), "up", "-d"], "server-apply.log")
    assert result.returncode == 0, "server_apply_failed"
    health = None
    for _ in range(10):
        result = command(["docker", "exec", "fmg-dot-supervisor", "python", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/dot-supervisor/health',timeout=3).read().decode())"], "server-health.log", 10)
        if result.returncode == 0:
            health = json.loads(result.stdout)
            if health.get("version") == "0.11.0" and health.get("status") == "ready":
                break
        time.sleep(2)
    assert health and health.get("version") == "0.11.0" and health.get("status") == "ready", "server_health_unconfirmed"
    assert state() == before, "existing_data_changed"
    assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in protected] == protected_hashes, "protected_files_changed"
    with sqlite3.connect("file:"+str(root / "data/oauth.sqlite3")+"?mode=ro", uri=True) as database:
        tables = ("dot_task_approvals", "dot_approval_sessions", "dot_approval_failures")
        assert all(database.execute("SELECT COUNT(*) FROM "+table).fetchone()[0] == 0 for table in tables), "unexpected_owner_approval_or_authentication"
    report.update(stage="complete", observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), public_health=health,
                  gateway_models_efforts_auth_and_config_preserved=True, original_tasks_documents_tokens_grants_preserved=True,
                  approval_schema_migrated=True, approvals_created=0, tasks_executed=0, gateway_restart_performed=False,
                  chatgpt_rendering_and_human_approval_observed=False)
    save()
    print(json.dumps(report))
except BaseException as error:
    if backup.exists() and not (isinstance(error, SystemExit) and error.code == 0):
        report.update(stage="needs_review", error_type=type(error).__name__, error_code=str(error)[:160])
        save()
    raise
finally:
    if lock is not None:
        os.close(lock)
        (root / ".dot-owner-approval.lock").unlink()
