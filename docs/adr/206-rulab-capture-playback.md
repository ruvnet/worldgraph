# ADR 206: RuLab time-indexed capture playback

Status: implemented and independently reviewed in source on `feat/rulab-capture-playback`; complete CI and hosted capture-playback acceptance are pending.

Date: 2026-09-06.

Related: [ADR 205](205-rulab-temporal-gaussian-world.md), [coordinate frame](ADR-201-coordinate-frame.md), [capture review](../mission/rulab-capture-review.md).

## Decision and scope

Add a local capture bundle containing a manifest and discrete Gaussian appearance samples. The viewer selects an actual sample by time while camera motion remains independent. A changing sample can change Gaussian positions, shape, colour, opacity, and count. Playback is piecewise constant: the latest sample at or before the requested time is displayed. It does not interpolate missing frames, infer identities, run a reconstruction model, or forecast future states.

The four bundled frames are synthetic fixtures. They demonstrate a working temporal asset path, not a scan of RuLab. A user-provided `observed` or `reconstructed` label is retained as an unverified source claim. Neither that label nor a matching SHA-256 proves camera calibration, capture authenticity, metric scale, reconstruction accuracy, or object tracking.

The authored experiment, a single-file Gaussian preview, and a temporal capture are distinct application modes. Capture mode must not expose the authored robots or sensor relationships as measurements of an imported scene.

## Capture bundle version 1

Select the manifest named exactly `capture.json` and every frame it names in one local multi-file selection. A bundle is not a ZIP archive, directory traversal request, URL list, remote inference request, or upload. Frame filenames are flat, case-sensitive ASCII names. The selected set must match the manifest exactly; extra or missing files are rejected. Names that collide ignoring case are rejected.

The exact object shapes are `CaptureManifest`, `CaptureFrame`, and `CaptureBundle` in [`rulab/src/capture/types.ts`](../../rulab/src/capture/types.ts). Unknown object fields and duplicate JSON keys, including escaped aliases of the same key, are rejected by the parser.

| Manifest field | Version 1 requirement |
| --- | --- |
| `format` | Exactly `worldgraph.rulab.capture` |
| `version` | Integer value `1` |
| `name` | 1–120 characters, trimmed, nonempty, without ASCII control characters |
| `source` | `synthetic`, `observed`, or `reconstructed`; an unverified source claim |
| `coordinateSystem` | Exactly `right-handed-y-up` |
| `units` | Exactly `metres`; declared input units, not a verified survey |
| `duration` | Finite seconds, greater than zero and at most 120 |
| `bounds` | Exactly `{ "min": [x,y,z], "max": [x,y,z] }`; three finite values each, absolute coordinate at most 10,000, ordered bounds with nonzero extent |
| `frames` | 1–240 objects, each containing exactly `time`, `file`, and `sha256` |
| `frames[].time` | Finite seconds; first frame at zero, strictly increasing, at most `duration`; the endpoint is inclusive |
| `frames[].file` | At most 128 characters; flat PLY, SPLAT, or SPZ filename; starts with an ASCII letter or digit and uses letters, digits, underscore, hyphen, or separated dot components |
| `frames[].sha256` | Exactly 64 lowercase hexadecimal characters identifying the complete frame file bytes |

The manifest is at most 64 KiB. Each frame is at most 64 MiB and 500,000 decoded Gaussians; the aggregate frame file limit is 256 MiB. SPZ retains the bounded 96 MiB gzip expansion preflight and supported versions 1–3. RAD import stays disabled. File-size and Gaussian-count limits are rejection bounds, not a promise that maximum-sized captures will fit every mobile device.

The executable example is [`capture.json`](../../rulab/public/capture-example/capture.json) beside its four frame files. It declares `Synthetic scanner study`, timestamps 0, 1, 2, and 3 seconds, duration 4 seconds, and shared bounds `[-5,-0.2,-4]` to `[5,4.5,4]`. Each frame contains 2,847 Gaussians in 91,104 bytes. The 921-byte manifest and four samples total 365,337 bytes. These are fixture dimensions and byte counts, not capture fidelity or rendering speed measurements. Seeking from 3 to 4 seconds holds the sample at 3 seconds.

