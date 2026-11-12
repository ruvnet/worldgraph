"""Alternate baseline/candidate adapter executables and retain process receipts."""
import argparse, json, pathlib, platform, statistics, subprocess

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline",required=True,type=pathlib.Path)
    parser.add_argument("--optimized",required=True,type=pathlib.Path)
    args = parser.parse_args()
    runs = {"baseline":[],"optimized":[]}
    for index in range(3):
        for label in (["baseline","optimized"] if index%2==0 else ["optimized","baseline"]):
            runs[label].append(json.loads(subprocess.check_output([str(getattr(args,label).resolve())],timeout=60)))
    cases = []
    for index in range(3):
        case = runs["baseline"][0]["cases"][index]
        stages = {}
        for stage in case["stages"]:
            values = {label:statistics.median(r["cases"][index]["stages"][stage]["median_us"] for r in runs[label]) for label in runs}
            stages[stage] = {"baseline_us":values["baseline"],"optimized_us":values["optimized"],"speedup":values["baseline"]/values["optimized"]}
        cases.append({key:case[key] for key in ("tracks","points_per_track","obstacles")} | {"stages":stages})
    print(json.dumps({"scope":"synthetic CPU adapter; no PAN2 inference", "method":"three alternating process pairs; median of seven warmed round medians per process", "architecture":platform.machine(),"cases":cases,"process_runs":runs},indent=2))

if __name__ == "__main__": main()
