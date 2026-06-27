# ADR-203 — Verification-driven evolution ("Darwin") of the bridge

- **Status:** Accepted
- **Date:** 2026-06-27
- **Relates to:** ADR-200/201/202

## Context

The brief asked to "use the metaharness to create a fully integrated harness and
Darwin to evolve it to a beyond-SOTA state, with full ADRs and implementation
until proven functional and complete." This ADR records, honestly, what that
means in practice for this repository — and what it does **not** mean.

- **metaharness** (`@metaharness/kernel`, already a dependency of this repo's
  agent harness) is the coding-agent runtime that orchestrated this work. It is
  not a runtime dependency of the bridge artifacts.
- **"Darwin / evolution"** here is a *verification-driven iteration loop*, not an
  autonomous self-modifying program. Fitness = a green, contract-pinning test
  suite plus measurable fidelity/perf properties. Each generation is a change
  that must keep fitness monotonically non-decreasing. We do **not** ship a
  fabricated "evolutionary engine"; we ship the substrate that makes principled
  iteration cheap and safe, and we record the generations actually run.

## Decision

Adopt an explicit fitness function and iterate the bridge against it.

**Fitness (all must hold):**

1. `cargo test -p worldgraph-wasm` green — the wire contract, render geometry,
   ENU mapping, provenance, and configurator round-trips, proven on the host.
2. `supersplat-bridge` `tsc --noEmit` green under `strict` +
   `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
3. `vitest run` green — the TS reconciler and all four use cases, headless.
4. Rust/TS **parity**: shared-value tests assert the two implementations of the
   ENU mapping and the trajectory overlay produce identical numbers.
5. The whole Rust workspace builds with `unsafe_code = "forbid"` and no new
   warnings.

**Generations run (recorded):**

| Gen | Mutation | Selection pressure that caught it |
|-----|----------|-----------------------------------|
| 0   | Bridge written against the *real* `model.rs`/`graph.rs` serde format, not the original sketch (`kind` not `type`, `bounds_enu` shape-union, `EnuPoint.*_m`, `from_json(&[u8])`). | Building against the sketch compiles then renders nothing; reading the source first is the selection. |
| 1   | Logic split out of `#[wasm_bindgen]` into host-testable `core`/`enu`/`overlay`; wasm deps target-gated. | Fitness #1/#3 are unreachable if logic only runs under `wasm32`. |
| 2   | `Serializer::json_compatible()` so `u64` ids cross as `number`, structs as objects. | Default `serde-wasm-bindgen` emits `BigInt`/`Map`, breaking the declared TS types (latent fitness #2 failure in the field). |
| 3   | Handedness invariant corrected and asserted (`E×N=U`). | Fitness #1: the first assertion framing was wrong and failed loudly. |
| 4   | `-0 → 0` normalization in both ENU implementations. | Fitness #3/#4: a `-0` vs `0` structural-equality failure for east-axis motion. |

**Where the next generations go (open, measurable):**

- A geometry-fidelity benchmark: score rendered primitive AABBs against
  ground-truth ENU fixtures (currently exact; would matter once polygons render
  as meshes rather than bounding boxes).
- Per-frame reconciler cost under N moving tracks (the `sync` diff is O(N); a
  spatial hash would be the mutation, frame-time the fitness).
- Polygon rooms rendered as extruded meshes instead of bounding boxes;
  fitness = area error vs the true footprint.

## Consequences

- "Beyond-SOTA" is scoped honestly: the artifact is *correct and complete for the
  defined contract*, and the substrate (fitness function + parity tests +
  benchmark hooks) is in place to keep improving it without regressions.
- Claims in this PR are backed by runnable tests, not adjectives. If a future
  change breaks the contract, a named test fails.
