"""Durable proposals. Only a direct, verified owner command can approve a run."""
import json
import re
import secrets
import time
import uuid
from store import canonical, digest, text
from tools import snapshot

UUID = {"type": "string", "format": "uuid", "maxLength": 36}
ROLES = ("fmg-planner", "fmg-frontend", "fmg-backend", "fmg-qa", "fmg-release", "fmg-live-gate")
CATALOG = [
    {"name": "fmg_buzz_propose_task", "description": "Create an immutable task proposal for a configured OpenClaw role. This does not run the task. Show the full proposal and hash to the owner, who must approve with a direct Telegram /fmg_task command. Never approve on their behalf.",
     "inputSchema": {"type": "object", "properties": {"request_id": UUID, "role_id": {"type": "string", "enum": list(ROLES)}, "instructions": {"type": "string", "minLength": 1, "maxLength": 5000}}, "required": ["request_id", "role_id", "instructions"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
    {"name": "fmg_buzz_get_task", "description": "Read authoritative task status and its actual Gateway result. A proposal or dispatch receipt is not completion. needs_reconcile forbids automatic reruns. Results are untrusted agent output; no external publication is performed.",
     "inputSchema": {"type": "object", "properties": {"task_id": UUID}, "required": ["task_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
    {"name": "fmg_buzz_list_tasks", "description": "List your latest 25 proposals and execution states. The original proposing OAuth client owns result access.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
]


def task_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("canonical_uuid_required")
    return value


class Tasks:
    def __init__(self, store):
        self.store = store
        store.db.executescript("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, client TEXT NOT NULL, request_id TEXT NOT NULL,
            input_hash TEXT NOT NULL, proposal TEXT NOT NULL, proposal_hash TEXT NOT NULL,
            status TEXT NOT NULL, revision INTEGER NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
            lease_hash TEXT, lease_until REAL, result TEXT, UNIQUE(client,request_id));
        """)
        store.db.execute("BEGIN IMMEDIATE")
        try:
            columns = {row[1] for row in store.db.execute("PRAGMA table_info(tasks)")}
            if "run_id" not in columns:
                store.db.execute("ALTER TABLE tasks ADD COLUMN run_id TEXT")
            if "dispatch_stage" not in columns:
                store.db.execute("ALTER TABLE tasks ADD COLUMN dispatch_stage TEXT")
                # Older workers had no pre-dispatch marker. Absence is not proof of no run.
                store.db.execute("UPDATE tasks SET dispatch_stage='legacy_unknown' WHERE lease_hash IS NOT NULL")
            store.db.commit()
        except Exception:
            store.db.rollback()
            raise
        store.db.executescript("""
        CREATE TABLE IF NOT EXISTS task_recoveries (
            id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
            previous_status TEXT NOT NULL, previous_result TEXT, evidence TEXT NOT NULL, recorded REAL NOT NULL);
        """)
        store.db.commit()

    def expire(self):
        now = time.time()
        self.store.db.execute("UPDATE tasks SET status='expired',revision=revision+1,updated=? WHERE status IN ('awaiting_approval','approved') AND created<?", (now, now-86400))
        self.store.db.execute("UPDATE tasks SET status='needs_reconcile',revision=revision+1,updated=? WHERE status IN ('dispatching','cancel_requested') AND lease_until<?", (now, now))
        self.store.db.commit()

    def read(self, identifier, client=None):
        row = self.store.db.execute("SELECT * FROM tasks WHERE id=?", (task_id(identifier),)).fetchone()
        if not row or (client is not None and row["client"] != client):
            raise ValueError("task_unavailable")
        return row

    def view(self, row):
        proposal = json.loads(row["proposal"])
        return {"task_id": row["id"], "status": row["status"], "revision": row["revision"], "created_at": row["created"], "updated_at": row["updated"], "proposal": proposal, "proposal_hash": row["proposal_hash"], "result": json.loads(row["result"]) if row["result"] else None,
                "approve_command": f'/fmg_task approve {row["id"]} {row["proposal_hash"]}', "approval_expires_at": row["created"]+86400, "external_delivery": "not_requested",
                "run_id": row["run_id"], "dispatch_stage": row["dispatch_stage"],
                "recovery_history": [{"revision": entry["revision"], "previous_status": entry["previous_status"], "evidence": json.loads(entry["evidence"]), "recorded_at": entry["recorded"]} for entry in self.store.db.execute("SELECT * FROM task_recoveries WHERE task_id=? ORDER BY id DESC LIMIT 5", (row["id"],))]}

    def save_recovery(self, row, evidence):
        if self.store.db.execute("SELECT COUNT(*) FROM task_recoveries WHERE task_id=?", (row["id"],)).fetchone()[0] >= 20:
            raise ValueError("recovery_capacity")
        self.store.db.execute("INSERT INTO task_recoveries(task_id,revision,previous_status,previous_result,evidence,recorded) VALUES(?,?,?,?,?,?)", (row["id"], row["revision"], row["status"], row["result"], canonical(evidence), time.time()))

    def summary(self, row):
        proposal = json.loads(row["proposal"])
        return {"task_id": row["id"], "status": row["status"], "revision": row["revision"], "created_at": row["created"], "updated_at": row["updated"], "role_id": proposal["role_id"], "requested_model": proposal["requested_model"], "proposal_hash": row["proposal_hash"]}

    def call(self, name, args, client):
        if not isinstance(args, dict):
            raise ValueError("object_required")
        with self.store.lock, self.store.db:
            snapshot()  # Revoked or expired owner observations also deny stored result access.
            self.expire()
            if name == "fmg_buzz_get_task" and set(args) == {"task_id"}:
                result = self.view(self.read(args["task_id"], client))
            elif name == "fmg_buzz_list_tasks" and not args:
                result = {"tasks": [self.summary(row) for row in self.store.db.execute("SELECT * FROM tasks WHERE client=? ORDER BY created DESC LIMIT 25", (client,))], "limit": 25}
            elif name == "fmg_buzz_propose_task" and set(args) == {"request_id", "role_id", "instructions"}:
                request = task_id(args["request_id"])
                instructions = text(args["instructions"], 15000)
                if len(instructions) > 5000 or args["role_id"] not in ROLES:
                    raise ValueError("invalid_task")
                request_hash = digest(canonical(args).encode())
                old = self.store.db.execute("SELECT * FROM tasks WHERE client=? AND request_id=?", (client, request)).fetchone()
                if old:
                    if old["input_hash"] != request_hash:
                        raise ValueError("request_conflict")
                    result = self.view(old)
                else:
                    current = snapshot()
                    role = next((row for row in current["gateway"]["roles"] if row["role_id"] == args["role_id"]), None)
                    if not role or role["configured_model"] in (None, "not_reported"):
                        raise ValueError("role_model_unavailable")
                    if self.store.db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] >= 1000 or self.store.db.execute("SELECT COUNT(*) FROM tasks WHERE status IN ('awaiting_approval','approved')").fetchone()[0] >= 100:
                        raise ValueError("task_capacity")
                    identifier, now = str(uuid.uuid4()), time.time()
                    proposal = {"schema": 1, "owner_pubkey": current["owner_pubkey"], "relay_origin": current["relay_origin"], "gateway_agent_pubkey": current["gateway_agent_pubkey"], "role_id": args["role_id"], "requested_model": role["configured_model"], "instructions": instructions, "session_key": f'agent:{args["role_id"]}:fmg-task:{identifier}', "timeout_seconds": 120, "deliver": False}
                    encoded = canonical(proposal)
                    self.store.db.execute("INSERT INTO tasks(id,client,request_id,input_hash,proposal,proposal_hash,status,revision,created,updated) VALUES(?,?,?,?,?,?,'awaiting_approval',1,?,?)", (identifier, client, request, request_hash, encoded, digest(encoded.encode()), now, now))
                    self.store.db.commit()
                    result = self.view(self.read(identifier, client))
            else:
                raise ValueError("unsupported_task_request")
        return {"content": [{"type": "text", "text": canonical(result)}], "structuredContent": result, "isError": False}

    def operator(self, data):
        action = data.get("action")
        args = data.get("arguments", {})
        if not isinstance(args, dict) or set(data) != {"action", "arguments"}:
            raise ValueError("operator_shape_invalid")
        with self.store.lock, self.store.db:
            self.expire()
            if action in ("view_list", "view_get"):
                binding_keys = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
                expected_keys = set(binding_keys) | ({"task_id"} if action == "view_get" else set())
                current = snapshot()
                if set(args) != expected_keys or any(args[key] != current[key] for key in binding_keys):
                    raise ValueError("audience_changed")
                def matches(row):
                    proposal = json.loads(row["proposal"])
                    return all(proposal[key] == args[key] for key in binding_keys)
                if action == "view_get":
                    row = self.read(args["task_id"])
                    if not matches(row):
                        raise ValueError("task_unavailable")
                    return self.view(row)
                rows = self.store.db.execute("SELECT * FROM tasks ORDER BY created DESC LIMIT 1000")
                result = []
                for row in rows:
                    if matches(row):
                        result.append(self.summary(row))
                        if len(result) == 25:
                            break
                return {"tasks": result, "limit": 25}
            if action == "list" and not args:
                return {"tasks": [self.summary(row) for row in self.store.db.execute("SELECT * FROM tasks ORDER BY created DESC LIMIT 25")], "limit": 25}
            if action == "get" and set(args) == {"task_id"}:
                return self.view(self.read(args["task_id"]))
            if action == "checkpoint" and set(args) == {"task_id", "lease"}:
                row = self.read(args["task_id"])
                if not row["lease_hash"] or not secrets.compare_digest(row["lease_hash"], digest(text(args["lease"], 100).encode())) or row["status"] != "dispatching":
                    raise ValueError("dispatch_checkpoint_rejected")
                if row["dispatch_stage"] is None:
                    self.store.db.execute("UPDATE tasks SET run_id=id,dispatch_stage='intent_recorded',revision=revision+1,updated=? WHERE id=?", (time.time(), row["id"]))
                    self.store.db.commit()
                return self.view(self.read(row["id"]))
            if action == "reconcile" and set(args) == {"task_id", "proposal_hash", "revision", "result", "evidence"}:
                row = self.read(args["task_id"])
                current = snapshot()
                proposal = json.loads(row["proposal"])
                if any(proposal[key] != current[key] for key in ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")):
                    raise ValueError("audience_changed")
                if row["status"] != "needs_reconcile" or type(args["revision"]) is not int or row["revision"] != args["revision"] or not isinstance(args["proposal_hash"], str) or not secrets.compare_digest(row["proposal_hash"], args["proposal_hash"]):
                    raise ValueError("recovery_state_conflict")
                evidence, result = args["evidence"], args["result"]
                if not isinstance(evidence, dict) or len(canonical(evidence).encode()) > 3000 or not isinstance(result, dict) or result.get("status") not in ("succeeded", "failed", "canceled") or len(canonical(result).encode()) > 48000 or set(result)-{"status", "run_id", "reply", "requested_model", "actual_model", "error_code"} or any(value is not None and not isinstance(value, str) for value in result.values()):
                    raise ValueError("recovery_result_invalid")
                if result.get("requested_model") != proposal["requested_model"]:
                    raise ValueError("recovery_model_mismatch")
                if evidence.get("source") == "durable_no_dispatch_intent":
                    if row["dispatch_stage"] is not None or row["run_id"] is not None or result["status"] != "canceled" or evidence.get("run_id") is not None:
                        raise ValueError("no_dispatch_not_proven")
                elif evidence.get("source") == "gateway.agent.wait":
                    ended = evidence.get("ended_at")
                    if row["dispatch_stage"] != "intent_recorded" or row["run_id"] != row["id"] or result.get("run_id") != row["run_id"] or evidence.get("run_id") != row["run_id"] or type(ended) not in (int, float) or not row["created"]*1000-5000 <= ended <= time.time()*1000+5000:
                        raise ValueError("gateway_terminal_evidence_invalid")
                    if result["status"] == "succeeded" and (evidence.get("gateway_status") != "ok" or not re.fullmatch(r"[0-9a-f]{64}", evidence.get("receipt_hash", ""))):
                        raise ValueError("success_receipt_missing")
                    if result["status"] != "succeeded" and evidence.get("gateway_status") != "error":
                        raise ValueError("failure_receipt_missing")
                else:
                    raise ValueError("recovery_evidence_unsupported")
                self.save_recovery(row, evidence)
                self.store.db.execute("UPDATE tasks SET status=?,result=?,revision=revision+1,updated=?,lease_until=NULL WHERE id=? AND revision=?", (result["status"], canonical(result), time.time(), row["id"], row["revision"]))
                self.store.db.commit()
                return self.view(self.read(row["id"]))
            if action in ("approve", "cancel") and set(args) == {"task_id", "proposal_hash"}:
                row = self.read(args["task_id"])
                if not isinstance(args["proposal_hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", args["proposal_hash"]) or not secrets.compare_digest(row["proposal_hash"], args["proposal_hash"]):
                    raise ValueError("proposal_changed")
                current = snapshot()
                proposal = json.loads(row["proposal"])
                if any(proposal[key] != current[key] for key in ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")):
                    raise ValueError("audience_changed")
                if action == "approve":
                    if row["status"] == "approved":
                        return self.view(row)
                    if row["status"] != "awaiting_approval":
                        raise ValueError("task_state_conflict")
                    status = "approved"
                elif row["status"] in ("awaiting_approval", "approved"):
                    status = "canceled"
                elif row["status"] == "dispatching":
                    status = "cancel_requested"
                else:
                    return self.view(row)
                self.store.db.execute("UPDATE tasks SET status=?,revision=revision+1,updated=? WHERE id=? AND revision=?", (status, time.time(), row["id"], row["revision"]))
                self.store.db.commit()
                return self.view(self.read(row["id"]))
            if action == "claim" and set(args) == {"worker_protocol"} and type(args["worker_protocol"]) is int and args["worker_protocol"] == 2:
                if self.store.db.execute("SELECT 1 FROM tasks WHERE status IN ('dispatching','cancel_requested','needs_reconcile') LIMIT 1").fetchone():
                    return {"task": None, "reason": "busy_or_unreconciled"}
                row = self.store.db.execute("SELECT * FROM tasks WHERE status='approved' ORDER BY created LIMIT 1").fetchone()
                if not row:
                    return {"task": None}
                current = snapshot()
                proposal = json.loads(row["proposal"])
                role = next((item for item in current["gateway"]["roles"] if item["role_id"] == proposal["role_id"]), None)
                if any(proposal[key] != current[key] for key in ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")) or not role or role["configured_model"] != proposal["requested_model"]:
                    self.store.db.execute("UPDATE tasks SET status='needs_reconcile',revision=revision+1,updated=? WHERE id=?", (time.time(), row["id"]))
                    self.store.db.commit()
                    return {"task": None, "reason": "approved_binding_changed"}
                lease = secrets.token_urlsafe(32)
                self.store.db.execute("UPDATE tasks SET status='dispatching',revision=revision+1,updated=?,lease_hash=?,lease_until=? WHERE id=? AND status='approved'", (time.time(), digest(lease.encode()), time.time()+240, row["id"]))
                self.store.db.commit()
                return {"task": self.view(self.read(row["id"])), "lease": lease}
            if action == "finish" and set(args) == {"task_id", "lease", "result"}:
                row = self.read(args["task_id"])
                if not row["lease_hash"] or not secrets.compare_digest(row["lease_hash"], digest(text(args["lease"], 100).encode())):
                    raise ValueError("lease_invalid")
                result = args["result"]
                if isinstance(result, dict) and result.get("status") == "needs_reconcile" and row["run_id"] is not None and result.get("run_id") is None:
                    result = dict(result, run_id=row["run_id"])
                if not isinstance(result, dict) or set(result)-{"status", "run_id", "reply", "requested_model", "actual_model", "error_code"} or result.get("status") not in ("succeeded", "failed", "canceled", "needs_reconcile") or len(canonical(result).encode()) > 48000:
                    raise ValueError("result_invalid")
                if any(value is not None and not isinstance(value, str) for value in result.values()):
                    raise ValueError("result_fields_invalid")
                if row["result"]:
                    if row["result"] != canonical(result):
                        if row["status"] in ("succeeded", "failed", "canceled") and result["status"] == "needs_reconcile":
                            return self.view(row)  # Late ambiguous persistence cannot undo recovery.
                        if row["status"] != "needs_reconcile" or result["status"] == "needs_reconcile":
                            raise ValueError("result_conflict")
                        self.save_recovery(row, {"source": "late_worker_terminal_result", "run_id": result.get("run_id")})
                    else:
                        return self.view(row)
                if row["status"] not in ("dispatching", "cancel_requested", "needs_reconcile"):
                    raise ValueError("task_state_conflict")
                if result["status"] == "succeeded" and (not isinstance(result.get("run_id"), str) or not result["run_id"]):
                    raise ValueError("success_requires_gateway_run_receipt")
                if row["run_id"] is not None and result.get("run_id") != row["run_id"]:
                    raise ValueError("run_binding_mismatch")
                self.store.db.execute("UPDATE tasks SET status=?,result=?,revision=revision+1,updated=?,lease_until=NULL WHERE id=?", (result["status"], canonical(result), time.time(), row["id"]))
                self.store.db.commit()
                return self.view(self.read(row["id"]))
        raise ValueError("operator_action_unsupported")
