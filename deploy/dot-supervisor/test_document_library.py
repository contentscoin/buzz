"""Desktop library authorization and pagination against isolated production storage."""
import copy
import time
import unittest
from unittest.mock import patch
import uuid
import test_project_proposals
import test_completion
from communities import binding, scope
from documents import Documents, DocumentError
from store import canonical


class DocumentLibraryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_project_proposals.ProjectProposalTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store, self.tasks = self.fixture.store, self.fixture.tasks
        self.current = self.fixture.fmg
        self.current["default_community"] = False
        self.docs = Documents(self.store, self.tasks, self.fixture.fixture.oauth.resource)
        for target in ("communities.selected", "document_access.snapshot"):
            patcher = patch(target, side_effect=lambda *_: copy.deepcopy(self.current))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.first = self.fixture.fixture.client
        self.headers = {self.first: self.fixture.fixture.header}
        self.second = str(uuid.uuid4())
        self.headers[self.second] = "Bearer " + self.fixture.fixture.oauth.issue(self.second, self.fixture.fixture.oauth.resource)["access_token"]
        self.store.db.commit()
        self.grant(self.first, True)
        self.grant(self.second, True)

    def grant(self, client, enabled):
        current = self.tasks.communities.grant(client, self.current)
        return self.tasks.communities.operator({"action": "communities.set", "arguments": {
            **binding(self.current), "connection_id": client, "community_id": "fmg",
            "enabled": enabled, "expected_revision": current["revision"], "request_id": str(uuid.uuid4())}})

    def document(self, client, document_id=None):
        authorize = lambda: self.fixture.fixture.oauth.bearer(self.headers[client])
        task = self.tasks.call("fmg_buzz_propose_task", self.fixture.arguments(), client, authorize=authorize)["structuredContent"]
        # Only seed synthetic completion in this temporary SQLite database; no worker or model runs.
        _, result = test_completion.CompletionTests().fixture()
        result["run_id"] = task["task_id"]
        result["completion_evidence"].update(run_id=task["task_id"], proposal_hash=task["proposal_hash"],
            model_binding=task["proposal"]["model_binding"], ended_at=time.time()*1000, validated_at=time.time()*1000)
        self.store.db.execute("UPDATE tasks SET status='succeeded',result=?,run_id=id,dispatch_stage='intent_recorded' WHERE id=?", (canonical(result), task["task_id"]))
        self.store.db.commit()
        args = {"task_id": task["task_id"], "request_id": str(uuid.uuid4()), "document_id": None,
                "expected_version": 0, "markdown": "# isolated private document", "community_id": "fmg"}
        if document_id:
            with patch("documents.uuid.uuid4", return_value=uuid.UUID(document_id)):
                document = self.docs.call("fmg_buzz_save_document", args, client, authorize)["structuredContent"]
        else:
            document = self.docs.call("fmg_buzz_save_document", args, client, authorize)["structuredContent"]
        self.docs.call("fmg_buzz_set_document_desktop_access", {"task_id": task["task_id"],
            "enabled": True, "expected_revision": 0, "community_id": "fmg"}, client, authorize)
        return document

    def library(self, cursor=None):
        return self.docs.desktop.operator({"action": "documents.list", "arguments": {
            **binding(self.current), "cursor": cursor}})

    def test_valid_connections_share_owner_library_without_document_content(self):
        first, second = self.document(self.first), self.document(self.second)
        result = self.library()
        self.assertEqual({row["document_id"] for row in result["documents"]}, {first["document_id"], second["document_id"]})
        self.assertIsNone(result["next_cursor"])
        self.assertNotIn("isolated private document", canonical(result))
        self.assertNotIn("markdown_base64", canonical(result))

    def test_one_revoked_community_connection_is_filtered_before_projection(self):
        first, second = self.document(self.first), self.document(self.second)
        self.grant(self.second, False)
        with patch.object(self.docs, "view", wraps=self.docs.view) as view:
            result = self.library()
        self.assertEqual([row["document_id"] for row in result["documents"]], [first["document_id"]])
        self.assertNotIn(second["document_id"], canonical(result))
        self.assertNotIn(second["source"]["task_id"], canonical(result))
        self.assertEqual(view.call_count, 1)
        self.assertIsNone(result["next_cursor"])

    def test_all_explicitly_revoked_connections_return_empty_verified_library(self):
        self.document(self.first)
        self.document(self.second)
        self.grant(self.first, False)
        self.grant(self.second, False)
        self.assertEqual(self.library(), {"documents": [], "limit": 20, "next_cursor": None})

    def test_oauth_revocation_filters_only_that_client(self):
        first, second = self.document(self.first), self.document(self.second)
        self.store.db.execute("DELETE FROM tokens WHERE client_id=?", (self.second,))
        self.store.db.commit()
        result = self.library()
        self.assertEqual([row["document_id"] for row in result["documents"]], [first["document_id"]])
        self.assertNotIn(second["document_id"], canonical(result))

    def test_revoked_documents_do_not_consume_page_limit_or_skip_valid_documents(self):
        for index in range(21):
            self.document(self.second, f"00000000-0000-4000-8000-{index:012d}")
        expected = [self.document(self.first, f"10000000-0000-4000-8000-{index:012d}")["document_id"] for index in range(21)]
        self.grant(self.second, False)
        first = self.library()
        self.assertEqual([row["document_id"] for row in first["documents"]], expected[:20])
        self.assertEqual(first["next_cursor"], expected[19])
        second = self.library(first["next_cursor"])
        self.assertEqual([row["document_id"] for row in second["documents"]], expected[20:])
        self.assertIsNone(second["next_cursor"])

    def test_unavailable_or_changed_community_is_not_empty_success(self):
        self.document(self.first)
        for error in (ValueError("community_generation_changed"), ValueError("community_unavailable"), OSError("snapshot read failed")):
            with self.subTest(error=type(error).__name__), patch("communities.selected", side_effect=error):
                with self.assertRaisesRegex(DocumentError, "community_unavailable"):
                    self.library()

    def test_missing_initial_snapshot_remains_an_error_even_for_empty_library(self):
        with patch("document_access.snapshot", side_effect=ValueError("observation_expired")):
            with self.assertRaisesRegex(ValueError, "observation_expired"):
                self.library()

    def test_scope_or_generation_change_after_projection_denies_entire_response(self):
        self.document(self.first)
        for change in ({"generation": str(uuid.uuid4())}, {"gateway_agent_pubkey": "9"*64}, {"relay_origin": "https://other.fixture.invalid"}):
            changed = dict(self.current, **change)
            with self.subTest(change=change), patch("document_access.snapshot", side_effect=[copy.deepcopy(self.current), changed]):
                with self.assertRaisesRegex(DocumentError, "access_denied"):
                    self.library()

    def test_permission_revoked_during_projection_denies_entire_response(self):
        self.document(self.first)
        original = self.docs.view
        def revoke_during_read(*args, **kwargs):
            value = original(*args, **kwargs)
            self.store.db.execute("UPDATE dot_community_access SET enabled=0 WHERE scope=? AND client=?", (scope(self.current), self.first))
            return value
        with patch.object(self.docs, "view", side_effect=revoke_during_read):
            with self.assertRaisesRegex(DocumentError, "access_denied"):
                self.library()


if __name__ == "__main__":
    unittest.main()
