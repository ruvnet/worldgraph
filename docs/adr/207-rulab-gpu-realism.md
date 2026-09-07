# ADR 207: GPU realism without changing the published Explorer

Status: implemented on an unpublished review branch. Hardware acceptance pending.

## Specification

Inputs: existing RuLab meshes, Gaussian appearances, deterministic events, and CC0 photographic assets. Output: a browser GPU renderer with improved surfaces, HDR illumination, selectable effects, and configuration specific evidence. Assumption: supplied concept images are not a calibrated scan. Constraint: do not merge or deploy; the current Explorer and GitHub Pages remain unchanged.

The business goal is a more credible interactive customer demonstration that retains inspectable WorldGraph identity and replay. No paid GPU infrastructure or credentials are needed for this rendering tier. No reconstruction accuracy, learned dynamics, or hardware speed claim is authorized by passing software renderer tests.

## Architecture and decision

Keep pinned Three.js and Spark. Use photographic diffuse, linear roughness and normal maps, HDR image based lighting, ACES output and FXAA. Only explicit Quality enables bloom and a 512 by 512 mesh reflection target. Exclude Spark and Gaussian meshes from the secondary camera so main camera sorting remains coherent. Imported captures use their original appearance; the authored floor and its reflection are hidden.

Performance uses direct rendering without shadows or postprocessing. Adaptive begins at at most 1.25 pixel ratio and changes resolution only after measured windows, with 18 ms and 33.3 ms thresholds. Quality is capped at 1.85 ratio. Drawing buffers are independently bounded to 4 million pixels in Quality, 2 million in Adaptive and 1 million in Performance so a large monitor cannot allocate unbounded HDR targets. Floating point rendering support gates the postprocessing pipeline and reflections. Exposure is bounded from 0.4 to 2.0. Photographic maps total under 4 MiB compressed; decoded texture and render target memory is additional.

Alternatives: replacing WebGL with WebGPU would require a separate compatible splat path and regression work. Remote Unreal streaming needs GPU servers, encoding, session management and latency testing. Neither is necessary to deliver this browser improvement. A reconstructed Gaussian facility is a separate asset production task needing overlapping multi view capture or an explicitly synthetic generative service.

## Control flow and invariants

1. Initialize current geometry and a fallback environment. Expose unavailable GPU state without pretending the reference image is rendered geometry.
2. Load only fixed same origin photographic assets. Each successful map replaces its matching authored material slot; missing files retain the fallback. Dispose late loads if the view is gone.
3. Configure bounded rendering effects. Render the main camera; optional mesh reflection uses a secondary camera with Gaussian rendering excluded and visibility restored in a finally block.
4. A quality, exposure, environment or resolution change clears the measurement sample set. WorldGraph and event state do not change.
5. Imports continue through the existing byte and Gaussian limits, provenance checks and transactional playback. Renderer disposal releases targets, textures, passes and listeners.

Success case: choose Quality, change exposure, inspect robots, seek to 24 seconds and export exactly the same graph as before the graphics change. Failure case: return 404 for all photographic assets; navigation and Rust replay still work with authored fallback materials.

## Acceptance and evidence

Unit tests: budget limits, HDR gating, adaptive hysteresis, exact asset hashes. Browser suite: photographic maps and HDR ready, quality and exposure controls, graph equality across settings, screenshot output, missing asset fallback, existing capture/import/context loss/mobile tests. Typecheck and production build remain mandatory.

CI Chromium uses SwiftShader and proves execution and interaction, not physical GPU throughput. Hardware acceptance: on the target phone and desktop, warm the scene, choose a fixed profile, start a fresh measurement, walk for 60 seconds, then export evidence. Require at least 300 samples, no context loss, no visible reflection artifacts and p95 frame time at most 33.3 ms for a 30 FPS target. If it fails, use Performance and reduce asset/pixel budgets before enabling effects by default.

## Rollback and limits

Do not merge this branch while no publication remains the instruction. Removing the PR changes restores the preceding renderer. No hosted configuration is modified. Baked splats do not acquire physically correct relighting from an HDR environment; all facility geometry remains authored. Reflections include meshes, not Gaussian objects, and are approximate polished floor reflections rather than full global illumination.

References: https://threejs.org/docs/pages/Reflector.html ; https://threejs.org/docs/pages/WebGLRenderTarget.html ; https://sparkjs.dev/docs/new-features-2.0/ ; https://polyhaven.com/license
