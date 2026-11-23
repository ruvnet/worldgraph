"""Audit Vast Serverless canary configuration without network calls or deployments.

A passing audit is a reviewed PLAN, not permission or a provider-side cost limit.
"""
import argparse
import json
import math
import re
from pathlib import Path

SCHEMA = "cognitum.reality.vast.canary.v1"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_ROUTE = "/v1/reality/render"

def _number(x):
    return type(x) in (int, float) and math.isfinite(x)

def audit_plan(plan):
    """Report unsafe or unapproved settings; perform no network or mutations."""
    errors = []
    if not isinstance(plan, dict) or set(plan) != {
        "schema", "endpoint", "worker", "budget", "approvals", "stop_control"
    }:
        return {"ok": False, "errors": ["incomplete or unknown top-level fields"],
                "deployment_performed": False}
    if plan["schema"] != SCHEMA:
        errors.append("unrecognized canary schema")

    ep = plan["endpoint"]
    required_ep = {"endpoint_name", "endpoint_state", "min_load", "min_cold_load",
                   "cold_workers", "max_workers", "max_queue_time",
                   "target_queue_time", "inactivity_timeout"}
    if not isinstance(ep, dict) or set(ep) != required_ep:
        errors.append("missing or unknown endpoint scaling settings")
    else:
        if not isinstance(ep["endpoint_name"], str) or not re.fullmatch(
                r"[a-z][a-z0-9_-]{2,62}", ep["endpoint_name"]):
            errors.append("invalid endpoint name")
        if ep["endpoint_state"] != "stopped":
            errors.append("initial canary endpoint must be stopped")
        for field in ("min_load", "min_cold_load", "cold_workers"):
            if type(ep[field]) not in (int, float) or ep[field] != 0:
                errors.append(field + " must be explicitly zero")
        if type(ep["max_workers"]) is not int or ep["max_workers"] != 1:
            errors.append("max_workers must be exactly one")
        for field in ("max_queue_time", "target_queue_time", "inactivity_timeout"):
            if not _number(ep[field]) or ep[field] <= 0:
                errors.append(field + " must be positive and finite")
        if (_number(ep["max_queue_time"]) and ep["max_queue_time"] > 2):
            errors.append("queue budget exceeds two seconds")
        if (_number(ep["target_queue_time"]) and _number(ep["max_queue_time"])
            and ep["target_queue_time"] > ep["max_queue_time"]):
            errors.append("target queue exceeds maximum")
        if (_number(ep["inactivity_timeout"])
            and not (30 <= ep["inactivity_timeout"] <= 600)):
            errors.append("inactivity timeout is outside 30 to 600 seconds")

    worker = plan["worker"]
    if not isinstance(worker, dict) or set(worker) != {
        "pyworker_commit", "image_sha256", "checkpoint_sha256",
        "gpu_class", "minimum_vram_gb", "route", "model_license_review"
    }:
        errors.append("unversioned or incomplete worker")
    else:
        if not isinstance(worker["pyworker_commit"], str) or not COMMIT.fullmatch(
                worker["pyworker_commit"]):
            errors.append("PyWorker commit is not pinned")
        for name in ("image_sha256", "checkpoint_sha256"):
            if not isinstance(worker[name], str) or not DIGEST.fullmatch(worker[name]):
                errors.append(name + " is not pinned")
        if worker["route"] != ALLOWED_ROUTE:
            errors.append("unexpected model worker route")
        if not isinstance(worker["gpu_class"], str) or not re.fullmatch(
                r"[A-Za-z0-9_. -]{2,64}", worker["gpu_class"]):
            errors.append("invalid GPU class")
        if not _number(worker["minimum_vram_gb"]) or not (
                1 <= worker["minimum_vram_gb"] <= 1024):
            errors.append("invalid GPU memory requirement")
        if worker["model_license_review"] is not True:
            errors.append("model, weights and components require licensing approval")

    budget = plan["budget"]
    if not isinstance(budget, dict) or set(budget) != {
        "max_gpu_usd_per_hour", "max_worker_hours", "max_total_compute_usd",
        "quote_verified"
    }:
        errors.append("missing bounded spend plan")
    else:
        for key in ("max_gpu_usd_per_hour", "max_worker_hours", "max_total_compute_usd"):
            if not _number(budget[key]) or budget[key] <= 0:
                errors.append(key + " must be finite and positive")
        if all(_number(budget[k]) and budget[k] > 0 for k in
               ("max_gpu_usd_per_hour", "max_worker_hours", "max_total_compute_usd")):
            estimate = budget["max_gpu_usd_per_hour"] * budget["max_worker_hours"]
            if estimate > budget["max_total_compute_usd"]:
                errors.append("estimated maximum compute exceeds the approved ceiling")
        if budget["quote_verified"] is not True:
            errors.append("current provider quote has not been verified")

    approvals = plan["approvals"]
    if not isinstance(approvals, dict) or set(approvals) != {
        "gpu_spend_approval", "hosted_data_processing_approval"
    }:
        errors.append("missing independent approvals")
    else:
        for name in ("gpu_spend_approval", "hosted_data_processing_approval"):
            if not isinstance(approvals[name], str) or not re.fullmatch(
                    r"[A-Za-z0-9_.:/-]{8,160}", approvals[name]):
                errors.append("missing explicit " + name)

    stop = plan["stop_control"]
    if not isinstance(stop, dict) or set(stop) != {
        "watchdog_verified", "operator_receipt"
    }:
        errors.append("missing external hard-stop control")
    elif stop["watchdog_verified"] is not True or not isinstance(
            stop["operator_receipt"], str) or not re.fullmatch(
                r"[A-Za-z0-9_.:/-]{8,160}", stop["operator_receipt"]):
        errors.append("automatic shutdown is not independently verified")

    return {"ok": not errors, "errors": errors,
            "deployment_performed": False,
            "meaning": "dry-run policy audit, never an API or billing action"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    args = parser.parse_args()
    result = audit_plan(json.loads(args.plan.read_text()))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
