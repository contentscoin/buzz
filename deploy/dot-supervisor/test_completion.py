"""Regression tests for authenticated completion attestations; no live models."""
import unittest
import time
from completion import validate_completion
from store import canonical, digest


class CompletionTests(unittest.TestCase):
    def fixture(self, source="gateway.runtime.no_tools"):
        now = time.time()
        run = "76fc8565-8b9e-4c71-8a80-736b6eca5178"
        proposal = {"requested_model": "openai/gpt-6.1-sol", "requested_effort": "medium", "model_binding": "b"*64}
        row = {"id": run, "run_id": run, "proposal": canonical(proposal), "proposal_hash": digest(canonical(proposal).encode()),
               "created": now-60, "dispatch_stage": "intent_recorded"}
        result = {"status": "succeeded", "run_id": run, "requested_model": proposal["requested_model"],
                  "actual_model": proposal["requested_model"], "reply": "완료", "error_code": None}
        result["completion_evidence"] = {"schema": 1, "validation_contract": "fmg-terminal-v3" if source == "gateway.runtime.read_exec" else "fmg-terminal-v2" if source == "gateway.runtime.no_tools" else "fmg-terminal-v1",
            "source": source, "run_id": run, "proposal_hash": row["proposal_hash"], "requested_model": proposal["requested_model"],
            "actual_model": result["actual_model"], "requested_effort": "medium", "model_binding": "b"*64,
            "terminal_status": "succeeded", "source_completeness": "stored_summary", "reply_hash": digest("완료".encode()),
            "receipt_hash": "c"*64, "validated_at": now*1000, "ended_at": (now-10)*1000}
        return row, result

    def test_sources(self):
        for source in ["gateway.runtime.no_tools", "gateway.agent.final", "gateway.agent.wait", "gateway.runtime.read_exec"]:
            row, result = self.fixture(source)
            self.assertEqual(validate_completion(row, result)["source"], source)

    def test_fail_closed(self):
        for field, value in [("run_id", "other"), ("proposal_hash", "0"*64), ("reply_hash", "0"*64),
                             ("requested_effort", "low"), ("source", "untrusted"), ("validation_contract", "fmg-terminal-v1"),
                             ("receipt_hash", "missing"), ("ended_at", None)]:
            with self.subTest(field=field):
                row, result = self.fixture()
                result["completion_evidence"][field] = value
                with self.assertRaises(ValueError): validate_completion(row, result)

    def test_read_exec_contract_cannot_borrow_another_source_or_reply(self):
        for field, value in [("validation_contract", "fmg-terminal-v2"), ("source", "gateway.runtime.no_tools"),
                             ("reply_hash", "0"*64), ("requested_effort", "low"), ("ended_at", None)]:
            with self.subTest(field=field):
                row, result = self.fixture("gateway.runtime.read_exec")
                result["completion_evidence"][field] = value
                with self.assertRaises(ValueError): validate_completion(row, result)

    def test_operator_reconcile_persists_v3_and_rejects_repeated_transition(self):
        # The only writes are to the fixture's temporary SQLite, never the live ledger.
        import test_project_proposals
        fixture = test_project_proposals.ProjectProposalTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        task = fixture.propose()
        fixture.store.db.execute("UPDATE tasks SET status='needs_reconcile',run_id=id,dispatch_stage='intent_recorded' WHERE id=?", (task["task_id"],))
        fixture.store.db.commit()
        _, result = self.fixture("gateway.runtime.read_exec")
        result.update(run_id=task["task_id"], requested_model=task["proposal"]["requested_model"], actual_model=task["proposal"]["requested_model"])
        completion = result["completion_evidence"]
        completion.update(run_id=task["task_id"], proposal_hash=task["proposal_hash"],
                          requested_model=result["requested_model"], actual_model=result["actual_model"],
                          model_binding=task["proposal"]["model_binding"], requested_effort=task["proposal"]["requested_effort"],
                          ended_at=time.time()*1000)
        evidence = {"source": completion["source"], "run_id": task["task_id"], "ended_at": completion["ended_at"],
                    "gateway_status": "ok", "stop_reason": "stop", "receipt_hash": completion["receipt_hash"]}
        request = {"action": "reconcile", "arguments": {"task_id": task["task_id"], "proposal_hash": task["proposal_hash"],
                    "revision": task["revision"], "result": result, "evidence": evidence}}
        recovered = fixture.tasks.operator(request)
        self.assertEqual(recovered["status"], "succeeded")
        self.assertEqual(recovered["result"]["completion_evidence"]["validation_contract"], "fmg-terminal-v3")
        self.assertEqual(len(recovered["recovery_history"]), 1)
        with self.assertRaises(ValueError): fixture.tasks.operator(request)


if __name__ == "__main__":
    unittest.main()
