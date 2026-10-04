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
        result["completion_evidence"] = {"schema": 1, "validation_contract": "fmg-terminal-v2" if source == "gateway.runtime.no_tools" else "fmg-terminal-v1",
            "source": source, "run_id": run, "proposal_hash": row["proposal_hash"], "requested_model": proposal["requested_model"],
            "actual_model": result["actual_model"], "requested_effort": "medium", "model_binding": "b"*64,
            "terminal_status": "succeeded", "source_completeness": "stored_summary", "reply_hash": digest("완료".encode()),
            "receipt_hash": "c"*64, "validated_at": now*1000, "ended_at": (now-10)*1000}
        return row, result

    def test_sources(self):
        for source in ["gateway.runtime.no_tools", "gateway.agent.final", "gateway.agent.wait"]:
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


if __name__ == "__main__":
    unittest.main()
