# ADR 205: RuLab temporal Gaussian world

Status: implemented in source; release acceptance is determined by the recorded validation gates.

Date: 2026-09-06.

Related decisions: [ADR 200](ADR-200-wasm-bridge.md), [ADR 201](ADR-201-coordinate-frame.md), [ADR 204](ADR-204-rust-generative-world-model-runtime.md).

## Context

RuLab needs a customer demonstration in which a viewer can move through a laboratory, inspect persistent object identities, and replay an experiment independently of camera movement. The earlier visual prototype used panoramic imagery. The supplied laboratory references describe an architectural concept rather than a calibrated image set of one measured installation.

The implementation therefore needs checkable spatial geometry and temporal state. It must preserve the distinction between authored appearance, observed evidence, and model predictions. A visually convincing interface is useful for demonstrations, but it does not establish reconstruction accuracy, valid physics, or predictive world modeling.

## Decision

Implement a separate static application in `rulab` using Three.js 0.185.1, Spark 2.1.0, deterministic analytical motion, and the repository's actual Rust WorldGraph WASM bridge. Deploy the validated build to GitHub Pages. Keep experiment state local to the browser and exportable as versioned JSON.

The application uses 42,306 authored architectural Gaussians and 136 Gaussians attached to the articulated arm and AMR, for a default total of 42,442. The count comes from the deterministic construction loops; it is not a quality or performance benchmark. Surface kernels have anisotropic scale and three dimensional positions. Conventional meshes provide the architecture, robot structure, glass, metal, lighting response, and shadows.

The representation is hybrid because some surfaces benefit from splat appearance while articulated mechanics and material response require explicit geometry. The application integrates these layers but does not train appearance from the reference images.

## Interfaces and invariants

| Boundary | Input | Output | Invariant |
| --- | --- | --- | --- |
| Temporal model | Scenario, playhead, ordered commands | `WorldFrame` with six object states | Equal time and event history produce equal state, independent of prior frame cadence |
| Renderer | `WorldFrame`, independent camera, quality setting | Mesh and Gaussian visualization | Camera translation does not advance experiment time |
| Rust bridge | Validated authored frame | Typed graph and actual RVF JSON export | Stable identities and ENU coordinates survive updates and rewinds |
| Local import | Bounded asset or timeline file | Validated preview or restored experiment | Rejected input does not replace the accepted scene or timeline |
| Validation runner | Source checkout and fixed gates | Report, logs, artifact hashes | Missing or skipped required gates cannot produce complete validation |
| MCP | Bounded planning or evidence arguments | Plan or consistency result | No shell execution or deployment authority is implied by a tool response |

### Time and scenarios

`TimelineStore` represents a 120 second authored experiment. Its persistent objects are `robot-1`, `amr-1`, `drone-1`, `rf-door`, `sensor-1`, and `sensor-2`. Robotics, hospitality, and healthcare retain independent event branches and adjust analytical motion rates. Additional modular props distinguish the latter two scenarios visually.

An event sequence records edit order. Replay sorts by timestamp and then sequence, supporting edits made after rewinding. Pausing an agent integrates its active motion time so resuming continues from its stopped pose. Door opening uses a 1.2 second smooth transition with continuous reversals. All returned state is copied, so callers cannot mutate the authoritative timeline through object references.

JSON import requires the exact schema, three unique scenarios, supported action/entity pairs, finite timestamps, and monotonic safe integer sequences. Identical retransmissions are idempotent; conflicting identities are rejected. Limits are 1 MiB and 1,024 events per branch. The final safe integer sequence can be exported and imported; subsequent recording raises `RangeError` before mutation.

### Spatial frame

The application stores positions as `[East, North, Up]` metres and maps them into Three.js as `[East, Up, -North]`. Yaw zero points East, with positive pi/2 toward North.

The authored shell spans East from -12 to 12 m, North from -17 to 17 m, and an 11 m ceiling. The RF room spans East from 7.7 to 12 m and North from -0.2 to 6.2 m. Its door anchor is `[9,3,0]`.

The AMR follows a rounded rectangular route with a 0.55 m maximum body radius. Its path maintains at least 0.40 m separation from the authored robot exclusion envelope after accounting for the AMR radius. The drone remains at least 0.85 m above the authored robot height envelope. Navigation also uses coarse camera collision proxies with subdivided moves to avoid tunneling through thin obstacles.

These are authored envelope checks. They do not certify all rendered geometry, dynamic robot interaction, pedestrians, actual hardware, or radio propagation. There is no general rigid body solver or learned dynamics controller in this application.

### Rust WorldGraph projection

The browser dynamically loads the `wasm-pack --target web` output from `public/wasm`. Initialization errors are explicit and do not activate a JavaScript graph substitute.

Six physical entity nodes, two rooms, and six semantic provenance records produce 14 nodes. Fourteen stable relationships connect containment, provenance, and room adjacency. Repeated updates use fixed node and edge identities and suppress identical messages. Tests execute the compiled Rust binary, verify bounded graph size through replay, and compare the restored JSON snapshot exactly.

