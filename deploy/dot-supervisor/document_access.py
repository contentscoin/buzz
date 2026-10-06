"""Explicit proposing-client delegation to the existing owner-encrypted Desktop."""
import base64
import json
import time
from store import canonical, digest
from tools import snapshot
from document_owner import OwnerDocumentAccess, reserved_client

KEYS = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
UUID = {"type": "string", "format": "uuid", "maxLength": 36}


def access_tool(name, description, properties, required, read):
    return {"name": "fmg_buzz_" + name, "description": description,
            "inputSchema": {"type": "object", "properties": properties,
                            "required": required, "additionalProperties": False},
            "annotations": {"readOnlyHint": read, "destructiveHint": False,
                            "idempotentHint": read, "openWorldHint": False}}


ACCESS_CATALOG = [
    access_tool("get_document_desktop_access", "Read the current revision of your task's Desktop document delegation. This does not grant access or run work.",
                {"task_id": UUID}, ["task_id"], True),
    access_tool("set_document_desktop_access", "Explicitly enable or revoke document access for this task on the verified owner's encrypted Buzz Desktop. Only the original proposing connection may grant it. Compare expected_revision; does not share with another owner/community/Gateway or approve a run.",
                {"task_id": UUID, "enabled": {"type": "boolean"},
                 "expected_revision": {"type": "integer", "minimum": 0}},
                ["task_id", "enabled", "expected_revision"], False),
]


def fail(code, revision=None):
    from documents import DocumentError
    raise DocumentError(code, revision)


