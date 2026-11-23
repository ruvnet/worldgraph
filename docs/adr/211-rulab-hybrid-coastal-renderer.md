# ADR 211: Hybrid scene rendering for RuLab Reality

Status: proposed, implementation in a review branch

Date: 2026-11-22, America/Toronto

## Decision

Use the existing pinned Three.js 0.185.1 and Spark 2.1.0 together. Gaussian splats provide an appearance layer. Meshes provide explicit surfaces, moving actors, material lighting and authored collision proxies. A separate display projection carries eligible evidence. WorldGraph owns stable synthetic identities and replay state in an isolated Rust WASM graph.

The new `rulab/hybrid.html` entry implements an original coastal scene inspired by the requested atmosphere. It is explicitly synthetic. It uses procedural geometry and authored Gaussians, with analytic motion. It does not reproduce a captured location, infer appearance from RF, invoke a trained world model or connect to a populated Cognitum Space.

## Why

The original 3D Gaussian Splatting method reconstructs appearance from calibrated image observations and optimizes a radiance representation for novel views [1]. Spark supports mixing splats and ordinary Three.js meshes; Gaussian animation is possible, so immobility is not the reason to choose meshes [2]. Meshes supply reusable animation and the conventional physically based material pipeline [3]. This is a good fit for editable vehicles, people, doors and geometry used for interaction.

The choice is architectural judgment, not a measured ranking of all rendering systems:

| Requirement | Splats alone | Meshes alone | Hybrid |
| --- | --- | --- | --- |
| Captured surface appearance | Strong | Requires reconstruction and textures | Strong |
| Editable actors and lighting | Possible, additional work | Strong | Strong |
| Collision geometry | Separate geometry still needed | Explicit | Explicit mesh proxies |
| Reuse current RuLab | Partial | Partial | Direct |
| Implementation complexity | Moderate | Lower | Higher |

Gaussian appearance is not metric or semantic authority. Generated pixels and authored splats cannot create observed entities or authorize access. A source hash checks integrity; it does not authenticate a source.

## Implementation

1. `src/hybrid/coast.ts` creates bounded local scenery, mesh actors, ocean shading and an authored Gaussian plume. Actor identities persist across camera movement and deterministic seeking. The red plume is static authored appearance, not a fluid model.
2. `src/hybrid/graph.ts` projects the synthetic scene into a separate actual Rust WASM graph with seven nodes and six relationships. Three.js coordinates `[x,y,z]` become ENU `[x,-z,y]`. Synthetic metadata and confidence zero remain explicit. The existing observed or laboratory graph is never accepted or mutated.
3. `src/hybrid/evidence.ts` validates a bounded display snapshot against a supplied context. Tenant, space, calibration, privacy epoch, scene registration, units, coordinate frame and freshness must match. An unlocated count, including zero, never becomes a person at a coordinate. Invalid global input clears the overlay; expired regions are omitted. This is display validation, not authentication or authorization.
4. `src/hybrid/main.ts` uses three independently controlled layers, an independent camera, reversible 120 second replay, synthetic evidence fault cases, measured frame intervals and JSON evidence export. Capture age and frame time are separate values. An export synchronizes the graph to the exported replay time.

No remote inference, GPU billing, raw sensor ingestion, cloud snapshot write, secret, production permission or dependency upgrade is introduced. The entry is included in the existing Vite build and linked from the laboratory.

## Resource and rendering boundaries

Authored Gaussian allocation is capped at 65,000. The scene stays in local metre coordinates. Pixel ratio is capped and adaptive; measurements are cleared when resolution, detail or visible layers change. The evidence record includes device renderer, buffer resolution, current configuration, raw frame intervals and source declaration. P95 at or below 33.3 ms is a proposed device acceptance target, not an asserted result. Software browser rendering does not establish physical GPU performance.

Spark documents 16 bytes per compact Gaussian and 32 bytes for extended encoding, before auxiliary buffers, spherical harmonics and other memory [4]. Transparent overdraw and screen resolution can dominate even below a nominal splat count budget [5]. Avoid interpreting file size or this scene's count as a complete memory estimate.

The existing bounded PLY, SPLAT and SPZ importer remains in the laboratory. RAD import stays disabled. Imported capture registration is not inferred by this change. The coastal page has no asset URL ingestion or network evidence interface.

Authored collision boxes bound keyboard movement using short translation steps and reject orbit camera endpoints inside geometry. This is exploratory camera protection, not a physics engine, navigation planner or a guarantee of continuous collision detection along an orbit.

## Alternatives and consequences

A mesh only scene remains a useful fallback and can be inspected by disabling Gaussian appearance. A splat only scene is useful for captured static appearance but adds work for physical interaction, lighting changes and editable actors. Neural video remains a separate asynchronous appearance or hypothetical rollout lane until its latency, source grounding and release controls are independently verified. This change does not couple the interactive camera to Vast.ai or PAN2 latency.

The hybrid approach adds two render paths and requires careful depth, transparency and resource management. Its benefit is that captured appearance can improve later without replacing stable IDs, replay, geometry or evidence rules. Photographic fidelity requires calibrated capture assets or materially richer authored content; increasing procedural splat count does not supply missing visual information.

## Acceptance

Run the fixed repository validation with `node bin/cli.js rulab verify`. The runner requires every gate; incomplete or failed gates remain unverified. For an installed system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its absolute path. Default CI behavior remains the pinned Playwright browser.

The additional browser acceptance loads `hybrid.html`, confirms WebGL2 plus real Rust graph readiness, toggles layers independently, moves the camera while paused, seeks away and back to the same actor state, and injects count only, expired source, registration mismatch and changed privacy epoch. A held synthetic feed must lose all eligible position markers after its TTL even while replay is paused. Desktop and mobile viewport screenshots and diagnostics must identify their actual rendering environment. A screenshot alone is not a performance or reconstruction test.

Rollback is removal of the coastal link and entry from the Vite build, or reversal of the branch. Existing laboratory, capture and simulated rollout interfaces are unchanged.

## Sources

1. Kerbl et al., 3D Gaussian Splatting, original project: https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/
2. Spark SplatMesh, animation and interaction API: https://sparkjs.dev/docs/splat-mesh/
3. Three.js MeshStandardMaterial: https://threejs.org/docs/pages/MeshStandardMaterial.html
4. Spark compact representation and LOD: https://sparkjs.dev/docs/lod-getting-started/
5. Spark performance guidance: https://sparkjs.dev/docs/performance/
6. Existing source baseline: WorldGraph commit `48465cc6e5c244f885ea652a89c138d5e58abd3e`, `rulab/README.md` and ADRs 205 through 208.
