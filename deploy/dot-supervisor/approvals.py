"""Dot can prepare approval; only the password-verified owner browser can commit it."""
import hashlib
import hmac
import json
import re
import secrets
import time
import uuid
from urllib.parse import urlencode
from communities import binding, scoped_catalog, split
from store import canonical, digest
from tasks import UUID, task_id

UI_URI = "ui://fmg-buzz/task-approval-v1.html"
NAME = "fmg_buzz_prepare_task_approval"
CATALOG = scoped_catalog([{
    "name": NAME, "title": "Buzz 작업 승인 화면 열기",
    "description": "Prepare an owner approval screen for your own immutable proposal. This NEVER approves or executes work. First get the task and pass its exact hash and revision. Show the owner the returned link/widget; ONLY the human owner enters their existing MCP connection password on the server page and presses the final approve button. Never navigate the approval page, request the password in chat, or submit approval for the owner. Reuse request_id after response loss; an expired screen needs a new UUID.",
    "inputSchema": {"type": "object", "properties": {
        "request_id": UUID, "task_id": UUID,
        "proposal_hash": {"type": "string", "pattern": "^[0-9a-f]{64}$", "maxLength": 64},
        "revision": {"type": "integer", "minimum": 1}},
        "required": ["request_id", "task_id", "proposal_hash", "revision"], "additionalProperties": False},
    "outputSchema": {"type": "object", "properties": {
        "task": {"type": "object"}, "approval": {"type": "object"},
        "execution_approval_performed": {"type": "boolean"}},
        "required": ["task", "approval", "execution_approval_performed"], "additionalProperties": False},
    "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
    "_meta": {"ui": {"resourceUri": UI_URI}, "openai/outputTemplate": UI_URI,
              "openai/toolInvocation/invoking": "승인 화면 준비 중", "openai/toolInvocation/invoked": "소유자 승인 화면 준비됨"}}])


class ApprovalError(ValueError):
    pass