class DocumentDesktop:
    """A private operator credential alone cannot cross the proposing-client gate."""
    def __init__(self, documents, resource):
        self.docs = documents
        self.store = documents.store
        self.resource = resource
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS document_desktop_access (
            scope TEXT NOT NULL, client TEXT NOT NULL, task_id TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            revision INTEGER NOT NULL CHECK(revision>0), updated REAL NOT NULL,
            PRIMARY KEY(scope,client,task_id), FOREIGN KEY(task_id) REFERENCES tasks(id));
        """)
        self.owner_access = OwnerDocumentAccess(documents)

    def authorized_client(self, client, current):
        if client == reserved_client(current):
            return True
        return bool(self.resource and self.store.db.execute("SELECT 1 FROM tokens WHERE client_id=? AND scope='buzz:tasks' AND resource=? AND kind IN ('access','refresh') AND expires>? LIMIT 1", (client, self.resource, time.time())).fetchone())

    def access(self, name, args, scope, client, current):
        expected_keys = {"task_id"} if name.endswith("get_document_desktop_access") else {"task_id", "enabled", "expected_revision"}
        if set(args) != expected_keys:
            fail("invalid_request")
        row = self.docs.source_task(args["task_id"], client, current)
        old = self.store.db.execute("SELECT * FROM document_desktop_access WHERE scope=? AND client=? AND task_id=?", (scope, client, row["id"])).fetchone()
        revision = old["revision"] if old else 0
        if name.endswith("set_document_desktop_access"):
            if type(args["enabled"]) is not bool or type(args["expected_revision"]) is not int or args["expected_revision"] < 0:
                fail("invalid_request")
            if args["expected_revision"] != revision:
                fail("access_revision_conflict", revision)
            revision += 1
            self.store.db.execute("INSERT INTO document_desktop_access VALUES(?,?,?,?,?,?) ON CONFLICT(scope,client,task_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated", (scope, client, row["id"], int(args["enabled"]), revision, time.time()))
            enabled = args["enabled"]
        else:
            enabled = bool(old and old["enabled"])
        return {"task_id": row["id"], "enabled": enabled, "revision": revision,
                "audience": {key: current[key] for key in KEYS}}

    def projection(self, value, source=False):
        """Base64 bounds control-character expansion within NIP-44's frame limit."""
        provenance = value["source"]
        result = {key: value[key] for key in ("document_id", "version", "current_version", "previous_version", "request_id", "content_sha256", "content_bytes", "saved_at")}
        result["source"] = {key: provenance.get(key) for key in ("task_id", "run_id", "proposal_hash", "role_id", "requested_model", "requested_effort", "actual_model", "response_sha256", "source_completeness")}
        proof = provenance.get("completion_evidence", {})
        result["source"].update(receipt_sha256=proof.get("receipt_hash"), verified_at=proof.get("validated_at"))
        result["source_validation"] = value.get("source_validation", "verified_at_save")
        if source:
            result["source_base64"] = base64.b64encode(value["source_response"].encode()).decode("ascii")
        elif "markdown" in value:
            result["markdown_base64"] = base64.b64encode(value["markdown"].encode()).decode("ascii")
        if len(canonical(result).encode()) > 56000:
            fail("response_size_limit")
        return result

    def operator(self, data):
        """Called only after private operator authentication and broker signature checks."""
        from documents import identifier
        action, args = data.get("action"), data.get("arguments")
        extras = {"documents.owner_get": {"task_id"},
                  "documents.owner_set": {"task_id", "request_id", "proposal_hash", "enabled", "expected_revision"},
                  "documents.access": {"task_id"}, "documents.list": {"cursor"}, "documents.get": {"task_id", "document_id", "version"},
                  "documents.versions": {"task_id"}, "documents.task_source": {"task_id"}, "documents.source": {"task_id", "document_id", "version"},
                  "documents.by_request": {"task_id", "request_id"},
                  "documents.save": {"task_id", "request_id", "document_id", "expected_version", "markdown_base64"}}
        if set(data) != {"action", "arguments"} or action not in extras or not isinstance(args, dict) or set(args) != set(KEYS) | extras[action]:
            fail("invalid_request")
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                current = snapshot(args)
                if any(args[key] != current[key] for key in KEYS):
                    fail("access_denied")
                scope = digest(canonical({key: current[key] for key in KEYS}).encode())
                used_clients = set()
                if action in ("documents.owner_get", "documents.owner_set"):
                    result = self.owner_access.call(action, args, scope, current)
                elif action == "documents.access":
                    task = self.docs.tasks.read(identifier(args["task_id"]))
                    self.docs.source_task(task["id"], task["client"], current)
                    grant = self.store.db.execute("SELECT * FROM document_desktop_access WHERE scope=? AND client=? AND task_id=?", (scope, task["client"], task["id"])).fetchone()
                    try:
                        self.docs.source_task(task["id"], task["client"], current, True)
                        verified = True
                    except ValueError:
                        verified = False
                    result = {"task_id": task["id"], "enabled": bool(grant and grant["enabled"] and self.authorized_client(task["client"], current)), "completion_verified": verified, "revision": grant["revision"] if grant else 0}
                    if task["client"] == reserved_client(current):
                        result["proposal_account"] = "gateway_owner_main"
                elif action == "documents.list":
                    cursor = args["cursor"]
                    if cursor is not None:
                        identifier(cursor)
                    rows = self.store.db.execute("SELECT d.* FROM documents d JOIN document_desktop_access a ON a.scope=d.scope AND a.client=d.client AND a.task_id=d.task_id WHERE d.scope=? AND a.enabled=1 AND d.id>? AND (d.client=? OR EXISTS(SELECT 1 FROM tokens t WHERE t.client_id=d.client AND t.scope='buzz:tasks' AND t.resource=? AND t.kind IN ('access','refresh') AND t.expires>?)) ORDER BY d.id LIMIT 21", (scope, cursor or "", reserved_client(current), self.resource, time.time())).fetchall()
                    used_clients.update(row["client"] for row in rows[:20])
                    result = {"documents": [self.projection(self.docs.view(row["id"], None, scope, row["client"], current, False)) for row in rows[:20]], "limit": 20, "next_cursor": rows[19]["id"] if len(rows) > 20 else None}
                else:
                    task_id = identifier(args["task_id"])
                    grant = self.store.db.execute("SELECT * FROM document_desktop_access WHERE scope=? AND task_id=? AND enabled=1", (scope, task_id)).fetchone()
                    if not grant:
                        fail("desktop_access_required")
                    client = grant["client"]
                    if not self.authorized_client(client, current):
                        fail("desktop_access_required")
                    used_clients.add(client)
                    if action == "documents.task_source":
                        task = self.docs.source_task(task_id, client, current, True)
                        stored = json.loads(task["result"])
                        result = {"task_id": task_id, "run_id": task["run_id"], "source_base64": base64.b64encode(stored["reply"].encode()).decode("ascii"), "response_sha256": stored["completion_evidence"]["reply_hash"], "source_completeness": stored["completion_evidence"]["source_completeness"]}
                    elif action == "documents.save":
                        encoded = args["markdown_base64"]
                        if not isinstance(encoded, str) or len(encoded) > 43692:
                            fail("content_too_large")
                        try:
                            raw = base64.b64decode(encoded, validate=True)
                            if base64.b64encode(raw).decode("ascii") != encoded:
                                fail("invalid_request")
                            markdown = raw.decode("utf-8")
                        except (ValueError, UnicodeError):
                            fail("invalid_request")
                        result = self.projection(self.docs.save({"task_id": task_id, "request_id": args["request_id"], "document_id": args["document_id"], "expected_version": args["expected_version"], "markdown": markdown}, scope, client, current))
                    elif action == "documents.versions":
                        doc = self.store.db.execute("SELECT id FROM documents WHERE scope=? AND client=? AND task_id=?", (scope, client, task_id)).fetchone()
                        versions = self.store.db.execute("SELECT version FROM document_versions WHERE document_id=? ORDER BY version DESC", (doc["id"],)).fetchall() if doc else []
                        result = {"versions": [self.projection(self.docs.view(doc["id"], item["version"], scope, client, current, False)) for item in versions], "limit": 20}
                    else:
                        if action == "documents.by_request":
                            request = self.docs.request(identifier(args["request_id"]), scope, client)
                            if not request:
                                fail("document_not_found")
                            document_id, version = request["document_id"], request["version"]
                        else:
                            document_id, version = identifier(args["document_id"]), args["version"]
                            if version is not None and (type(version) is not int or not 1 <= version <= 20):
                                fail("invalid_request")
                        value = self.docs.request_view(request, scope, client, current) if action == "documents.by_request" else self.docs.view(document_id, version, scope, client, current)
                        if value["source"]["task_id"] != task_id:
                            fail("document_unavailable")
                        if action == "documents.by_request":
                            value["request_id"] = args["request_id"]
                        result = self.projection(value, action == "documents.source")
                final = snapshot(args)
                if final["generation"] != current["generation"] or any(final[key] != current[key] for key in KEYS):
                    fail("access_denied")
                if any(not self.authorized_client(client, final) for client in used_clients):
                    fail("access_denied")
                if len(canonical(result).encode()) > 56000:
                    fail("response_size_limit")
                self.store.db.commit()
                return result
            except BaseException:
                self.store.db.rollback()
                raise
