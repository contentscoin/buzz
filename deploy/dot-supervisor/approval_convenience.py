"""Scoped browser sign-in and explicit, atomic review of a bounded task group."""
import hmac
import json
import re
import secrets
import time
from store import canonical, digest
from communities import binding

OWNER_SESSION_SECONDS = 1800
BATCH_LIMIT = 10


class ApprovalConvenience:
    def init_convenience(self):
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS dot_owner_sessions (
          hash TEXT PRIMARY KEY, client TEXT NOT NULL, oauth_family TEXT NOT NULL,
          community_id TEXT NOT NULL, audience TEXT NOT NULL, password_epoch TEXT NOT NULL,
          expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS dot_approval_batches (
          id TEXT PRIMARY KEY, selection TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS dot_batch_no_update BEFORE UPDATE ON dot_approval_batches
          BEGIN SELECT RAISE(ABORT,'immutable_batch_receipt'); END;
        CREATE TRIGGER IF NOT EXISTS dot_batch_no_delete BEFORE DELETE ON dot_approval_batches
          BEGIN SELECT RAISE(ABORT,'immutable_batch_receipt'); END;
        """)

    def same_scope(self, first, second):
        return all(first[key] == second[key] for key in
                   ("client", "oauth_family", "community_id", "audience"))

    def remember_session(self, row):
        now = time.time()
        self.store.db.execute("DELETE FROM dot_owner_sessions WHERE expires<=?", (now,))
        if self.store.db.execute("SELECT COUNT(*) FROM dot_owner_sessions").fetchone()[0] >= 2000:
            raise self.error("approval_capacity")
        if self.store.db.execute("SELECT COUNT(*) FROM dot_owner_sessions WHERE client=?", (row["client"],)).fetchone()[0] >= 20:
            raise self.error("approval_capacity")
        session = secrets.token_urlsafe(32)
        self.store.db.execute("INSERT INTO dot_owner_sessions VALUES(?,?,?,?,?,?,?)",
                              (digest(session.encode()), row["client"], row["oauth_family"],
                               row["community_id"], row["audience"], digest(self.oauth.owner_hash.encode()),
                               now + OWNER_SESSION_SECONDS))
        return session

    def remembered(self, row, session):
        stored = self.store.db.execute("SELECT * FROM dot_owner_sessions WHERE hash=? AND expires>?",
                                       (digest(session.encode()), time.time())).fetchone()
        return bool(stored and self.same_scope(row, stored) and
                    secrets.compare_digest(stored["password_epoch"], digest(self.oauth.owner_hash.encode())))

    def logout(self, token, session, csrf):
        with self.store.lock, self.store.db:
            row = self.lookup(token)
            if not self.session(row, session) or not isinstance(csrf, str) or not secrets.compare_digest(csrf, self.csrf(token, session)):
                raise self.error("owner_confirmation_required")
            self.store.db.execute("DELETE FROM dot_owner_sessions WHERE hash=?", (digest(session.encode()),))
            self.store.db.execute("DELETE FROM dot_approval_sessions WHERE hash=?", (digest(session.encode()),))

    def pending_batch(self, anchor, session):
        if not self.session(anchor, session):
            raise self.error("owner_confirmation_required")
        self.current(anchor, pending=not anchor["receipt"])
        candidates = self.store.db.execute(
            "SELECT * FROM dot_task_approvals WHERE client=? AND oauth_family=? AND community_id=? "
            "AND audience=? AND receipt IS NULL AND expires>? ORDER BY created DESC,id LIMIT 21",
            (anchor["client"], anchor["oauth_family"], anchor["community_id"], anchor["audience"], time.time())).fetchall()
        rows, unavailable, seen = [], [], set()
        for row in candidates:
            if row["task_id"] in seen:
                continue
            seen.add(row["task_id"])
            try:
                self.current(row)
                if len(rows) < BATCH_LIMIT:
                    rows.append(row)
                else:
                    unavailable.append({"task_id": row["task_id"], "reason": "batch_limit"})
            except (ValueError, KeyError, TypeError, OSError) as error:
                unavailable.append({"task_id": row["task_id"], "reason": str(error)})
        return rows, unavailable

    def selection(self, rows):
        return canonical([[row["id"], row["task_id"], row["revision"], row["proposal_hash"]] for row in rows])

    def batch_csrf(self, token, session, selection):
        return hmac.new(self.secret, canonical(["dot-owner-batch-v1", token, session, selection]).encode(), "sha256").hexdigest()

    def approve_batch(self, token, session, selection, csrf):
        with self.store.lock, self.store.db:
            anchor = self.lookup(token)
            if not self.session(anchor, session) or not isinstance(selection, str) or len(selection.encode()) > 3000 or not isinstance(csrf, str) or not secrets.compare_digest(csrf, self.batch_csrf(token, session, selection)):
                raise self.error("owner_confirmation_required")
            try:
                selected = json.loads(selection)
            except (ValueError, TypeError):
                raise self.error("approval_request_invalid") from None
            if not isinstance(selected, list) or not 1 <= len(selected) <= BATCH_LIMIT:
                raise self.error("approval_request_invalid")
            rows, seen = [], set()
            for item in selected:
                if not isinstance(item, list) or len(item) != 4 or not isinstance(item[0], str) or not re.fullmatch(r"[0-9a-f-]{36}", item[0]):
                    raise self.error("approval_request_invalid")
                row = self.store.db.execute("SELECT * FROM dot_task_approvals WHERE id=?", (item[0],)).fetchone()
                if not row or not self.same_scope(anchor, row) or row["task_id"] in seen:
                    raise self.error("approval_binding_changed")
                seen.add(row["task_id"])
                rows.append(row)
            if selection != self.selection(rows):
                raise self.error("approval_binding_changed")
            identifier = digest(canonical(["dot-owner-batch-v1", anchor["id"], digest(session.encode()), selection]).encode())
            previous = self.store.db.execute("SELECT * FROM dot_approval_batches WHERE id=?", (identifier,)).fetchone()
            if previous:
                for row in rows:
                    self.current(row, pending=False)
                receipt = json.loads(previous["receipt"])
                if previous["selection"] != selection or [json.loads(row["receipt"]) for row in rows] != receipt["receipts"]:
                    raise self.error("approval_binding_changed")
                return receipt
            if self.store.db.execute("SELECT COUNT(*) FROM dot_approval_batches").fetchone()[0] >= 10000:
                raise self.error("approval_capacity")
            checked = [self.current(row) for row in rows]
            final = self.tasks.communities.current(anchor["client"], anchor["community_id"])
            if any(current["generation"] != final["generation"] or binding(current) != binding(final) for _, current in checked):
                raise self.error("approval_binding_changed")
            now = time.time()
            receipts = [self.commit_approval(row, task, current, now) for row, (task, current) in zip(rows, checked)]
            receipt = {"schema": 1, "batch_id": identifier, "approved_at": now,
                       "source": "chatgpt_dot_owner_password_browser", "receipts": receipts}
            receipt["receipt_hash"] = digest(canonical(receipt).encode())
            self.store.db.execute("INSERT INTO dot_approval_batches VALUES(?,?,?)", (identifier, selection, canonical(receipt)))
            return receipt
