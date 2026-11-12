# PAN 2 rollout run record

Measured on 2026-11-11 for [ADR 208](../adr/208-pan2-simulated-rollout-provider.md). Everything here was observed in this work; anything not listed was not measured. These are single runs on one configuration, not a benchmark.

## Setup

- GPU host: one NVIDIA H200 NVL on vast.ai, listed at $4.097 per hour.
- Upstream commit `0fb907b6e16a82ead6d691d1de2eef6299c71e9a`, weights revision `a7936f7bea20ec3b9de809583712b40693071819`, the released sampler settings (50 steps).
- Each clip is a separate `generate.py` process, so every time below includes loading the model.

## Clips produced

Resolution, frame rate and duration were read back from each file with `ffprobe`.

| Clip | Frames | Duration | Size |
| --- | --- | --- | --- |
| `probe-2s` | 49 | 2.04 s | 207,429 B |
| `rf-door` | 121 | 5.04 s | 1,081,380 B |
| `rover-aisle` | 121 | 5.04 s | 455,591 B |
| `spaces-warehouse-amr` | 481 | 20.04 s | 2,678,780 B |
| `spaces-office-arrival` | 481 | 20.04 s | 1,793,246 B |
| `spaces-frost-line` | 481 | 20.04 s | 4,261,489 B |

All are H.264, `yuv420p`, 1248 wide by 704 high, 24 frames per second. Each passed `pan2-rollout verify`: the clip's SHA-256 and size match the bundle, and the caption the worker rendered is byte-identical to the one compiled locally.

## Generation time

| Clip length | Wall time, model load included |
| --- | --- |
| 20 s (`spaces-frost-line`) | 2,361 s |
| 20 s (`spaces-warehouse-amr`) | 2,401 s |
| 20 s (`spaces-office-arrival`) | 2,374 s |

At the listed rate, 2,374 s is about $2.70 of GPU time per 20 s clip. Timings for the 2 s and 5 s clips were not kept in a log that survived, so none is quoted.

## Software checks

- `cargo test -p worldgraph-pan2 --all-features`: 37 tests pass (29 library unit tests, 1 in the `pan2-rollout` binary, 7 end-to-end over a real Unix socket with the renderer faked; no doc tests). `clippy -D warnings` and `cargo fmt --check` are clean.
- The Rust canonical-JSON hash reproduces, byte for byte, a fixture produced by the TypeScript implementation in the Spaces API (`tests/fixtures/spaces-canonical.json`).
- Cross-repository run against the Spaces API handler on the Firestore emulator (not production): the handler served a snapshot of a seeded space, `pan2-rollout from-spaces` recomputed and accepted the server's `snapshotHash`, and the plan carried it. A simulation body built by `pan2-rollout accept` from the real warehouse rollout was accepted with 201, stored as simulated with confidence 0, read back with its clip hash intact, replayed on retry, and left the snapshot hash unchanged.

## Not measured or not done

- No rollout was sent to production Spaces, and the Spaces API changes in `cognitum-one/api` (ADR-107) are on a local branch: not merged, not deployed, no Firestore index applied.
- The Firestore emulator does not enforce composite indexes, so index behaviour is unverified.
- The token count of compiled captions was not measured with the Qwen3.5 tokenizer.
- No comparison against other video models was run.
- The simulation in the cross-repository run carries the source-snapshot hash of the earlier local snapshot the clip was generated from, not the hash of the emulator snapshot. It proves transport and validation, not that the clip depicts that snapshot.
