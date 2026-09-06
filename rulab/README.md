# RuLab: a spatial experiment you can replay

RuLab brings an interactive laboratory into WorldGraph. Move independently through a three dimensional space, pause a robot, open the RF chamber, scrub a 120 second experiment, and restore the same object states from an exported timeline.

The default scene contains **42,442 authored Gaussian primitives** alongside physically based Three.js architecture. This is an authored spatial demonstration with real Gaussian rendering and real Rust WorldGraph execution. It does not reconstruct the reference images, run a trained predictive world model, or control physical equipment.

The public build targets [WorldGraph on GitHub Pages](https://ruvnet.github.io/worldgraph/). The validation workflow retains its build and evidence artifacts. Automatic deployment currently fails before its job steps; verified artifacts can be published from the `gh-pages` branch without changing environment protections. Check [release metadata](https://ruvnet.github.io/worldgraph/release.json) for the deployed source and evidence. See [ADR 205](../docs/adr/205-rulab-temporal-gaussian-world.md) for the design decision, research comparisons, and acceptance boundaries.

## What runs

| Component | Implementation |
| --- | --- |
| Appearance | Spark 2.1.0 with 42,306 architectural Gaussians and 136 Gaussians attached to moving objects; Three.js 0.185.1 materials, lighting, and shadows |
| Navigation | Camera translation, yaw, pitch, roll, camera presets, pointer input, mobile movement controls, and authored collision proxies |
| Experiment | Six persistent identities: robot, AMR, drone, RF door, UWB anchor, and WiFi CSI sensor |
| Time | Analytical motion over 120 seconds; reversible seeking; pause/resume events; continuous door opening and closing |
| Scenarios | Robotics, hospitality, and healthcare with independent event histories and different motion rates; hospitality and healthcare also add modular room props |
| WorldGraph | The repository's compiled Rust WASM bridge; 14 nodes and 14 stable relationships; ENU coordinates and explicit authored provenance |
| Imports | Local PLY, SPLAT, and SPZ preview; time-indexed capture bundles with SHA-256 verification; experiment JSON import and export |
| Capture graph | Two Rust semantic nodes and one derived-from edge record the manifest, declared source, requested time, displayed sample and verified file hash; registration remains unverified |
| Evidence | Device frame samples, Rust snapshot export, and a fixed CLI validation harness with source identity and hashed logs |

The Graph view shows entity markers and authored relationship/trajectory diagnostics. Inspect the exported Rust snapshot for the actual typed graph relationships. The six scene objects are distinct from the 14 graph nodes, which also include rooms and provenance records.

## Run locally

Requirements: Node.js 22.13 or newer, npm, a stable Rust toolchain, Bash, and `wasm-pack` 0.14.0. Use a browser with WebGL2 and WebAssembly for the complete visual experience.

From a source checkout:

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.14.0 --locked
cd rulab
npm ci
npm run build:wasm
npm run dev
```

Open [the local RuLab page](http://localhost:4173/worldgraph/). The default base path is `/worldgraph/` for the repository's project Pages site. For a different host path, set `WORLDGRAPH_BASE_PATH` before starting Vite or building:

```sh
WORLDGRAPH_BASE_PATH=/ npm run dev
```

For a static production preview, run these commands from `rulab` after the WASM build:

```sh
npm run build
npm run preview
```

`npm run build` generates `rulab/dist`; it does not compile the Rust module implicitly. `npm run build:wasm` writes the actual browser module to `rulab/public/wasm`. Release optimization is enabled, while the optional Binaryen optimization step is disabled by default to avoid an additional binary download.

## Controls

| Action | Control |
| --- | --- |
| Move | Focus the scene, then use W/A/S/D or arrow keys; hold Shift for faster movement |
| Rise or descend | E / Q |
| Roll camera | Z / X |
| Look around | Drag with one pointer |
| Change field of view | Mouse wheel or pinch |
| Touch movement | Use the movement buttons; two pointers also pan |
| Inspect an object | Select it in the scene or Objects list |
| Follow a viewpoint | Overview, Robot, Flight, or RF bay presets |
| Replay | Play/Pause, speed selector, timeline slider, and restart |
| Change the experiment | Open/close the RF door or pause/resume an individual moving agent |
| Save or restore | Experiment export/import buttons in the transport |
| Inspect evidence | About dialog: export WorldGraph snapshot or rendering evidence |

Camera movement is independent of experiment time. Switching scenarios resets the playhead to zero while preserving each scenario's edits. Restart rewinds the existing event history. It does not erase edits.

## Bring a Gaussian capture

Choose **Open splat** to preview a local asset. Files stay in the browser; this demo has no upload endpoint, API key, or remote inference service.

| Boundary | Limit |
| --- | --- |
| Input file | 16 bytes to 64 MiB |
| Decoded scene | At most 500,000 Gaussians |
| Expanded SPZ | At most 96 MiB; versions 1 through 3 |
| PLY | Bounded header and scalar properties; unsupported or ambiguous layouts rejected |
| Experiment JSON | At most 1 MiB and 1,024 events per scenario |

Local RAD import is deliberately disabled because the current importer cannot enforce a reliable expanded data bound. Spark supports more formats than this application exposes.

Imported appearance replaces the default visual scene and hides the authored object overlays. Its bounds are normalized for preview; it is **not metrically aligned** with the RuLab graph. The authored inspector is hidden while imported appearance is displayed. Select an environment to restore the authored scene. Even within the import limits, decoded CPU and GPU allocations can exceed the file size, so physical device memory remains a practical constraint.

## Play a time-indexed capture

Choose **4D capture → Try synthetic 4D example**. The included 365,337-byte bundle contains four Gaussian samples of a moving robot rig. Pause playback, move the camera, and scrub between frames. The inspector distinguishes the requested time from the sample actually displayed. Export its separate Rust capture graph to inspect provenance. Select an environment to return to the original lab.

To bring your own sequence, select **capture.json and every referenced frame file together**. See the [example manifest](public/capture-example/capture.json) and [capture contract](../docs/adr/206-rulab-capture-playback.md). The bundle uses a shared right-handed, Y-up coordinate system; one display transform is retained across all frames. Independently reconstructed frames must already be registered to each other. This player does not infer that registration.

Limits are 64 KiB for the manifest, 240 frames, 120 seconds, 64 MiB per frame and 256 MiB total. Filenames are flat and local; manifests cannot fetch URLs or extract archives. Each frame must pass SHA-256 integrity checks, format preflight and decoded bounds validation. One decode runs at a time, superseded requests are discarded, and the last accepted scene stays visible on loading or failure. Retry is explicit. Source declarations, metric scale, registration and reconstruction accuracy remain unverified even when a hash matches.

The sample is generated by `node scripts/create-capture-example.mjs`. It is synthetic Gaussian geometry, not a reconstruction of the concept images or a trained 4D world model. Playback selects samples without motion interpolation or future prediction. A trained reconstruction and calibrated capture pipeline can produce compatible bundles later.

## Harness and MCP

Install browser dependencies once from `rulab`:

```sh
npx --no-install playwright install --with-deps chromium
```

Then run the complete validation mission from the repository root:

```sh
node bin/cli.js rulab verify
```

The fixed gates run harness tests, Rust workspace tests, WASM compilation, TypeScript checks, browser unit tests, a production build, and browser tests. Reports and hashed logs are written under `.artifacts/rulab/`. The report records its source commit and whether the checkout was dirty.

```sh
node bin/cli.js rulab verify --report .artifacts/rulab/review.json
node bin/cli.js rulab verify --without-browser
```

The second command intentionally leaves validation incomplete and exits unsuccessfully. A skipped browser gate never counts as a pass. For focused temporal verification, run `npx vitest run src/world` from `rulab`; the integration test loads the actual compiled Rust WASM binary and fails if it is absent.

Start the MCP server from this source checkout:

```sh
node bin/cli.js mcp start
```

| MCP tool | Result |
| --- | --- |
| `worldgraph_mission_plan` | Bounded implementation plan with inputs, outputs, assumptions, and invariants |
| `worldgraph_validation_plan` | Fixed validation commands and required gates |
| `worldgraph_evidence_validate` | Structural and internal consistency checks on a supplied report |

These tools do not execute commands, spawn agents, change files, or publish. Report consistency checking does not independently prove the reported execution. Match the report's hashes and source commit against retained CI artifacts.

The source package declares `worldgraphs` version 0.1.3. This change does not publish that npm version. Use the source commands above until the version is released; an installed npm harness does not include the Rust/browser workspace required by `rulab verify`.

## Deployment and acceptance

[The RuLab workflow](../.github/workflows/rulab.yml) validates pull requests and uploads evidence. The configured `main` deployment job targets GitHub Actions Pages with the `/worldgraph/` base path. Its current pre-step failure requires administrator inspection; see [capture delivery review](../docs/mission/rulab-capture-review.md). Repository Pages settings must select GitHub Actions as the source. The earlier Sites prototype is a separate deployment and is not changed by this build. The existing stream service and its demo source remain separate.

Physical mobile GPU performance, reconstruction quality, and prediction accuracy are unmeasured. Frame samples report the current device and scene only. They do not establish 30 or 60 FPS on other devices, nor do software rendered browser tests establish physical GPU performance.

Acceptance test: play to 10 seconds, pause the AMR, open the RF door, advance to 20 seconds, then export the experiment and Rust graph. Restore the experiment and seek to 20 seconds. Object identities, poses, door state, and the Rust graph snapshot must match. Translate the camera while time is paused and confirm actual spatial parallax. Run `node bin/cli.js rulab verify` on the same clean commit and retain its complete report.