The manifest has one shared coordinate frame and bounds for the entire sequence. Assets must already agree on those coordinates. Display normalization uses that same bounding volume for every frame; independent per-frame recentring or rescaling would erase or fabricate apparent motion. The renderer additionally requires positive extent on every axis, a longest extent of at least 0.01 metres, and finite normalization values. Decoded frame bounds must fit the declared bounds within a tolerance of 0.01 metres plus 0.1% of the longest extent. The normalized preview is not registered to the authored lab's ENU frame. No transform inferred from camera imagery or measured anchors is included.

`capture.json` is hashed from its exact UTF-8 bytes. Each selected frame is hashed before preflight and decoding, and the byte snapshot that passes the hash check is the snapshot passed onward. Whitespace changes therefore change the manifest identity. Export returns an immutable snapshot of the original manifest bytes, preserving whitespace and any UTF-8 byte-order mark so that an export and reimport retain that identity. The parsed manifest and file table are immutable to callers. Frames are verified on demand; accepting a manifest does not assert that every later frame has already decoded successfully.

## Requested time and displayed time

Requested time is the user's clamped playhead position. Displayed time is the timestamp of the last sample that finished decoding and was committed to the scene. They are separate values. Between samples, at a slow decode, or after a failed frame, displayed time can differ from requested time.

Playback owns at most one displayed asset and one in-flight decode. Repeated seeks coalesce to the latest desired sample. A late result cannot replace a more recently requested frame. The previous asset remains visible until a replacement successfully commits; failed candidates are disposed, an error is exposed, and retries are explicit. A suspended or disposed player rejects subsequent asynchronous results. Cancellation invalidates acceptance of a result; it does not promise immediate interruption of an SDK worker already decoding bytes.

An import is transactional: manifest validation and the initial frame prepare before replacing accepted application state. Camera navigation does not advance the capture. All file imports share serialization and generation checks, including experiment JSON imports when WebGL is unavailable. Context loss and final disposal invalidate pending work; a cached page preserves resources while pausing playback. Renderer and UI metric windows reset on accepted scene transitions so evidence is not attributed to a different source. The independent review records source verification of these boundaries; execution of the browser regressions remains a separate CI gate.

## Rust metadata projection

Capture metadata uses the actual compiled WorldGraph Rust/WASM runtime. Its projection is intentionally bounded to two native `SemanticState` nodes and one `derived_from` edge: manifest node 41001, playback node 41002, and edge 41003 from playback to manifest. It records the manifest identity, source claim, requested time, displayed sample identity and hash, and declared coordinate convention as metadata. Confidence is zero with accuracy explicitly unassessed; the Rust validity timestamp is Unix zero, explicitly labelled a schema placeholder rather than the capture's wall-clock time.

This graph does not contain inferred robot, person, room, sensor, collision, calibration, or tracking nodes. The displayed frame hash must have passed local verification before it can be exported as verified file metadata. Hash verification authenticates bytes against the selected manifest; it does not authenticate the manifest's origin or prove that a GPU rendered those bytes. A separate Rust integration test and browser gate establish their respective execution claims.

## Research and extension route

Primary sources checked September 6, 2026. These methods solve different tasks and are not a shared performance ranking.

