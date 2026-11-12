# PAN2 physical hypothesis integration evidence

Scope: public ruvnet/worldgraph Rust worldmodel API, local structured IPC, CLI and graph reconciliation. No renderer or actuator change.

## Requirements and evidence

| Requirement | Executed check |
| --- | --- |
| Selected positions only; no re-ID embeddings sent | Rust projection test and independent Python CLI preparation |
| Bind predictions to exact action, frame, calibration and source | Invalid prediction matrix and stale response CLI check |
| Preserve measured state | Byte-identical source graph and unchanged PersonTrack in hypothesis graph |
| Keep predictions auditable | Graph JSON roundtrip with SemanticProvenance and DerivedFrom edge |
| Reject impossible coarse trajectories | Bounds, speed and segment/AABB tunnelling tests |
| Avoid biased partial measurement scoring | Missing, duplicate and misaligned observation tests |
| Bounded external IPC | Actual Unix fixture worker; oversized, unterminated and malformed responses reject |
| Abort safely | Cancellation and timeout tests |
| Provider admission | PAN2 kind, terms acknowledgement and configured local weight path checks |

## Executed on ruOS Software Factory

Rust 1.90.0, ordinary user build in an isolated checkout. Source base: 0908d4773a6f7005516133d9a81bf5417abfbbbd.

Commands passed:

```sh
cargo test -p wifi-densepose-worldmodel --locked
cargo clippy -p wifi-densepose-worldmodel --all-targets --no-deps --locked -- -D warnings
cargo build -p wifi-densepose-worldmodel --example pan2_physical --locked
python3 scripts/pan2-e2e.py
node --test bin/harness.test.js
```

Worldmodel: 24 existing unit tests, 6 new integration tests and 1 doctest passed. Harness: 23 passed.

Independent CLI fixture report: projection, embedding exclusion, hypothesis graph, source immutability and stale response rejection passed. Synthetic position RMSE was 0.10000000000000009 m versus 1.5524174696260025 m for a stationary fixture baseline. Those values are assertions about a hand-authored fixture, not measurements of PAN2 prediction accuracy.

Tested physical.rs SHA256: 6eec1cc41c38e7cf40cf5731f7481434daf2508e46fe8f54fac5bfb43564b802.
Tested integration-test SHA256: 413a6ce69890addd04081e15ccb842ef1ab413b722b636d6d511142528fc8fa2.
Dependency lock SHA256: afaccb1ca153b486dde7b9978fa8b754240c595b194f882b602d41e68e8ed495.

## Remaining live gate

A separately installed PAN2 worker, complete weights, CUDA executor and calibrated metric extractor are required. The adapter does not implement that extractor. No live PAN2 inference, rigid-body dynamics, calibrated probability, latency improvement or physical forecasting gain has been established. Artifact/model hashes and execution mode are executor claims, not attestations.

Review request privacy scopes, socket permissions, image-to-metric calibration, checkpoint attribution and retention before live use. Perform a current dependency advisory scan before release.

Full workspace regression result is recorded in the PR once the executor completes it. No package publication, merge or public endpoint deployment is part of this change.
