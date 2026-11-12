# PAN2 adapter optimization

This report measures synthetic CPU adapter work only, not model generation or physical forecasting quality.

Compared baseline b086554c11d4aebb81321cc5f880becd95e4ae39 with cached immutable request state, track indexes, conservative trajectory-envelope obstacle pruning, borrowed hypothesis serialization, and contiguous sorted observation lookup.

The original exact segment/box test remains the final collision check. A differential regression test compares the optimized validator with exhaustive segment checks across 200 deterministic trajectory cases. The Unix fixture verifies that cached wire bytes hash to the request digest.

Release-mode benchmark: three alternating process pairs; each process reports seven timed rounds after a warmup. The committed JSON retains process reports. Shared executor scheduling causes timing variation; these results do not establish production latency or statistical confidence intervals. The benchmark's obstacle layout is sparse relative to trajectories; densely intersecting envelopes can reduce pruning benefits.

| Stage, 64 tracks / 32 points / 128 boxes | Baseline ms | Optimized ms | Ratio |
| --- | ---: | ---: | ---: |
| Prepare | 0.151 | 0.176 | 1.16 times slower |
| Validate | 1.712 | 0.573 | 2.99 times faster |
| Build hypothesis graph | 1.621 | 0.723 | 2.24 times faster |
| Reconcile observations | 0.366 | 0.115 | 3.19 times faster |

Preparation adds roughly 24 microseconds in the larger fixture to build reusable caches. Those caches retain serialized request bytes, one track index, and immutable scene state via one shared Arc. No checks or size limits are relaxed. The small fixture also incurs setup cost (5.56 to 6.74 microseconds) while validation and branching improve. Hash retrieval timings are microbenchmarks of a cached string, not cryptographic acceleration.

Run the benchmark:

```sh
cargo run -p wifi-densepose-worldmodel --example pan2_physical_bench --release --locked
python3 scripts/pan2-bench-compare.py --baseline /path/to/baseline-bench --optimized /path/to/optimized-bench
```

Build both benchmark executables with the same example source, Rust toolchain and release flags; change only the library implementation. The baseline was built by substituting its original physical.rs in the isolated checkout, retaining identical dependency locks and benchmark code.

Validation passed after optimization: full workspace all-features locked tests, 24 worldmodel unit tests, 7 physical integration tests including 200 differential cases, 1 doctest, Clippy with warnings denied, and independent CLI fixture E2E. No learned model was invoked; live PAN2 and calibrated extraction remain pending.
