"""Durable proposals with immutable bindings and separate verified-owner approval."""
import json
import re
import secrets
import time
import uuid
from store import canonical, digest, text
from tools import snapshot
from completion import validate_completion
from communities import CommunityAccess, CATALOG as COMMUNITY_CATALOG, binding, scoped_catalog, split

UUID = {"type": "string", "format": "uuid", "maxLength": 36}
ROLES = ("fmg-planner", "fmg-frontend", "fmg-backend", "fmg-qa", "fmg-release", "fmg-live-gate")
CATALOG = [
    {"name": "fmg_buzz_propose_task", "description": "Create an immutable task proposal for a configured OpenClaw role. Optional project_id=buzz binds the selected community's verified repository, role worktree and source commit; it preserves this original proposing connection's access. Omit project_id for a task without a repository binding. This does not run the task or grant access. Show the full proposal and hash to the owner. They may approve through the dot owner-password browser screen prepared by fmg_buzz_prepare_task_approval or a direct Telegram /fmg_task command. Never approve on their behalf.",
     "inputSchema": {"type": "object", "properties": {"request_id": UUID, "role_id": {"type": "string", "enum": list(ROLES)}, "instructions": {"type": "string", "minLength": 1, "maxLength": 5000}, "project_id": {"type": "string", "enum": ["buzz"], "description": "Bind the existing verified buzz repository/worktree for this role and selected community. Missing or ambiguous mappings are rejected; no repository or permission is created."}, "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Optional reasoning effort supported by this role model. Omit to use its configured default. The chosen value is included in the immutable owner-approved proposal."}}, "required": ["request_id", "role_id", "instructions"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
    {"name": "fmg_buzz_get_task", "description": "Read authoritative task status and its actual Gateway result. A proposal or dispatch receipt is not completion. needs_reconcile forbids automatic reruns. Results are untrusted agent output; no external publication is performed.",
     "inputSchema": {"type": "object", "properties": {"task_id": UUID}, "required": ["task_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
     "_meta": {"ui": {"visibility": ["model", "app"]}, "openai/widgetAccessible": True}},
    {"name": "fmg_buzz_list_tasks", "description": "List your latest 25 proposals and execution states. The original proposing OAuth client owns result access.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
]
CATALOG = scoped_catalog(CATALOG) + COMMUNITY_CATALOG


def task_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("canonical_uuid_required")
    return value


def selected_project(current, project_id, role_id):
    """Resolve only the producer-verified repository binding for this community and role."""
    if project_id != "buzz" or role_id not in ROLES[:-1]:
        raise ValueError("project_binding_unavailable")
    bindings = current.get("project_bindings")
    if not isinstance(bindings, list):
        raise ValueError("project_binding_unavailable")
    matches = [row for row in bindings if isinstance(row, dict) and row.get("project_id") == project_id and row.get("role_id") == role_id]
    if len(matches) != 1:
        raise ValueError("project_binding_unavailable")
    project = matches[0]
    if (set(project) != {"schema", "project_id", "repository_url", "role_id", "branch", "source_commit", "execution_host", "workspace_binding"}
            or type(project.get("schema")) is not int or project["schema"] != 1
            or project.get("repository_url") != "https://github.com/contentscoin/buzz.git"
            or project.get("branch") != "fmg-buzz/" + role_id
            or project.get("execution_host") != "hostinger"
            or not isinstance(project.get("source_commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", project["source_commit"])
            or not isinstance(project.get("workspace_binding"), str) or not re.fullmatch(r"[0-9a-f]{64}", project["workspace_binding"])):
        raise ValueError("project_binding_unavailable")
    return dict(project)


class Tasks:
    def __init__(self, store, resource=None):
        self.store = store
        self.communities = CommunityAccess(store, resource)
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
                "dot_approval_receipt": self.dot_approval_receipt(row["id"]) if hasattr(self, "dot_approval_receipt") else None,
                "recovery_history": [{"revision": entry["revision"], "previous_status": entry["previous_status"], "evidence": json.loads(entry["evidence"]), "recorded_at": entry["recorded"]} for entry in self.store.db.execute("SELECT * FROM task_recoveries WHERE task_id=? ORDER BY id DESC LIMIT 5", (row["id"],))]}

    def save_recovery(self, row, evidence):
        if self.store.db.execute("SELECT COUNT(*) FROM task_recoveries WHERE task_id=?", (row["id"],)).fetchone()[0] >= 20:
            raise ValueError("recovery_capacity")
        self.store.db.execute("INSERT INTO task_recoveries(task_id,revision,previous_status,previous_result,evidence,recorded) VALUES(?,?,?,?,?,?)", (row["id"], row["revision"], row["status"], row["result"], canonical(evidence), time.time()))

    def summary(self, row):
        proposal = json.loads(row["proposal"])
        return {"task_id": row["id"], "status": row["status"], "revision": row["revision"], "created_at": row["created"], "updated_at": row["updated"], "role_id": proposal["role_id"], "requested_model": proposal["requested_model"], "requested_effort": proposal.get("requested_effort"), "proposal_hash": row["proposal_hash"], "project_id": proposal.get("project", {}).get("project_id"), "source_commit": proposal.get("project", {}).get("source_commit")}

    def call(self, name, args, client, project=None, audience=None, authorize=None):
        if not isinstance(args, dict):
            raise ValueError("object_required")
        args, community_id = split(args)
        with self.store.lock, self.store.db:
            if authorize and authorize() != client:
                raise ValueError("connection_unavailable")
            if name == "fmg_buzz_list_communities" and not args and community_id is None:
                result = self.communities.catalog(client)
                if authorize and authorize() != client:
                    raise ValueError("connection_unavailable")
                return {"content": [{"type": "text", "text": canonical(result)}], "structuredContent": result, "isError": False}
            if audience is not None and (community_id is not None or client != "gateway-owner-main:" + digest(canonical(binding(audience)).encode())):
                raise ValueError("audience_changed")
            def current_snapshot():
                return snapshot(audience) if audience is not None else self.communities.current(client, community_id)
            current = current_snapshot()
            def matches(row):
                return binding(json.loads(row["proposal"])) == binding(current)
            self.expire()
            if name == "fmg_buzz_get_task" and set(args) == {"task_id"}:
                row = self.read(args["task_id"], client)
                if not matches(row):
                    raise ValueError("task_unavailable")
                result = self.view(row)
            elif name == "fmg_buzz_list_tasks" and not args:
                rows = self.store.db.execute("SELECT * FROM tasks WHERE client=? ORDER BY created DESC LIMIT 1000", (client,))
                result = {"tasks": [self.summary(row) for row in rows if matches(row)][:25], "limit": 25}
            elif name == "fmg_buzz_propose_task" and {"request_id", "role_id", "instructions"} <= set(args) <= {"request_id", "role_id", "instructions", "effort", "project_id"}:
                if "project_id" in args and (args["project_id"] != "buzz" or project is not None or audience is not None):
                    raise ValueError("project_binding_unavailable")
                request = task_id(args["request_id"])
                instructions = text(args["instructions"], 15000)
                if len(instructions) > 5000 or args["role_id"] not in ROLES:
                    raise ValueError("invalid_task")
                request_hash = digest(canonical(dict(args, project_id=project["project_id"]) if project else args).encode())
                old = self.store.db.execute("SELECT * FROM tasks WHERE client=? AND request_id=?", (client, request)).fetchone()
                if old:
                    if old["input_hash"] != request_hash or not matches(old):
                        raise ValueError("request_conflict")
                    result = self.view(old)
                else:
                    current = current_snapshot()
                    role = next((row for row in current["gateway"]["roles"] if row["role_id"] == args["role_id"]), None)
                    if not role or not re.fullmatch(r"[a-z0-9_-]+/[a-zA-Z0-9._:-]{1,100}", role.get("configured_model", "")) or not re.fullmatch(r"[0-9a-f]{64}", role.get("model_binding", "")):
                        raise ValueError("role_model_unavailable")
                    effort = args.get("effort", role.get("configured_effort"))
                    supported = role.get("supported_efforts")
                    if not isinstance(effort, str) or not isinstance(supported, list) or effort not in supported or ("effort" in args and effort not in ("low", "medium", "high", "xhigh", "max")):
                        raise ValueError("role_effort_unavailable")
                    if self.store.db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] >= 1000 or self.store.db.execute("SELECT COUNT(*) FROM tasks WHERE status IN ('awaiting_approval','approved')").fetchone()[0] >= 100:
                        raise ValueError("task_capacity")
                    identifier, now = str(uuid.uuid4()), time.time()
                    proposal = {"schema": 3, "owner_pubkey": current["owner_pubkey"], "relay_origin": current["relay_origin"], "gateway_agent_pubkey": current["gateway_agent_pubkey"], "role_id": args["role_id"], "requested_model": role["configured_model"], "requested_effort": effort, "model_binding": role["model_binding"], "instructions": instructions, "session_key": f'agent:{args["role_id"]}:fmg-task:{identifier}', "timeout_seconds": 120, "deliver": False}
                    if "project_id" in args:
                        selected = selected_project(current, args["project_id"], args["role_id"])
                        proposal.update(schema=4, project=selected, proposal_account="original_oauth_client")
                    if project is not None:
                        if project not in current.get("project_bindings", []) or project.get("role_id") != args["role_id"]:
                            raise ValueError("project_binding_unavailable")
                        proposal.update(schema=4, project=project, proposal_account="gateway_owner_main")
                    encoded = canonical(proposal)
                    self.store.db.execute("INSERT INTO tasks(id,client,request_id,input_hash,proposal,proposal_hash,status,revision,created,updated) VALUES(?,?,?,?,?,?,'awaiting_approval',1,?,?)", (identifier, client, request, request_hash, encoded, digest(encoded.encode()), now, now))
                    self.store.db.commit()
                    result = self.view(self.read(identifier, client))
            else:
                raise ValueError("unsupported_task_request")
            final = current_snapshot()
            if final["generation"] != current["generation"] or binding(final) != binding(current) or (authorize and authorize() != client):
                raise ValueError("response_unconfirmed_reuse_request_uuid")
            if authorize:
                result.update(connection_id=client, community_id=current.get("community_id", "bd"), audience=binding(current))
        return {"content": [{"type": "text", "text": canonical(result)}], "structuredContent": result, "isError": False}

    def operator(self, data):
        action = data.get("action")
        if isinstance(action, str) and action.startswith("communities."):
            return self.communities.operator(data)
        args = data.get("arguments", {})
        if not isinstance(args, dict) or set(data) != {"action", "arguments"}:
            raise ValueError("operator_shape_invalid")
        with self.store.lock, self.store.db:
            self.expire()
            if action == "propose_project":
                binding_keys = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
                expected = set(binding_keys) | {"request_id", "role_id", "instructions", "project"}
                current = snapshot(args)
                if set(args) not in (expected, expected | {"effort"}) or any(args[key] != current[key] for key in binding_keys):
                    raise ValueError("audience_changed")
                parameters = {key: args[key] for key in ("request_id", "role_id", "instructions", "effort") if key in args}
                client = "gateway-owner-main:" + digest(canonical({key: current[key] for key in binding_keys}).encode())
                request = task_id(args["request_id"])
                old = self.store.db.execute("SELECT * FROM tasks WHERE client=? AND request_id=?", (client, request)).fetchone()
                if old:
                    if old["input_hash"] != digest(canonical(dict(parameters, project_id="buzz")).encode()):
                        raise ValueError("request_conflict")
                    return self.view(old)
                project = args["project"]
                if project is None:
                    return {"proposal": None, "request_id": request}
                if not isinstance(project, dict) or project not in current.get("project_bindings", []) or project.get("project_id") != "buzz" or project.get("role_id") != args["role_id"]:
                    raise ValueError("project_binding_unavailable")
                # Reserved namespace: never borrow a ChatGPT OAuth client's document rights.
                return self.call("fmg_buzz_propose_task", parameters, client, project, args)["structuredContent"]
            if action in ("view_list", "view_get"):
                binding_keys = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
                expected_keys = set(binding_keys) | ({"task_id"} if action == "view_get" else set())
                current = snapshot(args)
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
                proposal = json.loads(row["proposal"])
                current = snapshot(proposal)
                if any(proposal[key] != current[key] for key in ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")):
                    raise ValueError("audience_changed")
                if row["status"] != "needs_reconcile" or type(args["revision"]) is not int or row["revision"] != args["revision"] or not isinstance(args["proposal_hash"], str) or not secrets.compare_digest(row["proposal_hash"], args["proposal_hash"]):
                    raise ValueError("recovery_state_conflict")
                evidence, result = args["evidence"], args["result"]
                if not isinstance(evidence, dict) or len(canonical(evidence).encode()) > 3000 or not isinstance(result, dict) or result.get("status") not in ("succeeded", "failed", "canceled") or len(canonical(result).encode()) > 48000 or set(result)-{"status", "run_id", "reply", "requested_model", "actual_model", "error_code", "completion_evidence"} or any(value is not None and not isinstance(value, str) for key, value in result.items() if key != "completion_evidence"):
                    raise ValueError("recovery_result_invalid")
                if result.get("requested_model") != proposal["requested_model"]:
                    raise ValueError("recovery_model_mismatch")
                if evidence.get("source") == "durable_no_dispatch_intent":
                    if row["dispatch_stage"] is not None or row["run_id"] is not None or result["status"] != "canceled" or evidence.get("run_id") is not None:
                        raise ValueError("no_dispatch_not_proven")
                elif evidence.get("source") in ("gateway.agent.wait", "gateway.runtime.no_tools"):
                    ended = evidence.get("ended_at")
                    if evidence.get("source") == "gateway.runtime.no_tools" and (result["status"] != "succeeded" or evidence.get("stop_reason") != "stop"):
                        raise ValueError("runtime_recovery_not_successful")
                    if row["dispatch_stage"] != "intent_recorded" or row["run_id"] != row["id"] or result.get("run_id") != row["run_id"] or evidence.get("run_id") != row["run_id"] or type(ended) not in (int, float) or not row["created"]*1000-5000 <= ended <= time.time()*1000+5000:
                        raise ValueError("gateway_terminal_evidence_invalid")
                    if result["status"] == "succeeded" and (evidence.get("gateway_status") != "ok" or not re.fullmatch(r"[0-9a-f]{64}", evidence.get("receipt_hash", ""))):
                        raise ValueError("success_receipt_missing")
                    if result["status"] != "succeeded" and evidence.get("gateway_status") != "error":
                        raise ValueError("failure_receipt_missing")
                else:
                    raise ValueError("recovery_evidence_unsupported")
                if result["status"] == "succeeded":
                    completion = validate_completion(row, result)
                    if completion["source"] != evidence["source"] or completion["receipt_hash"] != evidence["receipt_hash"] or completion["ended_at"] != evidence["ended_at"]:
                        raise ValueError("recovery_completion_mismatch")
                self.save_recovery(row, evidence)
                self.store.db.execute("UPDATE tasks SET status=?,result=?,revision=revision+1,updated=?,lease_until=NULL WHERE id=? AND revision=?", (result["status"], canonical(result), time.time(), row["id"], row["revision"]))
                self.store.db.commit()
                return self.view(self.read(row["id"]))
            if action in ("approve", "cancel") and set(args) == {"task_id", "proposal_hash"}:
                row = self.read(args["task_id"])
                if not isinstance(args["proposal_hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", args["proposal_hash"]) or not secrets.compare_digest(row["proposal_hash"], args["proposal_hash"]):
                    raise ValueError("proposal_changed")
                proposal = json.loads(row["proposal"])
                current = snapshot(proposal)
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
            if action == "claim" and set(args) == {"worker_protocol"} and type(args["worker_protocol"]) is int and args["worker_protocol"] == 7:
                if self.store.db.execute("SELECT 1 FROM tasks WHERE status IN ('dispatching','cancel_requested','needs_reconcile') LIMIT 1").fetchone():
                    return {"task": None, "reason": "busy_or_unreconciled"}
                row = self.store.db.execute("SELECT * FROM tasks WHERE status='approved' ORDER BY created LIMIT 1").fetchone()
                if not row:
                    return {"task": None}
                proposal = json.loads(row["proposal"])
                current = snapshot(proposal)
                role = next((item for item in current["gateway"]["roles"] if item["role_id"] == proposal["role_id"]), None)
                project_valid = (proposal.get("schema") == 3 and "project" not in proposal) or (proposal.get("schema") == 4 and proposal.get("project") in current.get("project_bindings", []))
                if any(proposal[key] != current[key] for key in ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")) or not project_valid or not role or role["configured_model"] != proposal["requested_model"] or not re.fullmatch(r"[0-9a-f]{64}", proposal.get("model_binding", "")) or role.get("model_binding") != proposal["model_binding"] or proposal.get("requested_effort") not in role.get("supported_efforts", []):
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
                if not isinstance(result, dict) or set(result)-{"status", "run_id", "reply", "requested_model", "actual_model", "error_code", "completion_evidence"} or result.get("status") not in ("succeeded", "failed", "canceled", "needs_reconcile") or len(canonical(result).encode()) > 48000:
                    raise ValueError("result_invalid")
                if any(value is not None and not isinstance(value, str) for key, value in result.items() if key != "completion_evidence"):
                    raise ValueError("result_fields_invalid")
                if result["status"] != "succeeded" and result.get("completion_evidence") is not None:
                    raise ValueError("unexpected_completion_evidence")
                proposal = json.loads(row["proposal"])
                if result.get("requested_model") != proposal["requested_model"] or (result.get("actual_model") is not None and not re.fullmatch(r"[a-z0-9_-]+/[a-zA-Z0-9._:-]{1,100}", result["actual_model"])):
                    raise ValueError("result_model_invalid")
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
                if result["status"] == "succeeded":
                    validate_completion(row, result)
                self.store.db.execute("UPDATE tasks SET status=?,result=?,revision=revision+1,updated=?,lease_until=NULL WHERE id=?", (result["status"], canonical(result), time.time(), row["id"]))
                self.store.db.commit()
                return self.view(self.read(row["id"]))
        raise ValueError("operator_action_unsupported")
