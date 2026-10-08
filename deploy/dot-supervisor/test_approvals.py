"""Production approval seams with isolated SQLite/OAuth; never use live credentials or models."""
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import uuid
from approval_pages import ApprovalPages
from approvals import Approvals, ApprovalError
from auth import OAuth
from store import Ledger, canonical, digest
from tasks import Tasks


class FixtureOAuth(OAuth):
    scope = "buzz:tasks"


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Ledger(Path(self.directory.name))
        self.addCleanup(lambda: self.store.db.close())
        self.password = "isolated-fixture-password"
        salt = bytes.fromhex("ab"*16)
        owner_hash = salt.hex()+":"+hashlib.scrypt(self.password.encode(), salt=salt, n=16384, r=8, p=1).hex()
        self.oauth = FixtureOAuth(self.store, "https://fixture.invalid/tasks", owner_hash)
        self.client = str(uuid.uuid4())
        self.header = "Bearer "+self.oauth.issue(self.client, self.oauth.resource)["access_token"]
        self.tasks = Tasks(self.store, self.oauth.resource)
        self.approvals = Approvals(self.tasks, self.oauth, "isolated-operator-secret-"*3)
        self.snapshot = {"owner_pubkey": "a"*64, "relay_origin": "https://fixture.invalid",
                         "gateway_agent_pubkey": "b"*64, "generation": str(uuid.uuid4()),
                         "community_id": "bd", "project_bindings": [],
                         "gateway": {"roles": [{"role_id": "fmg-backend", "configured_model": "openai/gpt-6.1-sol",
                         "configured_effort": "medium", "supported_efforts": ["low", "medium", "high"], "model_binding": "c"*64}]}}
        self.allowed = True
        self.addCleanup(patch.stopall)
        patch.object(self.tasks.communities, "current", side_effect=self.current).start()
        patch("tasks.snapshot", side_effect=lambda *_: copy.deepcopy(self.snapshot)).start()
        self.task = self.tasks.call("fmg_buzz_propose_task", {"request_id": str(uuid.uuid4()),
                                   "role_id": "fmg-backend", "instructions": "<script>untrusted fixture</script> 답변만 작성하세요."},
                                   self.client, authorize=self.authorize)["structuredContent"]
        self.args = {"task_id": self.task["task_id"], "request_id": str(uuid.uuid4()),
                     "proposal_hash": self.task["proposal_hash"], "revision": self.task["revision"]}

    def current(self, client, community=None):
        if not self.allowed or community not in (None, "bd"):
            raise ValueError("community_access_required")
        return copy.deepcopy(self.snapshot)

    def authorize(self):
        return self.oauth.bearer(self.header)

    def prepare(self, args=None):
        return self.approvals.prepare(args or self.args, self.client, self.header, self.authorize)["structuredContent"]

    def browser(self):
        result = self.prepare()
        token = parse_qs(urlsplit(result["approval"]["url"]).query)["token"][0]
        row = self.approvals.lookup(token)
        session = self.approvals.authenticate(row, self.password, "fixture-peer")
        return token, session, self.approvals.csrf(token, session)

    def count(self, table):
        return self.store.db.execute("SELECT COUNT(*) FROM "+table).fetchone()[0]

    def test_prepare_never_approves_and_replay_keeps_screen(self):
        first, second = self.prepare(), self.prepare()
        self.assertEqual(first["approval"]["url"], second["approval"]["url"])
        self.assertFalse(first["execution_approval_performed"])
        self.assertEqual(self.tasks.read(self.task["task_id"])["status"], "awaiting_approval")
        self.assertEqual(self.count("dot_task_approvals"), 1)
        self.assertEqual(self.count("dot_approval_sessions"), 0)

    def test_reused_uuid_changed_revision_is_conflict(self):
        self.prepare()
        with self.assertRaisesRegex(ApprovalError, "request_conflict"):
            self.prepare(dict(self.args, revision=2))

    def test_wrong_hash_and_revision_cannot_prepare(self):
        for changed, error in (({"proposal_hash": "d"*64}, "approval_binding_changed"), ({"revision": 2}, "approval_state_conflict")):
            with self.subTest(changed=changed), self.assertRaisesRegex(ApprovalError, error):
                self.prepare(dict(self.args, **changed))
        self.assertEqual(self.count("dot_task_approvals"), 0)

    def test_other_proposing_client_denied(self):
        client = str(uuid.uuid4())
        header = "Bearer "+self.oauth.issue(client, self.oauth.resource)["access_token"]
        with self.assertRaisesRegex(ValueError, "task_unavailable"):
            self.approvals.prepare(self.args, client, header, lambda: self.oauth.bearer(header))
        self.assertEqual(self.count("dot_task_approvals"), 0)

    def test_no_browser_session_or_wrong_csrf_denied(self):
        token, session, csrf = self.browser()
        for candidate, proof in (("", csrf), (session, "0"*64)):
            with self.subTest(candidate=bool(candidate)), self.assertRaisesRegex(ApprovalError, "owner_confirmation_required"):
                self.approvals.approve(token, candidate, proof)
        self.assertEqual(self.tasks.read(self.task["task_id"])["revision"], 1)

    def test_password_failures_are_durable_and_bounded(self):
        token = parse_qs(urlsplit(self.prepare()["approval"]["url"]).query)["token"][0]
        row = self.approvals.lookup(token)
        for _ in range(5):
            with self.assertRaisesRegex(ApprovalError, "owner_authentication_failed"):
                self.approvals.authenticate(row, "wrong", "fixture-peer")
        with self.assertRaisesRegex(ApprovalError, "approval_password_rate_limit"):
            self.approvals.authenticate(row, self.password, "fixture-peer")
        self.assertEqual(self.count("dot_approval_sessions"), 0)

    def test_commit_is_atomic_and_lost_response_replays_receipt(self):
        token, session, csrf = self.browser()
        first = self.approvals.approve(token, session, csrf)
        self.assertEqual(self.approvals.approve(token, session, csrf), first)
        task = self.tasks.read(self.task["task_id"])
        self.assertEqual((task["status"], task["revision"]), ("approved", 2))
        self.assertEqual(self.tasks.view(task)["dot_approval_receipt"], first)
        payload = dict(first)
        receipt_hash = payload.pop("receipt_hash")
        self.assertEqual(receipt_hash, digest(canonical(payload).encode()))
        self.assertEqual(self.count("dot_task_approvals"), 1)

    def test_two_concurrent_browser_posts_commit_once(self):
        token, session, csrf = self.browser()
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(lambda _: self.approvals.approve(token, session, csrf), range(2)))
        self.assertEqual(receipts[0], receipts[1])
        self.assertEqual(self.tasks.read(self.task["task_id"])["revision"], 2)

    def test_telegram_approval_wins_without_duplicate_browser_approval(self):
        token, session, csrf = self.browser()
        self.tasks.operator({"action": "approve", "arguments": {"task_id": self.task["task_id"], "proposal_hash": self.task["proposal_hash"]}})
        with self.assertRaisesRegex(ApprovalError, "approval_state_conflict"):
            self.approvals.approve(token, session, csrf)
        self.assertIsNone(self.approvals.lookup(token)["receipt"])

    def test_cancel_before_browser_approval_wins(self):
        token, session, csrf = self.browser()
        self.tasks.operator({"action": "cancel", "arguments": {"task_id": self.task["task_id"], "proposal_hash": self.task["proposal_hash"]}})
        with self.assertRaisesRegex(ApprovalError, "approval_state_conflict"):
            self.approvals.approve(token, session, csrf)
        self.assertEqual(self.tasks.read(self.task["task_id"])["status"], "canceled")

    def test_revoked_connection_or_community_cannot_approve(self):
        token, session, csrf = self.browser()
        self.allowed = False
        with self.assertRaisesRegex(ValueError, "community_access_required"):
            self.approvals.approve(token, session, csrf)
        self.allowed = True
        self.store.db.execute("DELETE FROM tokens WHERE client_id=?", (self.client,))
        self.store.db.commit()
        with self.assertRaisesRegex(ApprovalError, "connection_unavailable"):
            self.approvals.approve(token, session, csrf)

    def test_changed_model_binding_or_gateway_denied(self):
        token, session, csrf = self.browser()
        self.snapshot["gateway"]["roles"][0]["model_binding"] = "e"*64
        with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
            self.approvals.approve(token, session, csrf)
        self.snapshot["gateway"]["roles"][0]["model_binding"] = "c"*64
        self.snapshot["gateway_agent_pubkey"] = "f"*64
        with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
            self.approvals.approve(token, session, csrf)

    def test_expired_browser_session_denied(self):
        token, session, csrf = self.browser()
        self.store.db.execute("UPDATE dot_approval_sessions SET expires=?", (time.time()-1,))
        self.store.db.commit()
        with self.assertRaisesRegex(ApprovalError, "owner_confirmation_required"):
            self.approvals.approve(token, session, csrf)

    def test_receipt_rollback_does_not_leave_approved_task(self):
        token, session, csrf = self.browser()
        self.store.db.executescript("CREATE TRIGGER fixture_fail_receipt BEFORE UPDATE OF receipt ON dot_task_approvals BEGIN SELECT RAISE(ABORT,'fixture_disk_failure'); END;")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture_disk_failure"):
            self.approvals.approve(token, session, csrf)
        self.assertEqual(self.tasks.read(self.task["task_id"])["status"], "awaiting_approval")
        self.assertIsNone(self.approvals.lookup(token)["receipt"])

    def test_restart_recovers_receipt_and_claim_only_once(self):
        token, session, csrf = self.browser()
        receipt = self.approvals.approve(token, session, csrf)
        owner_hash = self.oauth.owner_hash
        self.store.db.close()
        self.store = Ledger(Path(self.directory.name))
        self.oauth = FixtureOAuth(self.store, "https://fixture.invalid/tasks", owner_hash)
        self.tasks = Tasks(self.store, self.oauth.resource)
        patch.object(self.tasks.communities, "current", side_effect=self.current).start()
        replacement = Approvals(self.tasks, self.oauth, "isolated-operator-secret-"*3)
        self.assertEqual(replacement.approve(token, session, csrf), receipt)
        first = self.tasks.operator({"action": "claim", "arguments": {"worker_protocol": 7}})
        second = self.tasks.operator({"action": "claim", "arguments": {"worker_protocol": 7}})
        self.assertEqual(first["task"]["task_id"], self.task["task_id"])
        self.assertIsNone(second["task"])
        self.assertEqual(replacement.approve(token, session, csrf), receipt)

    def test_expired_screen_needs_new_request_uuid(self):
        first = self.prepare()
        future = first["approval"]["expires_at"] + 1
        with patch("approvals.time.time", return_value=future):
            replay = self.prepare()
            self.assertEqual(replay["approval"]["status"], "expired")
            token = parse_qs(urlsplit(replay["approval"]["url"]).query)["token"][0]
            with self.assertRaisesRegex(ApprovalError, "approval_screen_expired"):
                self.approvals.authenticate(self.approvals.lookup(token), self.password, "fixture-peer")
            new = self.prepare(dict(self.args, request_id=str(uuid.uuid4())))
            self.assertNotEqual(first["approval"]["url"], new["approval"]["url"])
            self.assertEqual(new["approval"]["status"], "awaiting_owner_browser")

    def test_screen_binding_and_receipt_are_immutable(self):
        token, session, csrf = self.browser()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable_approval_binding"):
            with self.store.db:
                self.store.db.execute("UPDATE dot_task_approvals SET revision=99")
        self.approvals.approve(token, session, csrf)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable_approval_receipt"):
            with self.store.db:
                self.store.db.execute("UPDATE dot_task_approvals SET receipt=NULL")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable_approval_request"):
            with self.store.db:
                self.store.db.execute("DELETE FROM dot_task_approvals")

    def test_snapshot_generation_change_before_commit_is_denied(self):
        token, session, csrf = self.browser()
        first, changed = copy.deepcopy(self.snapshot), copy.deepcopy(self.snapshot)
        changed["generation"] = str(uuid.uuid4())
        with patch.object(self.tasks.communities, "current", side_effect=[first, changed]):
            with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
                self.approvals.approve(token, session, csrf)
        self.assertEqual(self.tasks.read(self.task["task_id"])["status"], "awaiting_approval")

    def test_prepare_lost_response_keeps_durable_screen_for_retry(self):
        first, changed = copy.deepcopy(self.snapshot), copy.deepcopy(self.snapshot)
        changed["generation"] = str(uuid.uuid4())
        with patch.object(self.tasks.communities, "current", side_effect=[first, first, changed]):
            with self.assertRaisesRegex(ApprovalError, "response_unconfirmed_reuse_request_uuid"):
                self.prepare()
        self.assertEqual(self.count("dot_task_approvals"), 1)
        self.assertEqual(self.prepare()["task"]["status"], "awaiting_approval")

    def test_private_screen_does_not_accept_forged_token(self):
        self.prepare()
        with self.assertRaisesRegex(ApprovalError, "approval_unavailable"):
            self.approvals.lookup("0"*64)

    def test_schema_four_changed_repository_binding_is_denied(self):
        project = {"project_id": "buzz", "role_id": "fmg-backend", "source_commit": "d"*40,
                   "execution_host": "hostinger", "branch": "fixture/buzz", "workspace_sha256": "e"*64}
        self.snapshot["project_bindings"] = [project]
        self.task = self.tasks.call("fmg_buzz_propose_task", {"request_id": str(uuid.uuid4()),
                                   "role_id": "fmg-backend", "instructions": "isolated repository fixture"},
                                   self.client, project=project, authorize=self.authorize)["structuredContent"]
        self.args.update(task_id=self.task["task_id"], proposal_hash=self.task["proposal_hash"])
        token, session, csrf = self.browser()
        self.snapshot["project_bindings"][0]["source_commit"] = "f"*40
        with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
            self.approvals.approve(token, session, csrf)

    def test_login_does_not_disclose_task_and_review_escapes_output(self):
        token, session, _ = self.browser()
        pages = ApprovalPages(self.approvals)
        self.assertNotIn(self.task["proposal"]["instructions"], pages.login(token))
        review = pages.review(self.approvals.lookup(token), token, session)
        self.assertIn("&lt;script&gt;", review)
        self.assertNotIn("<script>", review)


if __name__ == "__main__":
    unittest.main()
