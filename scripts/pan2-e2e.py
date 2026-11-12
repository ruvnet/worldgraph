"""Independent fixture-to-CLI-to-graph E2E. Does not execute PAN2 weights."""
import hashlib, json, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / "target/debug/examples/pan2_physical"

def main():
    with tempfile.TemporaryDirectory() as folder:
        d = pathlib.Path(folder)
        def write(name, data):
            p = d / name
            p.write_text(json.dumps(data))
            return p
        graph = {"schema_version":2,"registration":{"origin":{"lat":0.0,"lon":0.0,"alt":0.0},"heading_deg":0.0,"scale":1.0},"next_id":2,"next_edge_id":1,"nodes":[{"kind":"person_track","id":1,"track_id":7,"last_position":{"east_m":0.0,"north_m":0.0,"up_m":1.0},"reid_embedding_ref":"EXCLUDED-EMBEDDING"}],"edges":[]}
        context = {"source_epoch":3,"observed_at_ms":1000,"frame_id":"room-enu","calibration_id":"survey-1","action":"person moves toward entrance","horizon_ms":2000,"generation_seed":123,"bounds":{"min":[-5.0,-5.0,0.0],"max":[5.0,5.0,3.0]},"obstacles":[],"max_speed_mps":3.0,"privacy":{"projection_id":"authorized-tracks","hosted_processing_approved":False,"redactions_applied":1,"retention":"ephemeral"}}
        paths = [write("graph.json",graph),write("context.json",context),write("ids.json",[1])]
        before = paths[0].read_bytes()
        prepared = subprocess.run([str(BIN),"prepare",*map(str,paths)],check=True,capture_output=True,text=True)
        request = json.loads(prepared.stdout)
        assert "EXCLUDED" not in prepared.stdout
        response = {"schema_version":1,"request_sha256":request["request_sha256"],"model_sha256":"a"*64,"artifact_sha256":"b"*64,"extractor_version":"independent-fixture/1","frame_id":"room-enu","calibration_id":"survey-1","execution":"fixture","trajectories":[{"track_id":7,"points":[{"offset_ms":1000,"position_m":[1.0,0.0,1.0]},{"offset_ms":2000,"position_m":[2.0,0.0,1.0]}]}]}
        observations = {"request_sha256":request["request_sha256"],"frame_id":"room-enu","calibration_id":"survey-1","observed_at_ms":1000,"samples":[{"track_id":7,"offset_ms":1000,"position_m":[1.1,0.0,1.0]},{"track_id":7,"offset_ms":2000,"position_m":[1.9,0.0,1.0]}]}
        rp, op = write("response.json",response),write("observations.json",observations)
        args = [str(BIN),"replay",*map(str,paths),str(rp),str(op)]
        result = json.loads(subprocess.run(args,check=True,capture_output=True,text=True).stdout)
        assert not result["observed_state_changed"] and not result["automatic_promotion"]
        assert result["score"]["execution"] == "fixture"
        assert abs(result["score"]["forecast_rmse_m"]-0.1)<1e-10
        assert len(result["hypothesis_graph"]["nodes"]) == 2
        assert result["hypothesis_graph"]["nodes"][0]["last_position"]["east_m"] == 0.0
        response["request_sha256"] = "f"*64
        write("response.json",response)
        assert subprocess.run(args,capture_output=True).returncode != 0
        assert paths[0].read_bytes() == before
        print(json.dumps({"schema_version":1,"scope":"synthetic fixture CLI E2E, no PAN2 inference","projection":"passed","embedding_redaction":"passed","hypothesis_graph":"passed","source_graph_unchanged":"passed","stale_response_rejected":"passed","fixture_rmse_m":result["score"]["forecast_rmse_m"],"stationary_rmse_m":result["score"]["stationary_rmse_m"],"graph_input_sha256":hashlib.sha256(before).hexdigest()},indent=2))

if __name__ == "__main__": main()
