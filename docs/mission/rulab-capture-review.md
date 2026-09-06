# RuLab capture playback security and correctness review

Status: scoped source review complete. Four confirmed medium-severity findings were fixed by component owners and verified by rereading the changed code. Full CI, twelve browser cases, and hosted capture-playback acceptance are pending. This is not release acceptance.

Date: 2026-09-06. Base source: `30bbe3ce01cdff7bbec48aa58acb47a2125dce35`; working branch `feat/rulab-capture-playback`.

## Scope, authority, and method

The scope is local multi-file capture parsing, time selection, asynchronous decode/display ownership, the native Rust metadata projection, browser mode/lifecycle integration, bundled synthetic samples, and the existing fixed-command harness. Untrusted input consists of selected manifest/frame bytes and their filename/source declarations. Assets at risk are accepted scene state, browser memory, GPU resources, graph provenance, and release evidence.

The reviewer owns only this report, ADR 206, and the two harness files. Parser, playback, graph, and UI review is read-only; any confirmed issue is sent to the component owner before fixes. No source fixes in those components, active production probes, credential tests, settings changes, commits, pushes, or deployments are authorized by this review subtask.

The repository's actual stdio MCP was initialized and `worldgraph_mission_plan` called successfully for this scoped review. The protocol reported package version 0.1.3 and planning-only behavior. Ruflo routing and MCP plans are coordination, not test or security evidence. This review applies the `security-audit` skill's evidence and trust-boundary guidance; it does not claim a separate Ruflo scanner run or a new dependency advisory scan. Advisory-feed timestamp for this review is therefore not applicable.

## Confirmed findings

Each finding below was sent to its component owner before remediation. The reviewer changed no parser, renderer, graph, or UI source.

| ID / priority | Confirmed reachable issue | Resolution verified in current source |
| --- | --- | --- |
| CAP-001 / P2 | A valid manifest could declare an extremely small extent, making preview normalization infinite and producing nonfinite scene transforms. | `capturePreviewTransform` rejects nonpositive or nonfinite axis extents, a longest extent below 0.01 metres, and nonfinite scale/position. It runs before import staging and when applying the shared transform. Three focused numeric regressions pass. |
| CAP-002 / P2 | A delayed experiment `File.text()` continuation could replace a newer environment or capture because its read began outside the common import generation guard. | Experiment import now uses shared serialization and checks its generation after the read, while remaining available without WebGL. A Playwright delayed-read regression is included; its execution is pending CI. |
| CAP-003 / P2 | Re-serializing a parsed manifest on download changed the raw bytes while graph metadata cited the original manifest SHA-256. | A private immutable Blob retains the original byte snapshot, and `captureManifestFile` exports a fresh File from that snapshot. The UI downloads it directly. Tests verify whitespace/BOM preservation, byte/hash equality after reimport, and rejection of forged bundles. |
| CAP-004 / P2 | Frame metrics from an earlier authored scene or capture could be exported under the current capture's identity. A partial renderer sampling window could also cross a transition. | Accepted source transitions clear the UI sample history and the renderer's native metric window. Evidence limitations now depend on the active source mode. These changes were verified in source; device performance is not certified. |

No further confirmed critical or high-severity issue remained in the inspected paths at this pass. This is a bounded manual review, not proof that every browser, GPU, SDK worker, or malicious input is safe.

## Trust boundaries checked

