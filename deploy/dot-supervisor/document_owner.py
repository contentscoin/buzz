"""Direct-owner grants for the isolated Gateway main proposal account."""
import json
import re
import secrets
import time
from store import canonical, digest

KEYS = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
PREFIX = "gateway-owner-main:"
MAX_REQUESTS = 50000


def reserved_client(current):
    return PREFIX + digest(canonical({key: current[key] for key in KEYS}).encode())


def validate_main_task(row, proposal, current):
    """A namespace prefix or project label alone cannot confer document rights."""
    project = proposal.get("project")
    if (row["client"] != reserved_client(current) or proposal.get("schema") != 4
            or proposal.get("proposal_account") != "gateway_owner_main"
            or any(proposal.get(key) != current[key] for key in KEYS)
            or digest(canonical(proposal).encode()) != row["proposal_hash"]
            or not isinstance(project, dict) or project.get("schema") != 1
            or project.get("project_id") != "buzz"
            or project.get("repository_url") != "https://github.com/contentscoin/buzz.git"
            or project.get("execution_host") != "hostinger"
            or project.get("role_id") != proposal.get("role_id")
            or project.get("role_id") not in ("fmg-planner", "fmg-frontend", "fmg-backend", "fmg-qa", "fmg-release")
            or project.get("branch") != "fmg-buzz/" + project["role_id"]
            or not isinstance(project.get("source_commit"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", project["source_commit"])
            or not isinstance(project.get("workspace_binding"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", project["workspace_binding"])):
        from documents import DocumentError
        raise DocumentError("document_unavailable")


class OwnerDocumentAccess:
    """Only the authenticated operator's direct-owner command can call this path."""
    def __init__(self, docs):
        self.docs, self.store = docs, docs.store
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS document_owner_access_requests (
            scope TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL,
            input_hash TEXT NOT NULL, receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL,
            created REAL NOT NULL,
            PRIMARY KEY(scope,request_id), FOREIGN KEY(task_id) REFERENCES tasks(id));
        CREATE TRIGGER IF NOT EXISTS document_owner_access_no_update
            BEFORE UPDATE ON document_owner_access_requests
            BEGIN SELECT RAISE(ABORT,'immutable_access_request'); END;
        CREATE TRIGGER IF NOT EXISTS document_owner_access_no_delete
            BEFORE DELETE ON document_owner_access_requests
            BEGIN SELECT RAISE(ABORT,'immutable_access_request'); END;
        """)

    def call(self, action, args, scope, current):
        from documents import DocumentError, identifier
        client = reserved_client(current)
        row = self.docs.source_task(identifier(args["task_id"]), client, current)
        validate_main_task(row, json.loads(row["proposal"]), current)
        grant = self.store.db.execute("SELECT * FROM document_desktop_access WHERE scope=? AND client=? AND task_id=?", (scope, client, row["id"])).fetchone()
        revision = grant["revision"] if grant else 0
        enabled = bool(grant and grant["enabled"])
        receipt = None
        replayed = False
        if action == "documents.owner_set":
            request = identifier(args["request_id"])
            if (type(args["enabled"]) is not bool or type(args["expected_revision"]) is not int
                    or not 0 <= args["expected_revision"] <= 2147483646
                    or not isinstance(args["proposal_hash"], str)
                    or not secrets.compare_digest(args["proposal_hash"], row["proposal_hash"])):
                raise DocumentError("invalid_request")
            input_hash = digest(canonical(args).encode())
            old = self.store.db.execute("SELECT * FROM document_owner_access_requests WHERE scope=? AND request_id=?", (scope, request)).fetchone()
            if old:
                if old["input_hash"] != input_hash or old["task_id"] != row["id"]:
                    raise DocumentError("request_conflict")
                if digest(old["receipt"].encode()) != old["receipt_hash"]:
                    raise DocumentError("integrity_error")
                receipt, replayed = json.loads(old["receipt"]), True
            else:
                if args["expected_revision"] != revision:
                    raise DocumentError("access_revision_conflict", revision)
                if self.store.db.execute("SELECT COUNT(*) FROM document_owner_access_requests").fetchone()[0] >= MAX_REQUESTS:
                    raise DocumentError("access_request_capacity")
                revision += 1
                enabled = args["enabled"]
                now = time.time()
                self.store.db.execute("INSERT INTO document_desktop_access VALUES(?,?,?,?,?,?) ON CONFLICT(scope,client,task_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated", (scope, client, row["id"], int(enabled), revision, now))
                receipt = {"request_id": request, "task_id": row["id"], "proposal_hash": row["proposal_hash"], "enabled": enabled, "revision": revision, "recorded_at": now}
                encoded = canonical(receipt)
                self.store.db.execute("INSERT INTO document_owner_access_requests VALUES(?,?,?,?,?,?,?)", (scope, request, row["id"], input_hash, encoded, digest(encoded.encode()), now))
        try:
            self.docs.source_task(row["id"], client, current, True)
            completed = True
        except DocumentError:
            completed = False
        return {"task_id": row["id"], "proposal_hash": row["proposal_hash"],
                "proposal_account": "gateway_owner_main", "revision": revision,
                "enabled": enabled, "completion_verified": completed,
                "receipt": receipt, "replayed": replayed,
                "audience": {key: current[key] for key in KEYS}}
