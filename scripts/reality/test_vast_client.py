"""Mock-only contract checks. Never contacts Vast.ai."""
import copy
import hashlib
import json
import unittest

from vast_client import AdmissionError, ReceiptError, VastRealityClient, validate_manifest

def fixture():
    m = {
        "schema": "cognitum.reality.conditioning.v1",
        "tenant": "tenant", "workspace": "work", "site": "site", "space": "room",
        "snapshot_hash": "sha256:"+"a"*64, "calibration": "cal1",
        "privacy_epoch": 7, "stream_epoch": 2,
        "capture_ms": 1000, "presentation_ms": 1100,
        "origin": "replay", "purpose": "current_view",
        "hosted_processing_approved": True,
        "regions": [{
            "id": "p1", "evidence": "estimated", "count": None,
            "position_m": [1.0,2.0,0.0], "unknown": False,
            "captured_at_ms": 1000, "valid_until_ms": 1300,
        }],
        "manifest_sha256": "",
    }
    resign(m)
    return m

def resign(m):
    n = copy.deepcopy(m)
    n["manifest_sha256"] = ""
    m["manifest_sha256"] = "sha256:" + hashlib.sha256(
        json.dumps(n,separators=(",",":"),ensure_ascii=False).encode()
    ).hexdigest()

def receipt(m):
    return {"simulated":True, "snapshot_hash":m["snapshot_hash"],
            "manifest_sha256":m["manifest_sha256"],
            "media_sha256":"f"*64, "media_bytes":4096,"media_type":"video/mp4"}

class FakeEndpoint:
    def __init__(self, answer):
        self.answer=answer
        self.calls=[]
    async def request(self, path, payload):
        self.calls.append((path,payload))
        return {"response":self.answer}

class FakeSDK:
    def __init__(self, end):
        self.end=end
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        return None
    async def get_endpoint(self, name):
        if name!="reality_canary": raise AssertionError("unexpected endpoint")
        return self.end

class Contract(unittest.TestCase):
    def test_valid_fixture(self):
        validate_manifest(fixture(),tenant="tenant",workspace="work",now_ms=1100)
    def test_unauthorized_tenant(self):
        with self.assertRaises(AdmissionError):
            validate_manifest(fixture(),tenant="other",workspace="work",now_ms=1100)
    def test_blackout(self):
        with self.assertRaises(AdmissionError):
            validate_manifest(fixture(),tenant="tenant",workspace="work",now_ms=1700)
    def test_revoked_host_approval(self):
        m=fixture();m["hosted_processing_approved"]=False;resign(m)
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100)
    def test_mismatched_manifest_digest(self):
        m=fixture();m["calibration"]="changed"
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100)
    def test_raw_rf_rejected(self):
        m=fixture();m["raw_csi"]=[12,30]
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100)
    def test_unsupported_count_position(self):
        m=fixture();m["regions"][0]["evidence"]="count_only";m["regions"][0]["count"]=3;resign(m)
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100)
    def test_expired_region_must_be_unknown(self):
        m=fixture();resign(m)
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1400)
        m["regions"][0]["unknown"]=True;m["regions"][0]["position_m"]=None;resign(m)
        validate_manifest(m,tenant="tenant",workspace="work",now_ms=1400)
    def test_synthetic_current_rejected(self):
        m=fixture();m["origin"]="synthetic";resign(m)
        with self.assertRaises(AdmissionError):
            validate_manifest(m,tenant="tenant",workspace="work",now_ms=1100)

class Remote(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_is_a_noop(self):
        m=fixture();end=FakeEndpoint(receipt(m))
        c=VastRealityClient(endpoint="reality_canary",tenant="tenant",workspace="work",
                            enable_remote=False,clock_ms=lambda:1100,client_factory=lambda:FakeSDK(end))
        with self.assertRaises(AdmissionError):
            await c.render(m,now_ms=1100)
        self.assertEqual(end.calls,[])
    async def test_mock_sdk_success(self):
        m=fixture();end=FakeEndpoint(receipt(m))
        c=VastRealityClient(endpoint="reality_canary",tenant="tenant",workspace="work",
                            enable_remote=True,clock_ms=lambda:1100,client_factory=lambda:FakeSDK(end))
        result=await c.render(m,now_ms=1100)
        self.assertEqual(result["media_bytes"],4096)
        self.assertEqual(end.calls[0][0],"/v1/reality/render")
    async def test_changed_source_rejected(self):
        m=fixture();bad=receipt(m);bad["snapshot_hash"]="sha256:"+"b"*64
        end=FakeEndpoint(bad)
        c=VastRealityClient(endpoint="reality_canary",tenant="tenant",workspace="work",
                            enable_remote=True,clock_ms=lambda:1100,client_factory=lambda:FakeSDK(end))
        with self.assertRaises(ReceiptError):
            await c.render(m,now_ms=1100)
    async def test_refuses_injected_media_bytes(self):
        m=fixture();bad=receipt(m);bad["video_base64"]="secret"
        end=FakeEndpoint(bad)
        c=VastRealityClient(endpoint="reality_canary",tenant="tenant",workspace="work",
                            enable_remote=True,clock_ms=lambda:1100,client_factory=lambda:FakeSDK(end))
        with self.assertRaises(ReceiptError):
            await c.render(m,now_ms=1100)

    async def test_late_response_expires(self):
        m=fixture();end=FakeEndpoint(receipt(m))
        c=VastRealityClient(endpoint="reality_canary",tenant="tenant",workspace="work",
                            enable_remote=True,clock_ms=lambda:1800,client_factory=lambda:FakeSDK(end))
        with self.assertRaises(AdmissionError):
            await c.render(m,now_ms=1100)

if __name__ == "__main__":
    unittest.main()
