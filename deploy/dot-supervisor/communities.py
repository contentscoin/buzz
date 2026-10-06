"""Explicit per-connection consent to registered, freshly owner-verified communities."""
import json
import os
import re
import stat
import time
import uuid
from pathlib import Path
from store import canonical, digest
from tools import snapshot

KEYS = ("owner_pubkey", "relay_origin", "gateway_agent_pubkey")
COMMUNITY = {"type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,39}$", "maxLength": 40,
             "description": "Explicit registered community, e.g. bd or fmg. Omit for legacy BD. Non-default access must be enabled for this original OAuth connection. Never fall back to another community."}
CATALOG = [{"name": "fmg_buzz_list_communities", "description": "Read registered community availability and this connection's access revisions. No access is granted and no task runs. connection_id identifies only your current proposing OAuth connection; it is not a credential. A direct owner may enable a selected community separately.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}}]


def scoped_catalog(items):
    for item in items:
        item["inputSchema"]["properties"]["community_id"] = COMMUNITY
        item["description"] += " community_id selects only that authorized community; omission preserves legacy BD."
    return items


def split(args):
    if not isinstance(args, dict):
        raise ValueError("object_required")
    parameters = dict(args)
    selected = parameters.pop("community_id", None)
    if "community_id" in args and (not isinstance(selected, str) or not re.fullmatch(COMMUNITY["pattern"], selected)):
        raise ValueError("community_id_invalid")
    return parameters, selected


def binding(value):
    return {key: value[key] for key in KEYS}


def scope(value):
    return digest(canonical(binding(value)).encode())


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("canonical_uuid_required")
    return value


def registry():
    path = Path(os.environ.get("FMG_SNAPSHOT", "/snapshot/snapshot.json")).parent / "communities.json"
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("community_registry_invalid")
        raw = file.read(32769)
    if len(raw) > 32768:
        raise ValueError("community_registry_limit")
    value = json.loads(raw)
    rows = value.get("communities")
    if value.get("schema") != 1 or value.get("status") != "ready" or value.get("owner_pubkey") != os.environ["FMG_OWNER_PUBKEY"] or not isinstance(rows, list) or not 1 <= len(rows) <= 5:
        raise ValueError("community_registry_unavailable")
    identifier(value.get("generation"))
    ids, scopes = set(), set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("community_id"), str) or not re.fullmatch(COMMUNITY["pattern"], row["community_id"]) or type(row.get("default")) is not bool or row.get("owner_pubkey") != value["owner_pubkey"] or not re.fullmatch(r"[0-9a-f]{64}", row.get("gateway_agent_pubkey", "")) or not isinstance(row.get("relay_origin"), str) or len(row["relay_origin"]) > 300:
            raise ValueError("community_registry_invalid")
        if row["community_id"] in ids or scope(row) in scopes:
            raise ValueError("community_registry_ambiguous")
        ids.add(row["community_id"])
        scopes.add(scope(row))
    if sum(row["default"] for row in rows) != 1:
        raise ValueError("community_registry_ambiguous")
    return value


def selected(community_id=None):
    if community_id is None:
        current = snapshot()
        if "registry_generation" not in current:
            return dict(current, default_community=True)
        community_id = current.get("community_id")
    registered = registry()
    rows = [row for row in registered["communities"] if row["community_id"] == community_id]
    if len(rows) != 1:
        raise ValueError("community_unavailable")
    row = rows[0]
    current = snapshot(row)
    if current.get("registry_generation") != registered["generation"] or current.get("community_id") != community_id or current.get("default_community") is not row["default"]:
        raise ValueError("community_generation_changed")
    return current


class CommunityAccess:
    def __init__(self, store, resource=None):
        self.store, self.resource = store, resource
        store.db.executescript("""
        CREATE TABLE IF NOT EXISTS dot_community_access (
          scope TEXT NOT NULL, client TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          revision INTEGER NOT NULL CHECK(revision>0), updated REAL NOT NULL, PRIMARY KEY(scope,client));
        CREATE TABLE IF NOT EXISTS dot_community_access_requests (
          scope TEXT NOT NULL, client TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
          receipt TEXT NOT NULL, receipt_hash TEXT NOT NULL, created REAL NOT NULL,
          PRIMARY KEY(scope,client,request_id));
        CREATE TRIGGER IF NOT EXISTS dot_community_requests_no_update BEFORE UPDATE ON dot_community_access_requests BEGIN SELECT RAISE(ABORT,'immutable_access_request'); END;
        CREATE TRIGGER IF NOT EXISTS dot_community_requests_no_delete BEFORE DELETE ON dot_community_access_requests BEGIN SELECT RAISE(ABORT,'immutable_access_request'); END;
        """)

    def grant(self, client, current):
        row = self.store.db.execute("SELECT * FROM dot_community_access WHERE scope=? AND client=?", (scope(current), client)).fetchone()
        return {"enabled": current.get("default_community") is True or bool(row and row["enabled"]),
                "revision": row["revision"] if row else 0}

    def authorize(self, client, current):
        # Legacy snapshots are supported only when they match the default audience.
        fresh = selected(current.get("community_id"))
        if binding(fresh) != binding(current) or fresh["generation"] != current["generation"]:
            raise ValueError("community_generation_changed")
        if not self.grant(client, fresh)["enabled"]:
            raise ValueError("community_access_required")
        return fresh

    def current(self, client, community_id=None):
        return self.authorize(client, selected(community_id))

    def catalog(self, client):
        registered = registry()
        entries = []
        for row in registered["communities"]:
            try:
                current = selected(row["community_id"])
                access = self.grant(client, current)
                entry = {"community_id": row["community_id"], "default": row["default"], "status": "ready",
                         "relay_origin": row["relay_origin"], "observed_at": current["observed_at"], **access}
                if not row["default"]:
                    request = str(uuid.uuid4())
                    entry["allow_command"] = f'/fmg_dot allow {client} {row["community_id"]} {access["revision"]} {request}'
                    entry["revoke_command"] = f'/fmg_dot revoke {client} {row["community_id"]} {access["revision"]} {request}'
                entries.append(entry)
            except (ValueError, KeyError, TypeError, OSError):
                entries.append({"community_id": row["community_id"], "default": row["default"], "status": "unavailable", "enabled": False})
        if registry()["generation"] != registered["generation"]:
            raise ValueError("community_generation_changed")
        return {"connection_id": client, "communities": entries, "default_preserved": True,
                "execution_performed": False, "document_grants_inherited": False}

    def operator(self, data):
        action, args = data.get("action"), data.get("arguments")
        changing = action == "communities.set"
        extras = {"connection_id", "community_id"} | ({"enabled", "expected_revision", "request_id"} if changing else set())
        if action not in ("communities.get", "communities.set") or set(data) != {"action", "arguments"} or not isinstance(args, dict) or set(args) != set(KEYS) | extras:
            raise ValueError("community_access_request_invalid")
        client = identifier(args["connection_id"])
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                current = selected(args["community_id"])
                if binding(current) != binding(args) or current["default_community"] is True:
                    raise ValueError("community_access_request_invalid")
                if not self.resource or not self.store.db.execute("SELECT 1 FROM tokens WHERE client_id=? AND scope='buzz:tasks' AND resource=? AND kind IN ('access','refresh') AND expires>? LIMIT 1", (client, self.resource, time.time())).fetchone():
                    raise ValueError("connection_unavailable")
                access = self.grant(client, current)
                result = {"connection_id": client, "community_id": args["community_id"], "audience": binding(current), **access}
                if changing:
                    request = identifier(args["request_id"])
                    if type(args["enabled"]) is not bool or type(args["expected_revision"]) is not int or not 0 <= args["expected_revision"] <= 2147483646:
                        raise ValueError("community_access_request_invalid")
                    encoded = canonical(args)
                    old = self.store.db.execute("SELECT * FROM dot_community_access_requests WHERE scope=? AND client=? AND request_id=?", (scope(current), client, request)).fetchone()
                    if old:
                        if old["input_hash"] != digest(encoded.encode()) or old["receipt_hash"] != digest(old["receipt"].encode()):
                            raise ValueError("community_request_conflict")
                        receipt, replayed = json.loads(old["receipt"]), True
                    else:
                        if access["revision"] != args["expected_revision"]:
                            raise ValueError("community_access_revision_conflict")
                        if self.store.db.execute("SELECT COUNT(*) FROM dot_community_access_requests").fetchone()[0] >= 10000:
                            raise ValueError("community_access_capacity")
                        revision, now = access["revision"] + 1, time.time()
                        receipt = {"connection_id": client, "community_id": args["community_id"], "request_id": request,
                                   "enabled": args["enabled"], "revision": revision, "audience": binding(current), "recorded_at": now}
                        self.store.db.execute("INSERT INTO dot_community_access VALUES(?,?,?,?,?) ON CONFLICT(scope,client) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated=excluded.updated", (scope(current), client, int(args["enabled"]), revision, now))
                        self.store.db.execute("INSERT INTO dot_community_access_requests VALUES(?,?,?,?,?,?,?)", (scope(current), client, request, digest(encoded.encode()), canonical(receipt), digest(canonical(receipt).encode()), now))
                        replayed = False
                    result.update(self.grant(client, current), receipt=receipt, replayed=replayed)
                final = selected(args["community_id"])
                if final["generation"] != current["generation"] or binding(final) != binding(current):
                    raise ValueError("community_generation_changed")
                self.store.db.commit()
                return result
            except BaseException:
                self.store.db.rollback()
                raise
