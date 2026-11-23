"""Offline acceptance tests for the Vast cost and privacy deployment plan."""
import copy
import unittest
from vast_canary_plan import audit_plan, SCHEMA

def plan():
    return {
        "schema": SCHEMA,
        "endpoint": {
            "endpoint_name": "reality-canary", "endpoint_state": "stopped",
            "min_load": 0, "min_cold_load": 0, "cold_workers": 0,
            "max_workers": 1, "max_queue_time": 2.0,
            "target_queue_time": 0.5, "inactivity_timeout": 60,
        },
        "worker": {
            "pyworker_commit": "a" * 40, "image_sha256": "sha256:" + "b" * 64,
            "checkpoint_sha256": "sha256:" + "c" * 64,
            "gpu_class": "H200 NVL", "minimum_vram_gb": 140,
            "route": "/v1/reality/render", "model_license_review": True,
        },
        "budget": {
            "max_gpu_usd_per_hour": 4, "max_worker_hours": 1,
            "max_total_compute_usd": 4, "quote_verified": True,
        },
        "approvals": {
            "gpu_spend_approval": "ops/approved123",
            "hosted_data_processing_approval": "privacy/approved123",
        },
        "stop_control": {
            "watchdog_verified": True, "operator_receipt": "ops/watchdog123",
        },
    }

class CanaryPolicyTests(unittest.TestCase):
    def test_reviewable_plan_still_never_deploys(self):
        result = audit_plan(plan())
        self.assertTrue(result["ok"], result)
        self.assertIs(result["deployment_performed"], False)

    def test_legacy_default_five_workers_is_rejected(self):
        p = plan()
        p["endpoint"]["cold_workers"] = 5
        self.assertFalse(audit_plan(p)["ok"])

    def test_missing_worker_setting_is_rejected(self):
        p = plan()
        del p["endpoint"]["max_workers"]
        self.assertFalse(audit_plan(p)["ok"])

    def test_two_workers_rejected(self):
        p = plan()
        p["endpoint"]["max_workers"] = 2
        self.assertFalse(audit_plan(p)["ok"])

    def test_active_endpoint_rejected(self):
        p = plan()
        p["endpoint"]["endpoint_state"] = "active"
        self.assertFalse(audit_plan(p)["ok"])

    def test_cold_or_warm_floor_rejected(self):
        for field in ("min_load", "min_cold_load"):
            with self.subTest(field=field):
                p = plan()
                p["endpoint"][field] = 1
                self.assertFalse(audit_plan(p)["ok"])

    def test_queue_limit_rejected(self):
        p = plan()
        p["endpoint"]["max_queue_time"] = 30
        self.assertFalse(audit_plan(p)["ok"])

    def test_idle_scale_to_zero_requires_positive_timeout(self):
        p = plan()
        p["endpoint"]["inactivity_timeout"] = 0
        self.assertFalse(audit_plan(p)["ok"])

    def test_missing_price_quote_blocks(self):
        p = plan()
        p["budget"]["quote_verified"] = False
        self.assertFalse(audit_plan(p)["ok"])

    def test_budget_overrun_blocks(self):
        p = plan()
        p["budget"]["max_total_compute_usd"] = 3
        self.assertFalse(audit_plan(p)["ok"])

    def test_missing_processing_or_spend_approval_blocks(self):
        for field in ("gpu_spend_approval", "hosted_data_processing_approval"):
            with self.subTest(field=field):
                p = plan()
                p["approvals"][field] = None
                self.assertFalse(audit_plan(p)["ok"])

    def test_missing_stop_watchdog_blocks(self):
        p = plan()
        p["stop_control"]["watchdog_verified"] = False
        self.assertFalse(audit_plan(p)["ok"])

    def test_unpinned_worker_blocks(self):
        p = plan()
        p["worker"]["image_sha256"] = "latest"
        self.assertFalse(audit_plan(p)["ok"])

    def test_invalid_licensing_or_route_blocks(self):
        p = plan()
        p["worker"]["model_license_review"] = False
        p["worker"]["route"] = "/v1/completions"
        self.assertFalse(audit_plan(p)["ok"])

    def test_unknown_fields_block(self):
        p = plan()
        p["api_key"] = "MUST NOT BE IN PLAN"
        self.assertFalse(audit_plan(p)["ok"])

    def test_nan_price_blocks(self):
        p = plan()
        p["budget"]["max_gpu_usd_per_hour"] = float("nan")
        self.assertFalse(audit_plan(p)["ok"])

    def test_boolean_disguised_as_number_blocks(self):
        p = plan()
        p["endpoint"]["max_workers"] = True
        self.assertFalse(audit_plan(p)["ok"])

if __name__ == "__main__":
    unittest.main()