| Boundary | Abuse or failure case | Current mitigation and practical limit |
| --- | --- | --- |
| File selection | Unexpected files, duplicate identities, traversal, URLs, archive expansion | Exact `capture.json` plus named flat frame files; supported extensions; case-insensitive duplicate rejection and exact case-sensitive matching. No user-supplied URL is fetched. |
| Manifest parsing | Large payloads, prototype keys, unsupported schema, invalid time/bounds | 64 KiB before read; strict UTF-8; exact plain-object keys; duplicate-key rejection including escaped aliases; finite bounded times/coordinates; 1–240 frames; duration at most 120 seconds. |
| Appearance bytes | Corruption, mismatched evidence, malformed splats, excessive allocation | Frame SHA-256 over the exact bytes passed to preflight, existing 64 MiB / 500,000-Gaussian bounds, 256 MiB total selected frame bytes, bounded SPZ expansion, RAD disabled. These limits are not a mobile memory guarantee. |
| Shared coordinates | Tiny bounds create infinite transforms; per-frame normalization invents motion | One fixed capture transform; positive finite axis extents, longest extent at least 0.01 metres, finite scale/position, and decoded bounds checked against declared bounds. Input units and calibration remain unverified. |
| Bundle ownership | Mutation of filenames, hashes, timestamps, or file table after validation | Frozen nested metadata and immutable file-table facade; private validation registry rejects forged bundle copies. Native File bytes are immutable. Manifest export preserves the original private byte snapshot. |
| Seek/decode | Older results replace new requests; unbounded parallel work; retry loops | One decode at a time, latest requested sample check, epoch/abort checks after asynchronous completion, no same-sample automatic retry, explicit retry. |
| Display/disposal | Failed frame erases last good scene; late result leaks | Commit replacement before disposing the old asset; retain old asset after failure; dispose stale/late candidates; suspend/dispose invalidate pending results. This does not force-cancel SDK work already executing. |
| Integrated imports and lifecycle | Delayed file reads replace new state; reset/context loss accepts pending decodes | Shared import serialization and generation checks; staged initial-frame commit; reset/disposal/context loss invalidate pending work. Cached pages pause playback. Untrusted labels/errors use text sinks. Browser lifecycle execution remains a CI gate. |
| Built-in example transport | Large responses consume memory before a size check | Only five fixed same-origin filenames are fetched; the stream is rejected above 1 MiB before accumulating more bytes and uses the import abort signal. Local manifests cannot introduce URLs. |
| Graph provenance | Imported geometry appears to be measured lab objects or calibrated observations | Two native Rust semantic nodes and one metadata relationship; source remains a declaration; unverified registration; no authored lab/object/sensor projection. Display hash requires prior verification. |
| Graph history | Seek replay changes identities or grows records | Fixed IDs 41001/41002/41003; identical messages deduplicated; actual Rust export tested for byte-identical reverse seek and constant two-node/one-edge count. |
| Harness acceptance | Passing command booleans conceal absent sample files | Five exact sample artifacts additionally required; missing files reject CLI acceptance, while gate-only `summary.complete` remains accurate. Maximum sixteen artifacts and no recursive scan. |
| Publication | New capture code inherits a previous release's success claim | Prior publication is identified separately below; this extension needs its own validated source and deployment evidence. No permission or protection changes were made. |

SHA verification establishes consistency with the selected manifest. It does not prove an asset's origin, surveyed scale, spatial accuracy, trained-model quality, or actual GPU presentation. The graph records requested and displayed times separately; a last-good frame may remain displayed after rewinding or after a later sample fails.

## Executed checks

| Check | Result and coverage |
| --- | --- |
| `npm run test:harness` at repository root | 22 tests passed. Real stdio protocol handling, bounded evidence validation, actual temporary Git provenance, artifact hashing, missing required capture files, and existing path/symlink checks. |
| `npm test` at repository root | Five tests passed across two files, including the harness wrapper and existing package smoke coverage. |
| `npm test -- src/capture/manifest.test.ts src/capture/playback.test.ts src/capture/graph.test.ts` in `rulab` | 69 tests passed independently across three files. Includes malformed and duplicate-key manifests, filename/byte/count bounds, hash failure, immutable byte-preserving export, sample selection, numeric transforms, delayed results, failed replacement, retry, suspension, and disposal. Four tests execute the actual compiled Rust WASM/glue and cover fixed graph cardinality, unverified labels, requested/displayed divergence, reverse seek, invalid state, unavailable WASM, and disposal during initialization. |
| Coordinator validation of the integrated local tree | 106 RuLab unit tests and 22 harness tests passed; typecheck and production build passed. These broader results are coordinator-provided, not a second independent execution. |
| Independent bundled-file hash comparison | All four supplied SHA-256 values match frame bytes. Each frame is 91,104 bytes; the 921-byte manifest plus frames is 365,337 bytes. |
| Scoped `git diff --check` | Clean for reviewer-owned code/document changes at the time checked. |

