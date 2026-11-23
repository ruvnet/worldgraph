"""Vast Serverless client for an explicitly deployed Cognitum Reality worker.

No endpoint is created here. No requests occur unless enable_remote=True.
The worker must implement /v1/reality/render and return signed-off descriptors;
this client never treats generated pixels as observations.
"""
import hashlib
import json
import os
import time
import asyncio
import re
from typing import Callable

HEX = re.compile(r"^sha256:[0-9a-f]{64}$")
MEDIA_HEX = re.compile(r"^[0-9a-f]{64}$")
ENDPOINT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$")
FIELDS = frozenset({
    "schema", "tenant", "workspace", "site", "space", "snapshot_hash",
    "calibration", "privacy_epoch", "stream_epoch", "capture_ms",
    "presentation_ms", "origin", "purpose", "hosted_processing_approved",
    "regions", "manifest_sha256",
})
REGION_FIELDS = frozenset({
    "id", "evidence", "count", "position_m", "unknown",
    "captured_at_ms", "valid_until_ms",
})

class AdmissionError(ValueError):
    """Request is not authorized for hosted rendering."""

class ReceiptError(ValueError):
    """Serverless response fails the simulated-media contract."""

def _valid_digest(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None

def validate_manifest(manifest, *, tenant, workspace, now_ms, max_age_ms=500):
    """Validate a Rust-produced, approved current-view manifest.

    Hash matches the Rust serializer for the frozen v1 ASCII identifier schema.
    The source snapshot hash must be verified by the Rust host before compilation.
    """
    if not isinstance(manifest, dict) or set(manifest) != FIELDS:
        raise AdmissionError("invalid conditioning manifest fields")
    if manifest["schema"] != "cognitum.reality.conditioning.v1":
        raise AdmissionError("unsupported manifest version")
    if manifest["tenant"] != tenant or manifest["workspace"] != workspace:
        raise AdmissionError("foreign tenant or workspace")
    if manifest["origin"] not in ("live", "replay"):
        raise AdmissionError("synthetic current view is forbidden")
    if manifest["purpose"] != "current_view":
        raise AdmissionError("this endpoint only renders current views")
    if manifest["hosted_processing_approved"] is not True:
        raise AdmissionError("hosted processing approval missing")
    if not _valid_digest(manifest["snapshot_hash"]) or not _valid_digest(manifest["manifest_sha256"]):
        raise AdmissionError("missing snapshot or manifest digest")
    if not isinstance(now_ms, int) or not isinstance(max_age_ms, int) or max_age_ms <= 0:
        raise AdmissionError("invalid clock policy")
    if (not isinstance(manifest["capture_ms"], int)
        or manifest["capture_ms"] > now_ms
        or now_ms - manifest["capture_ms"] > max_age_ms):
        raise AdmissionError("expired or future source evidence")
    for key in ("tenant","workspace","site","space","calibration"):
        if not isinstance(manifest[key],str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}",manifest[key]):
            raise AdmissionError("invalid scoped identity")
    regions = manifest["regions"]
    if not isinstance(regions,list) or len(regions)>128:
        raise AdmissionError("unbounded regions")
    for r in regions:
        if not isinstance(r,dict) or set(r)!=REGION_FIELDS:
            raise AdmissionError("unknown region or raw sensor field")
        if r["evidence"]=="count_only" and r["position_m"] is not None:
            raise AdmissionError("count-only coordinates forbidden")
        if r["unknown"] and r["position_m"] is not None:
            raise AdmissionError("unknown region has position")
        if not isinstance(r["valid_until_ms"],int) or not isinstance(r["captured_at_ms"],int):
            raise AdmissionError("invalid region clock")
        if r["captured_at_ms"] > now_ms or r["captured_at_ms"] > r["valid_until_ms"]:
            raise AdmissionError("invalid region capture time")
        if now_ms > r["valid_until_ms"] and (r["count"] is not None or r["position_m"] is not None):
            raise AdmissionError("stale region still visible")
    unsigned = dict(manifest)
    unsigned["manifest_sha256"] = ""
    encoded = json.dumps(unsigned, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    digest = "sha256:" + hashlib.sha256(encoded).hexdigest()
    if digest != manifest["manifest_sha256"]:
        raise AdmissionError("conditioning manifest digest mismatch")
    if len(encoded)>96_000:
        raise AdmissionError("conditioning payload too large")

def verify_receipt(response, manifest):
    """Accept only labelled simulated metadata with exact source binding."""
    body = response.get("response", response) if isinstance(response,dict) else None
    if not isinstance(body,dict) or set(body)!={"simulated","snapshot_hash","manifest_sha256","media_sha256","media_bytes","media_type"}:
        raise ReceiptError("invalid media descriptor")
    if body["simulated"] is not True:
        raise ReceiptError("generated media must be simulated")
    if body["snapshot_hash"]!=manifest["snapshot_hash"] or body["manifest_sha256"]!=manifest["manifest_sha256"]:
        raise ReceiptError("source binding mismatch")
    if not isinstance(body["media_sha256"],str) or not MEDIA_HEX.fullmatch(body["media_sha256"]):
        raise ReceiptError("invalid media hash")
    if not isinstance(body["media_bytes"],int) or not 0<body["media_bytes"]<=512*1024*1024:
        raise ReceiptError("unbounded or absent media bytes")
    if body["media_type"]!="video/mp4":
        raise ReceiptError("unexpected media type")
    return body

class VastRealityClient:
    def __init__(self, *, endpoint, tenant, workspace, enable_remote=False, client_factory=None, clock_ms=None):
        if not ENDPOINT.fullmatch(endpoint):
            raise ValueError("invalid endpoint name")
        self.endpoint,self.tenant,self.workspace = endpoint,tenant,workspace
        self.enable_remote = enable_remote
        self.client_factory: Callable | None = client_factory
        self.clock_ms = clock_ms or (lambda: int(time.time()*1000))

    async def render(self, manifest, *, now_ms, max_age_ms=500):
        if not self.enable_remote:
            raise AdmissionError("remote GPU execution disabled")
        validate_manifest(manifest, tenant=self.tenant, workspace=self.workspace,
                          now_ms=now_ms, max_age_ms=max_age_ms)
        factory = self.client_factory
        if factory is None:
            if not os.environ.get("VAST_API_KEY"):
                raise AdmissionError("VAST_API_KEY must be supplied via worker secret manager")
            from vastai import Serverless
            factory = Serverless
        # Calls an EXISTING operator-approved endpoint only. Never creates workers
        # or manages autoscaling, keys, IAM, templates, or billing state.
        async with factory() as serverless:
            endpoint = await serverless.get_endpoint(self.endpoint)
            response = await asyncio.wait_for(endpoint.request("/v1/reality/render", {"manifest": manifest}), timeout=2.0)
        validate_manifest(manifest, tenant=self.tenant, workspace=self.workspace, now_ms=self.clock_ms(), max_age_ms=max_age_ms)
        return verify_receipt(response, manifest)
