"""Repository-bound dot proposals through real Tasks/Approvals and isolated SQLite."""
import copy
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import uuid
import test_approvals
from approvals import ApprovalError
from documents import Documents
from store import canonical, digest
from tasks import CATALOG


class ProjectProposalTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_approvals.ApprovalTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.tasks, self.store = self.fixture.tasks, self.fixture.store
        self.fmg = copy.deepcopy(self.fixture.snapshot)
        self.fmg.update(community_id="fmg", relay_origin="https://fmg.fixture.invalid",
                        gateway_agent_pubkey="d"*64)
        self.project = {"schema": 1, "project_id": "buzz",
                        "repository_url": "https://github.com/contentscoin/buzz.git",
                        "role_id": "fmg-backend", "branch": "fmg-buzz/fmg-backend",
                        "source_commit": "e"*40, "execution_host": "hostinger",
                        "workspace_binding": "f"*64}
        self.fmg["project_bindings"] = [self.project]
        self.allowed = True
        current = patch.object(self.tasks.communities, "current", side_effect=self.current)
        current.start()
        self.addCleanup(current.stop)
        snapshot = patch("tasks.snapshot", side_effect=self.snapshot)
        snapshot.start()
        self.addCleanup(snapshot.stop)

    def current(self, client, community=None):
        if community == "fmg":
            if not self.allowed:
                raise ValueError("community_access_required")
            return copy.deepcopy(self.fmg)
        return self.fixture.current(client, community)

    def snapshot(self, audience=None):
        return copy.deepcopy(self.fmg if audience and audience.get("relay_origin") == self.fmg["relay_origin"] else self.fixture.snapshot)

    def arguments(self, **changes):
        return dict({"request_id": str(uuid.uuid4()), "role_id": "fmg-backend",
                     "instructions": "격리된 제안 계약 검증. 실제 모델을 실행하지 않습니다.",
                     "community_id": "fmg", "project_id": "buzz"}, **changes)

    def propose(self, args=None):
        return self.tasks.call("fmg_buzz_propose_task", args or self.arguments(),
                               self.fixture.client, authorize=self.fixture.authorize)["structuredContent"]

    def browser(self, task):
        args = {"request_id": str(uuid.uuid4()), "task_id": task["task_id"],
                "proposal_hash": task["proposal_hash"], "revision": task["revision"],
                "community_id": "fmg"}
        approvals = self.fixture.approvals
        result = approvals.prepare(args, self.fixture.client, self.fixture.header,
                                   self.fixture.authorize)["structuredContent"]
        token = parse_qs(urlsplit(result["approval"]["url"]).query)["token"][0]
        session = approvals.authenticate(approvals.lookup(token), self.fixture.password, "fixture-project-peer")
        return token, session, approvals.csrf(token, session)

    def test_catalog_exposes_optional_project_and_preserves_generic_proposals(self):
        schema = next(item for item in CATALOG if item["name"] == "fmg_buzz_propose_task")["inputSchema"]
        self.assertEqual(schema["properties"]["project_id"]["enum"], ["buzz"])
        self.assertNotIn("project_id", schema["required"])
        args = self.arguments()
        del args["project_id"]
        proposal = self.propose(args)["proposal"]
        self.assertEqual(proposal["schema"], 3)
        self.assertNotIn("project", proposal)
        self.assertNotIn("proposal_account", proposal)

    def test_dot_project_binds_selected_community_role_and_original_client(self):
        task = self.propose(self.arguments(effort="high"))
        proposal = task["proposal"]
        self.assertEqual(proposal["schema"], 4)
        self.assertEqual(proposal["project"], self.project)
        self.assertEqual(proposal["requested_effort"], "high")
        self.assertEqual(proposal["relay_origin"], self.fmg["relay_origin"])
        self.assertEqual(proposal["proposal_account"], "original_oauth_client")
        self.assertEqual(self.tasks.read(task["task_id"])["client"], self.fixture.client)
        self.assertEqual(task["proposal_hash"], digest(canonical(proposal).encode()))
        self.assertEqual(task["status"], "awaiting_approval")
        self.assertIsNone(task["run_id"])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM dot_community_access").fetchone()[0], 0)
        docs = Documents(self.store, self.tasks, self.fixture.oauth.resource)
        access = docs.call("fmg_buzz_get_document_desktop_access", {"task_id": task["task_id"], "community_id": "fmg"},
                           self.fixture.client, self.fixture.authorize)["structuredContent"]
        self.assertFalse(access["enabled"])
        self.assertEqual(access["revision"], 0)

    def test_absent_ambiguous_wrong_role_or_malformed_mapping_is_rejected(self):
        rows = [[], [self.project, dict(self.project)], [dict(self.project, role_id="fmg-frontend")],
                [dict(self.project, repository_url="https://other.invalid/repo.git")],
                [dict(self.project, branch="main")], [dict(self.project, source_commit="invalid")],
                [dict(self.project, workspace_binding="invalid")], [dict(self.project, schema=True)],
                [dict(self.project, unexpected="field")]]
        count = self.store.db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        for bindings in rows:
            with self.subTest(bindings=bindings):
                self.fmg["project_bindings"] = copy.deepcopy(bindings)
                with self.assertRaisesRegex(ValueError, "project_binding_unavailable"):
                    self.propose()
                self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], count)

    def test_no_fallback_or_implicit_community_access(self):
        with self.assertRaisesRegex(ValueError, "project_binding_unavailable"):
            self.propose(self.arguments(community_id="bd"))
        self.allowed = False
        with self.assertRaisesRegex(ValueError, "community_access_required"):
            self.propose()
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM dot_community_access").fetchone()[0], 0)

    def test_unknown_project_and_caller_supplied_binding_are_rejected(self):
        for changes in ({"project_id": "other"}, {"project_id": None}, {"project": self.project}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.propose(self.arguments(**changes))

    def test_same_request_recovery_preserves_immutable_binding_after_mapping_changes(self):
        args = self.arguments()
        original = self.propose(args)
        self.project["source_commit"] = "1"*40
        recovered = self.propose(args)
        self.assertEqual(original, recovered)
        with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
            self.browser(recovered)
        self.assertEqual(self.tasks.read(original["task_id"])["status"], "awaiting_approval")

    def test_same_uuid_cannot_switch_project_or_community(self):
        args = self.arguments()
        self.propose(args)
        generic = dict(args)
        del generic["project_id"]
        for changed in (generic, dict(args, community_id="bd")):
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, "request_conflict"):
                self.propose(changed)

    def test_bound_dot_proposal_uses_existing_browser_approval_and_claim(self):
        task = self.propose()
        token, session, csrf = self.browser(task)
        receipt = self.fixture.approvals.approve(token, session, csrf)
        self.assertEqual(receipt["client_id"], self.fixture.client)
        self.assertEqual(receipt["community_id"], "fmg")
        claimed = self.tasks.operator({"action": "claim", "arguments": {"worker_protocol": 7}})
        self.assertEqual(claimed["task"]["task_id"], task["task_id"])
        self.assertEqual(claimed["task"]["proposal"], task["proposal"])
        self.assertIsNone(claimed["task"]["run_id"])
        self.assertIsNone(claimed["task"]["result"])

    def test_changed_mapping_between_review_and_approval_is_denied(self):
        task = self.propose()
        token, session, csrf = self.browser(task)
        self.project["workspace_binding"] = "2"*64
        with self.assertRaisesRegex(ApprovalError, "approval_binding_changed"):
            self.fixture.approvals.approve(token, session, csrf)
        self.assertEqual(self.tasks.read(task["task_id"])["status"], "awaiting_approval")

    def test_changed_mapping_after_approval_blocks_claim_without_execution(self):
        task = self.propose()
        self.fixture.approvals.approve(*self.browser(task))
        self.fmg["project_bindings"] = []
        claimed = self.tasks.operator({"action": "claim", "arguments": {"worker_protocol": 7}})
        self.assertIsNone(claimed["task"])
        self.assertEqual(claimed["reason"], "approved_binding_changed")
        stored = self.tasks.read(task["task_id"])
        self.assertEqual(stored["status"], "needs_reconcile")
        self.assertIsNone(stored["run_id"])
        self.assertIsNone(stored["result"])

    def test_another_oauth_connection_cannot_read_or_prepare_approval(self):
        task = self.propose()
        other = str(uuid.uuid4())
        header = "Bearer " + self.fixture.oauth.issue(other, self.fixture.oauth.resource)["access_token"]
        authorize = lambda: self.fixture.oauth.bearer(header)
        with self.assertRaisesRegex(ValueError, "task_unavailable"):
            self.tasks.call("fmg_buzz_get_task", {"task_id": task["task_id"], "community_id": "fmg"}, other, authorize=authorize)
        with self.assertRaisesRegex(ValueError, "task_unavailable"):
            self.fixture.approvals.prepare({"request_id": str(uuid.uuid4()), "task_id": task["task_id"],
                "proposal_hash": task["proposal_hash"], "revision": task["revision"], "community_id": "fmg"}, other, header, authorize)


if __name__ == "__main__":
    unittest.main()