Harness acceptance tests explicitly stub gate subprocesses to isolate acceptance policy. Their Git state, file reads, output diagnostics, and hashes are real, but their successful gate fixtures do not prove browser or Rust execution. The dedicated capture graph suite does execute Rust WASM. The coordinator added twelve desktop/mobile browser cases, including capture success/failure, play/pause, reverse seek, byte-preserving export, reset, and delayed-read synchronization. They are running in CI and are not represented as passed here. The coordinator visually inspected the cloud-browser picker and truthful fallback without WebGL; that inspection is not GPU execution evidence.

## Reconstruction and renderer limitations

Spark remains pinned to [2.1.0](https://github.com/sparkjsdev/spark/releases/tag/v2.1.0). Its [programmable splat pipeline](https://sparkjs.dev/docs/system-design/) and [spatial streaming features](https://sparkjs.dev/docs/new-features-2.0/) do not themselves provide a trained temporal reconstruction. The [LoD deep dive](https://sparkjs.dev/docs/new-spark-renderer/) warns that it is work in progress; implementation details are checked against the installed release rather than assumed from every documentation example.

The capture player displays discrete 3D Gaussian samples. [BTimer](https://research.nvidia.com/labs/toronto-ai/bullet-timer/) describes a model that predicts a Gaussian scene at a requested timestamp; [4DGS](https://arxiv.org/abs/2310.08528v3) describes learned time-dependent deformation. Neither model is implemented here. Real outputs may be adapted upstream into a shared-frame sequence, with independent calibration and reconstruction evidence. See [ADR 206](../adr/206-rulab-capture-playback.md) for the exact format and extension path. All bundled frames are synthetic.

## Deployment status and administrator prerequisite

The coordinator supplied the following prior evidence: main source `30bbe3ce01cdff7bbec48aa58acb47a2125dce35` passed all seven validation gates and eight browser tests in [run 34063578591](https://github.com/ruvnet/worldgraph/actions/runs/34063578591), with report/log hashes checked. Its compiled site was published on `gh-pages` commit `3d8ce695a2e8f9cb6a82152d736e80863719e22c`; [Pages run 34063654028](https://github.com/ruvnet/worldgraph/actions/runs/34063654028) succeeded. The coordinator compared served HTML, JS, CSS, Rust WASM/glue, and four reference images with CI and verified live `release.json`.

This review did not independently redo those HTTP comparisons. They identify the already hosted authored RuLab, not this capture extension. The current successful publication remains available while extension development proceeds.

The automated deploy job `101569571194` failed before reported job steps; its downloadable log was unavailable. Attempts to inspect job annotations/details were rejected as unsupported by the available connector. The exact cause is inaccessible and must not be attributed to a particular policy, environment rule, or token permission without evidence. An administrator must inspect the failure and the repository's Pages/environment configuration before automated main deployment can be declared operational. This review does not weaken environment protection, alter workflow permissions, or try alternative blocked APIs.

Slack has no callable messaging capability in this session. No progress message is represented as sent. Communication limitations do not relax validation or publication gates.

## Dependency identity and remaining acceptance

Lockfile hashes observed during this pass:

| File | SHA-256 |
| --- | --- |
| `package-lock.json` | `84c22a662311e03ae5639f6acbae293b2752b13b1dafd292e5dfa1a496c93831` |
| `rulab/package-lock.json` | `7adf929fd211bf5332b3150cb1aed6f71e0c6dc0113adab0f483ca7b6daa2858` |

Source review covered the integrated Spark adapter, shared-bounds validation, initial import transaction, mode switches, source labels and text sinks, context loss, pending-import cancellation, cached-page lifecycle, and final disposal. Remaining release acceptance: complete fixed harness run on a clean known commit, actual WebGL2 browser tests of frame changes and held failures, and observed hosting of those exact bytes. No physical-device frame-rate target, continuous 4DGS reconstruction, training run, or production safety claim is made.