| Source | What it supports | Relationship to this implementation |
| --- | --- | --- |
| [Spark 2.1.0 release](https://github.com/sparkjsdev/spark/releases/tag/v2.1.0) and [system design](https://sparkjs.dev/docs/system-design/) | Three.js/WebGL2 Gaussian rendering, scene objects, and programmable Dyno modifications | The dependency remains pinned to 2.1.0. Loading timestamped assets uses the renderer; no learned deformation model is implied by Spark's dynamic rendering support. |
| [Spark 2 features](https://sparkjs.dev/docs/new-features-2.0/) | View-dependent hierarchical detail, RAD HTTP Range streaming, and shared paged splat storage | Future large-capture transport candidate. This local bundle path has no RAD streaming, temporal compression, or adaptive capture prefetch. |
| [Spark LoD deep dive](https://sparkjs.dev/docs/new-spark-renderer/) | Background download/decoder pipeline and detail selection | The page identifies itself as work in progress. API implementation must be checked against the pinned release, and streaming spatial detail must not be described as continuous temporal reconstruction. |
| [BTimer, NVIDIA project](https://research.nvidia.com/labs/toronto-ai/bullet-timer/) | A feed-forward model that predicts a 3D Gaussian representation at a requested timestamp from monocular video context and camera/time conditioning | A potential offline producer of timestamped appearance assets. Its published performance is not a RuLab benchmark. No BTimer weights, inference code, or trained-model adapter is bundled. |
| [4D Gaussian Splatting, CVPR 2024](https://arxiv.org/abs/2310.08528v3) | Learned Gaussian deformation from a spatiotemporal representation | A future upstream producer can evaluate its trained representation at selected times and export compatible snapshots. The browser currently plays those snapshots rather than evaluating a 4DGS deformation network. |

For a real capture integration, reconstruct upstream using a separately provisioned, versioned pipeline. Establish one common coordinate system across all output times; independently measure scale or label it unverified. Evaluate the reconstruction at the chosen timestamps, export supported Gaussian files, compute their SHA-256 values, and emit the exact version 1 manifest. Keep training data, calibration evidence, model/checkpoint version, license, holdout views, and reconstruction metrics alongside the capture as external evidence. The current strict manifest deliberately has no fields for claiming those validations.

A continuous deformation adapter or streamed temporal representation would be a separate format/version and implementation. It requires explicit time conditioning, bounded worker/GPU memory, cancellation, transport policy, and measured performance on target devices. Do not rename this sample-and-hold player as a trained world model when adding higher-fidelity input assets.

## Validation and deployment boundary

The existing seven harness gates remain unchanged. The artifact collector now additionally requires the five fixed bundled files: `rulab/dist/capture-example/capture.json` and `frame-000.splat` through `frame-003.splat`. Together with HTML, compiled JS/CSS, and the Rust WASM/glue pair, the current build requires ten artifact hashes within the unchanged maximum of sixteen. Collection follows no arbitrary manifest paths and performs no recursive tree scan.

`summary.complete` continues to mean all execution gates passed. CLI acceptance additionally requires clean known Git provenance and complete artifact evidence. Missing capture files return nonzero even when all gate exit codes are zero. Harness fixtures isolate this behavior with stubbed gates, real temporary Git checkouts, and real file hashing; fixture output is not evidence that the production browser or Rust pipeline ran.

The previously published authored RuLab is available from `gh-pages` commit `3d8ce695a2e8f9cb6a82152d736e80863719e22c`, with [successful Pages run 34063654028](https://github.com/ruvnet/worldgraph/actions/runs/34063654028). The coordinator verified its served HTML, JS, CSS, WASM, glue, and four reference images against the CI build from main `30bbe3ce01cdff7bbec48aa58acb47a2125dce35`. That is prior publication evidence, not capture-playback publication evidence.

The coordinator also verified all seven validation gates and eight browser tests in [main run 34063578591](https://github.com/ruvnet/worldgraph/actions/runs/34063578591). Its deploy job `101569571194` failed before reported steps and exposed no downloadable log. The exact cause could not be inspected with the available GitHub capabilities. An administrator must inspect the job failure and repository Pages/environment configuration before automated main deployment can be declared operational. This mission does not weaken environment protection, broaden workflow permissions, change publishing settings, or try alternative blocked APIs.

No Git commit, push, settings mutation, or deployment is performed by this ADR or the independent review. Acceptance of this extension requires its own source revision, validation artifacts, and observed hosted build.