class Approvals:
    def __init__(self, tasks, oauth, secret):
        self.tasks, self.store, self.oauth = tasks, tasks.store, oauth
        self.secret = secret.encode()
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS dot_task_approvals (
          id TEXT PRIMARY KEY, client TEXT NOT NULL, request_id TEXT NOT NULL,
          input_hash TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL, community_id TEXT NOT NULL, audience TEXT NOT NULL,
          oauth_family TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
          created REAL NOT NULL, expires REAL NOT NULL, receipt TEXT,
          UNIQUE(client,request_id));
        CREATE TRIGGER IF NOT EXISTS dot_approval_receipt_immutable BEFORE UPDATE ON dot_task_approvals
          WHEN OLD.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable_approval_receipt'); END;
        CREATE TRIGGER IF NOT EXISTS dot_approval_binding_immutable BEFORE UPDATE ON dot_task_approvals
          WHEN NEW.id!=OLD.id OR NEW.client!=OLD.client OR NEW.request_id!=OLD.request_id
          OR NEW.input_hash!=OLD.input_hash OR NEW.task_id!=OLD.task_id OR NEW.revision!=OLD.revision
          OR NEW.proposal_hash!=OLD.proposal_hash OR NEW.community_id!=OLD.community_id
          OR NEW.audience!=OLD.audience OR NEW.oauth_family!=OLD.oauth_family
          OR NEW.token_hash!=OLD.token_hash OR NEW.created!=OLD.created OR NEW.expires!=OLD.expires
          BEGIN SELECT RAISE(ABORT,'immutable_approval_binding'); END;
        CREATE TRIGGER IF NOT EXISTS dot_approval_no_delete BEFORE DELETE ON dot_task_approvals
          BEGIN SELECT RAISE(ABORT,'immutable_approval_request'); END;
        CREATE TABLE IF NOT EXISTS dot_approval_sessions (
          hash TEXT PRIMARY KEY, approval_id TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS dot_approval_failures (
          peer TEXT PRIMARY KEY, count INTEGER NOT NULL, updated REAL NOT NULL);
        """)
        self.tasks.dot_approval_receipt = self.receipt

    def receipt(self, task):
        row = self.store.db.execute("SELECT receipt FROM dot_task_approvals WHERE task_id=? AND receipt IS NOT NULL ORDER BY created DESC LIMIT 1", (task,)).fetchone()
        return json.loads(row["receipt"]) if row else None

    def token(self, row):
        message = canonical(["dot-owner-approval-v1", row["id"], row["client"], row["input_hash"]])
        return hmac.new(self.secret, message.encode(), hashlib.sha256).hexdigest()

    def csrf(self, token, session):
        return hmac.new(self.secret, canonical(["dot-owner-confirm-v1", token, session]).encode(), hashlib.sha256).hexdigest()

    def connection(self, row):
        active = self.store.db.execute("SELECT 1 FROM tokens WHERE client_id=? AND family=? AND scope=? AND resource=? AND kind IN ('access','refresh') AND expires>? LIMIT 1",
                                       (row["client"], row["oauth_family"], self.oauth.scope, self.oauth.resource, time.time())).fetchone()
        if not active:
            raise ApprovalError("connection_unavailable")

    def current(self, row, pending=True):
        self.connection(row)
        current = self.tasks.communities.current(row["client"], row["community_id"])
        task = self.tasks.read(row["task_id"], row["client"])
        proposal = json.loads(task["proposal"])
        if binding(current) != json.loads(row["audience"]) or binding(proposal) != binding(current):
            raise ApprovalError("approval_binding_changed")
        if task["proposal_hash"] != row["proposal_hash"]:
            raise ApprovalError("approval_binding_changed")
        if pending:
            if row["expires"] <= time.time() or task["created"] + 86400 <= time.time():
                raise ApprovalError("approval_screen_expired")
            if task["status"] != "awaiting_approval" or task["revision"] != row["revision"]:
                raise ApprovalError("approval_state_conflict")
            role = next((item for item in current["gateway"]["roles"] if item["role_id"] == proposal["role_id"]), None)
            project_valid = (proposal.get("schema") == 3 and "project" not in proposal) or (proposal.get("schema") == 4 and proposal.get("project") in current.get("project_bindings", []))
            if not role or role.get("configured_model") != proposal["requested_model"] or role.get("model_binding") != proposal.get("model_binding") or proposal.get("requested_effort") not in role.get("supported_efforts", []) or not project_valid:
                raise ApprovalError("approval_binding_changed")
        return task, current

    def prepare(self, args, client, header, authorize):
        parameters, community = split(args)
        if set(parameters) != {"request_id", "task_id", "proposal_hash", "revision"} or type(parameters["revision"]) is not int or parameters["revision"] < 1 or not re.fullmatch(r"[0-9a-f]{64}", parameters["proposal_hash"]):
            raise ApprovalError("approval_request_invalid")
        request, identifier = task_id(parameters["request_id"]), task_id(parameters["task_id"])
        with self.store.lock, self.store.db:
            if authorize() != client:
                raise ApprovalError("connection_unavailable")
            current = self.tasks.communities.current(client, community)
            audience = canonical(binding(current))
            input_hash = digest(canonical(dict(parameters, audience=binding(current))).encode())
            row = self.store.db.execute("SELECT * FROM dot_task_approvals WHERE client=? AND request_id=?", (client, request)).fetchone()
            if row and row["input_hash"] != input_hash:
                raise ApprovalError("request_conflict")
            if not row:
                if self.store.db.execute("SELECT COUNT(*) FROM dot_task_approvals").fetchone()[0] >= 10000 or self.store.db.execute("SELECT COUNT(*) FROM dot_task_approvals WHERE client=? AND expires>?", (client, time.time())).fetchone()[0] >= 20:
                    raise ApprovalError("approval_capacity")
                bearer = self.store.db.execute("SELECT family FROM tokens WHERE hash=? AND kind='access'", (digest(header[7:].encode()),)).fetchone()
                now = time.time()
                value = dict(parameters, id=str(uuid.uuid4()), client=client, request_id=request, input_hash=input_hash,
                             community_id=current.get("community_id", "bd"), audience=audience,
                             oauth_family=bearer["family"], created=now, expires=now + 600)
                value["token_hash"] = digest(self.token(value).encode())
                self.current(value)
                keys = list(value)
                self.store.db.execute("INSERT INTO dot_task_approvals(" + ",".join(keys) + ") VALUES(" + ",".join("?" for _ in keys) + ")", [value[key] for key in keys])
                self.store.db.commit()
                row = self.store.db.execute("SELECT * FROM dot_task_approvals WHERE client=? AND request_id=?", (client, request)).fetchone()
            task, final = self.current(row, pending=False)
            if final["generation"] != current["generation"] or authorize() != client:
                raise ApprovalError("response_unconfirmed_reuse_request_uuid")
            approval = {"request_id": request, "expires_at": row["expires"], "community_id": row["community_id"],
                        "status": "recorded" if row["receipt"] else "expired" if row["expires"] <= time.time() else "awaiting_owner_browser",
                        "url": self.oauth.issuer + "/approval?" + urlencode({"token": self.token(row)}),
                        "requires": "owner_connection_password_then_explicit_approve",
                        "receipt": json.loads(row["receipt"]) if row["receipt"] else None}
            result = {"task": self.tasks.view(task), "approval": approval, "execution_approval_performed": False}
            return {"content": [{"type": "text", "text": canonical(result)}], "structuredContent": result, "isError": False}

    def lookup(self, token):
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
            raise ApprovalError("approval_unavailable")
        row = self.store.db.execute("SELECT * FROM dot_task_approvals WHERE token_hash=?", (digest(token.encode()),)).fetchone()
        if not row:
            raise ApprovalError("approval_unavailable")
        return row

    def authenticate(self, row, password, peer):
        now, peer = time.time(), digest(peer.encode())
        self.store.db.execute("DELETE FROM dot_approval_failures WHERE updated<?", (now-600,))
        previous = self.store.db.execute("SELECT * FROM dot_approval_failures WHERE peer=?", (peer,)).fetchone()
        total = self.store.db.execute("SELECT COALESCE(SUM(count),0) FROM dot_approval_failures").fetchone()[0]
        if (previous and previous["count"] >= 5) or total >= 30:
            raise ApprovalError("approval_password_rate_limit")
        # Record each attempt before scrypt, including successful attempts, to bound resource use.
        self.store.db.execute("INSERT INTO dot_approval_failures VALUES(?,1,?) ON CONFLICT(peer) DO UPDATE SET count=count+1,updated=excluded.updated", (peer, now))
        self.store.db.commit()
        if not isinstance(password, str) or not password or len(password.encode()) > 512:
            raise ApprovalError("owner_authentication_failed")
        salt, expected = self.oauth.owner_hash.split(":", 1)
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        if not secrets.compare_digest(actual, expected):
            raise ApprovalError("owner_authentication_failed")
        self.current(row, pending=not row["receipt"])
        self.store.db.execute("DELETE FROM dot_approval_sessions WHERE expires<?", (now,))
        if self.store.db.execute("SELECT COUNT(*) FROM dot_approval_sessions").fetchone()[0] >= 2000 or self.store.db.execute("SELECT COUNT(*) FROM dot_approval_sessions WHERE approval_id=?", (row["id"],)).fetchone()[0] >= 20:
            raise ApprovalError("approval_capacity")
        session = secrets.token_urlsafe(32)
        self.store.db.execute("INSERT INTO dot_approval_sessions VALUES(?,?,?)", (digest(session.encode()), row["id"], now+300))
        self.store.db.commit()
        return session

    def session(self, row, session):
        if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", session):
            return False
        return bool(self.store.db.execute("SELECT 1 FROM dot_approval_sessions WHERE hash=? AND approval_id=? AND expires>?", (digest(session.encode()), row["id"], time.time())).fetchone())

    def approve(self, token, session, csrf):
        with self.store.lock, self.store.db:
            row = self.lookup(token)
            if not self.session(row, session) or not isinstance(csrf, str) or not secrets.compare_digest(csrf, self.csrf(token, session)):
                raise ApprovalError("owner_confirmation_required")
            task, current = self.current(row, pending=not row["receipt"])
            if row["receipt"]:
                return json.loads(row["receipt"])
            # Recheck the fresh snapshot inside the same serialized commit; never call operator.approve (it commits separately).
            final = self.tasks.communities.current(row["client"], row["community_id"])
            if final["generation"] != current["generation"] or binding(final) != binding(current):
                raise ApprovalError("approval_binding_changed")
            now = time.time()
            receipt = {"schema": 1, "request_id": row["request_id"], "task_id": task["id"],
                       "proposal_hash": task["proposal_hash"], "previous_revision": task["revision"], "approved_revision": task["revision"]+1,
                       "client_id": row["client"], "community_id": row["community_id"], "audience": binding(current),
                       "source": "chatgpt_dot_owner_password_browser", "approved_at": now, "status": "approved"}
            receipt["receipt_hash"] = digest(canonical(receipt).encode())
            updated = self.store.db.execute("UPDATE tasks SET status='approved',revision=revision+1,updated=? WHERE id=? AND client=? AND status='awaiting_approval' AND revision=? AND proposal_hash=?", (now, task["id"], row["client"], row["revision"], row["proposal_hash"]))
            if updated.rowcount != 1:
                raise ApprovalError("approval_state_conflict")
            self.store.db.execute("UPDATE dot_task_approvals SET receipt=? WHERE id=? AND receipt IS NULL", (canonical(receipt), row["id"]))
            self.store.db.commit()
            return receipt
