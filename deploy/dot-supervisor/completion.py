"""Validate bounded completion attestations from the authenticated Gateway worker."""
import json
import math
import re
import time
from store import canonical, digest


def validate_completion(row, result):
    """Require a matching durable intent, proposal and stored reply for success."""
    evidence = result.get("completion_evidence")
    if not isinstance(result.get("reply"), str) or not isinstance(evidence, dict) or len(canonical(evidence).encode()) > 4000:
        raise ValueError("completion_evidence_unavailable")
    proposal = json.loads(row["proposal"])
    model = r"[a-z0-9_-]+/[a-zA-Z0-9._:-]{1,100}"
    if (not re.fullmatch(model, proposal["requested_model"])
            or result.get("actual_model") is not None and not re.fullmatch(model, result["actual_model"])
            or type(evidence.get("schema")) is not int):
        raise ValueError("completion_model_invalid")
    expected = {
        "schema": 1, "validation_contract": "fmg-terminal-v1",
        "run_id": row["run_id"], "proposal_hash": row["proposal_hash"],
        "requested_model": proposal["requested_model"],
        "actual_model": result.get("actual_model"),
        "requested_effort": proposal.get("requested_effort"),
        "model_binding": proposal.get("model_binding"),
        "terminal_status": "succeeded", "source_completeness": "stored_summary",
        "reply_hash": digest(result.get("reply", "").encode()),
    }
    if (set(evidence) != set(expected) | {"source", "receipt_hash", "validated_at", "ended_at"}
            or any(evidence.get(key) != value for key, value in expected.items())
            or row["dispatch_stage"] != "intent_recorded" or row["run_id"] != row["id"]
            or result.get("run_id") != row["run_id"] or result.get("status") != "succeeded"
            or result.get("requested_model") != proposal["requested_model"]
            or result.get("error_code") is not None
            or digest(canonical(proposal).encode()) != row["proposal_hash"]
            or evidence.get("source") not in ("gateway.agent.final", "gateway.agent.wait")
            or not isinstance(evidence.get("receipt_hash"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", evidence["receipt_hash"])):
        raise ValueError("completion_evidence_invalid")
    minimum, maximum = row["created"] * 1000 - 5000, time.time() * 1000 + 5000
    for key in ("validated_at", "ended_at"):
        value = evidence[key]
        if key == "ended_at" and value is None and evidence["source"] == "gateway.agent.final":
            continue  # An observation time must never be invented as a Gateway end time.
        if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError("completion_time_invalid")
    return evidence