The current Rust schema has no articulated robot node. Robots, the AMR, and the drone use compatible `ObjectAnchor` pose projections. Associated `SemanticState` records retain their actual object kind, orientation, joints, scenario, and replay timestamp. Sensors use native `Sensor` nodes and the RF opening uses `Doorway`. This is an explicit adapter mapping, not a new native Rust dynamics schema.

Provenance labels the source as authored, uses `rulab-concept-enu-v1-not-surveyed` calibration, and declares synthetic data. The January 1, 2026 UTC replay epoch is synthetic. It is not a claim that equipment was observed at that time. Graph mode's visible links are authored diagnostics; the exported Rust snapshot carries the actual typed relationships.

## Import and deployment boundaries

Local PLY, SPLAT, and SPZ files are limited to 64 MiB and 500,000 decoded Gaussians. SPZ decompression is bounded to 96 MiB and versions 1 through 3. The preflight rejects unsupported PLY layouts and inconsistent sizes. Local RAD import remains disabled because its expanded memory requirements are not currently bounded by this importer.

Imported assets are normalized for viewing. They replace the default visual layer and hide authored entity overlays rather than asserting that the imported geometry shares the lab's metric frame. Spatial registration against measured anchors is future work. File data stays in the browser, and the static application has no upload endpoint or remote model credentials.

The workflow builds `rulab/dist` with `/worldgraph/` as the default Vite base. Pull requests validate; successful `main` pushes deploy through GitHub Actions Pages. Deployment permissions are confined to the deploy job. The existing stream service, demo source, and documentation continue independently, and the previous Sites deployment is unchanged.

## Harness and provenance

Run `node bin/cli.js rulab verify` from the repository root after installing the documented dependencies. The runner uses fixed executable arguments with `shell: false`. It records source commit, checkout dirtiness, each gate outcome, bounded logs, and hashes. Its gates cover harness tests, Rust tests, WASM compilation, TypeScript, unit tests, production build, and browser tests. `--without-browser` records a skipped required gate, marks the result incomplete, and returns a nonzero exit status.

`node bin/cli.js mcp start` exposes three bounded tools: `worldgraph_mission_plan`, `worldgraph_validation_plan`, and `worldgraph_evidence_validate`. These tools return plans or report consistency checks. They neither execute the plan nor independently attest reported execution. Reports must be matched to the clean source revision and retained CI artifacts.

This source declares npm package version 0.1.3. This change does not publish a registry release, and the npm package does not carry the complete Rust/browser source workspace. The source CLI is the reproducible command for the verification mission.

## Research comparison and extension path

Primary sources were checked September 6, 2026. The entries below solve different tasks; they do not form a common benchmark ranking.

| Approach | Evidence | Status in RuLab |
| --- | --- | --- |
| Spark 2.1 | Official release includes PLY compatibility updates, paged splat utilities, and rendering fixes. Spark integrates Gaussian objects with Three.js. [Release](https://github.com/sparkjsdev/spark/releases/tag/v2.1.0) | Implemented and pinned for browser rendering |
| Spark 2 streaming and deformation | Official documentation describes hierarchical detail, RAD streaming, covariance splats, and experimental skinning. [Documentation](https://sparkjs.dev/docs/new-features-2.0/) | Researched. This application does not implement streaming captures, general skinning, or local RAD import |
| Atlas | World Labs describes a pretrained multimodal model with camera conditioned generation, spatial reconstruction, explicit 3D outputs, and temporal reframing. The announcement offers early access. [Announcement](https://www.worldlabs.ai/blog/atlas) | Researched capability reference. No Atlas model, API integration, training, or inference is included |
| 4D Gaussian Splatting | The CVPR 2024 method learns time dependent Gaussian deformation using neural voxels and an MLP. [Paper](https://arxiv.org/abs/2310.08528) | Researched dynamic reconstruction baseline. The current analytical motion is not an implementation of learned 4DGS |

The strongest next experiment is to replace one authored bay with a calibrated capture while keeping identities and the replay protocol unchanged. Measure held out camera reconstruction error, object registration error, revisit consistency, memory use, and frame timing on named physical devices. Introduce a physics engine before claiming physical interaction fidelity, and a trained dynamics component before claiming predictive world modeling. A source model's published GPU benchmark must not be transferred to this browser implementation.

## Consequences and acceptance

The result gives a deployable customer demonstration with actual spatial parallax, controllable time, stable object identities, and inspectable Rust state. Its static deployment avoids operating a GPU inference service. The principal limitation is visual and physical fidelity: authored geometry and deterministic motion do not establish a reconstructed or predictive digital twin.

Physical GPU performance, reconstruction quality, and prediction accuracy are unmeasured. Device rendering evidence captures the current browser, viewport, and frame samples only. Software rendering in CI can establish functional behavior, but it cannot establish target frame rates on an iPhone or workstation GPU.

Acceptance requires a complete harness report for a clean source revision, actual WASM execution, browser evidence of Gaussian rendering and independent translation, mobile controls, bounded malformed imports, and reversible timeline state. The reproducible user test is to pause an agent, change the door state, export the experiment at 20 seconds, restore it, and compare entity states and the Rust snapshot at the same time. Changing the camera must reveal parallax while leaving those states unchanged.
