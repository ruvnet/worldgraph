# Hybrid coastal renderer validation

Recorded: November 22, 2026, America/Toronto.

## Result

The synthetic hybrid renderer passes focused functional acceptance. Gaussian appearance, explicit mesh geometry, independently controlled evidence and an actual Rust WASM graph work together. This validates the rendering architecture and state boundaries. It does not establish photographic reconstruction, a learned predictive world model, live Cognitum Spaces integration or physical GPU performance.

Source under browser test: `9b260930585078b5f81525c7206b6ffcc1129e01`.

Runtime source: `d8f91e4c42e7750a2b1e26c1841f44c262b04444`. The subsequent commit changes only the final browser test measurement configuration. The hosted preview was built from this runtime source. Its source manifest retains asset hashes. The preview and ruOS build use the same application source; no claim of identical compiled WASM bytes is made across their Rust toolchains.

Decision: [ADR 211](../adr/211-rulab-hybrid-coastal-renderer.md).

Machine readable evidence: [rulab-hybrid-evidence-20261122.json](rulab-hybrid-evidence-20261122.json).

## Functional verification

1. TypeScript checking passed.
2. All 212 RuLab unit and integration tests passed. This includes 69 hybrid tests: 48 evidence cases, 17 graph cases and four coastal scene cases. The graph tests include execution of the actual Rust WASM module.
3. All 24 harness tests passed.
4. The production Vite build passed. The approximately 5.49 MB shared JavaScript chunk still warrants attention for first load performance.
5. Two Playwright browser acceptance runs passed on ruOS: one scenario each in desktop Chromium and a mobile viewport profile. Both recorded zero page errors. A mobile viewport is not a physical mobile device test.
6. The general GitHub CI workflow passed all five jobs at the tested commit, including full Rust workspace tests, Clippy, browser to stream to WASM integration, harness, bridge and container builds: https://github.com/ruvnet/worldgraph/actions/runs/45091151686
7. The separate fixed RuLab release workflow was still running at recording: https://github.com/ruvnet/worldgraph/actions/runs/45091151551 . The draft PR is not represented as release ready.

The broader local Rust attempt stopped at two unchanged sidecar tests because the local runtime denied Unix socket creation. It had 55 passing tests before those failures. The independent GitHub Rust CI job subsequently passed. Local Chromium was likewise unavailable because of sandbox socket restrictions; the authorized ruOS environment supplied actual browser acceptance.

## What browser acceptance establishes

The browser loaded WebGL2 and the Rust graph with seven synthetic nodes, six relationships and three stable actor identities. The tests independently toggled Gaussian, mesh and evidence layers. Seeking from 23.5 seconds to 71.2 seconds and back restored both actor state and the complete graph. Moving the camera while paused preserved that state.

A count of three without positions produced zero position markers. Expired input, mismatched registration and changed privacy epoch cleared eligible evidence. Holding the located synthetic feed removed markers after the TTL even while replay remained paused. Both viewport profiles remained within the horizontal layout boundary. Export synchronizes graph state to replay time.

The evidence validator accepts a context supplied by a future trusted integration. Matching fields and hashes do not authenticate a sender or grant authorization. The demo connects to no sensors, populated Space or inference service.

## Measured performance limits

The renderer was ANGLE over SwiftShader software Vulkan. Both samples used the Performance setting at pixel ratio 0.35, with shadows and environment lighting disabled, 39,980 authored Gaussians and 60 draw calls.

Desktop viewport: 1440 by 1000. Render buffer: 503 by 350. Across 21 recorded frame intervals, measured average rate was 1.035 FPS and P95 frame interval was 2433.4 milliseconds.

Mobile viewport: 412 by 839. Render buffer: 144 by 293. Across 20 recorded frame intervals, measured average rate was 1.502 FPS and P95 frame interval was 1066.6 milliseconds.

These small samples came from automated interaction, not a stationary benchmark. They demonstrate functional rendering under software execution and clearly do not satisfy the 30 FPS target. They cannot predict physical GPU performance. Raw intervals, receipt hashes and screenshot hashes are retained in the JSON evidence.

The first desktop run hit a race when adaptive resolution reset the frame sample window between polling and final capture. The final test selects a fixed Performance profile before sampling. Both profiles then passed.

## Fidelity and remaining work

The coastal scene is authored and synthetic. Its red Gaussian smoke is a static appearance feature, not a fluid simulation. Actors follow deterministic analytic trajectories, not learned predictions. Camera collision boxes provide limited exploratory protection, not full physics or continuous orbit collision guarantees.

Photographic fidelity requires calibrated captures or richer authored assets. Additional procedural Gaussians alone do not supply missing textures or appearance evidence. The intended production architecture can replace background appearance without replacing actor identities, interaction geometry or evidence rules.

The next hardware acceptance should use the actual supported device and a fixed 1280 by 720 render buffer, after warmup, with at least 60 seconds of recorded raw intervals. Record P50 and P95 frame time, renderer, resolution, visible layers and memory telemetry if available. The initial proposal is P95 at or below 33.3 milliseconds while camera motion, replay and evidence expiry continue to pass. Latency from actual sensor capture must be measured separately once a live source is integrated.

No paid GPU worker, model download, hosted inference endpoint or production Spaces write was created by this implementation. PAN2 and Vast.ai remain separate asynchronous workstreams.

## Reproduction

Use the repository's fixed gate for promotion:

```sh
node bin/cli.js rulab verify
```

For focused browser acceptance after building the actual Rust WASM bundle and installing the pinned dependencies:

```sh
npm --prefix rulab run test:e2e -- tests/hybrid.spec.ts
```

An installed compatible Chromium may be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; default CI uses its pinned Playwright browser. Screenshots alone are not an acceptance test for performance, geometry or sensing.
