# ADR 208: PAN 2 as a simulated-rollout provider

Status: implemented on `feat/pan2-simulated-rollouts`. Measured GPU evidence is in [the PAN 2 run record](../mission/pan2-rollout-evidence.md).

Date: 2026-11-11.

Related: [ADR-204](ADR-204-rust-generative-world-model-runtime.md) (provider contract), [ADR 205](205-rulab-temporal-gaussian-world.md), [ADR 206](206-rulab-capture-playback.md) (capture playback).

## Context

[PAN 2](https://github.com/ifm-ai/PAN2) is a video world model released by the Institute of Foundation Models at MBZUAI. Facts checked against primary sources on 2026-11-11:

| Fact | Source |
| --- | --- |
| Code and weights are Apache-2.0 | `LICENSE` in `ifm-ai/PAN2`; model card of [`IFM/PAN2`](https://huggingface.co/IFM/PAN2) |
| 29.2B-parameter diffusion transformer, Qwen3.5-9B text encoder, Wan 2.2 VAE | upstream `README.md` |
| Input is a structured text caption plus an optional first image | upstream `docs/inference.md` |
| Output is 2D video, up to 20 s at 24 fps (measured here: 1248 wide by 704 high) | upstream `README.md`; `ffprobe` of the clips produced |
| One `generate.py` worker per GPU, each holding the whole model | upstream `docs/inference.md` |
| No hosted inference endpoint is offered by the publisher | not found on `ifm.ai/pan` or in the repository; treated as unconfirmed |
| "Predictions, not records"; text actions are coarse; appearance drifts across clips | upstream `MODEL_CARD.md` |

Pinned for this work: upstream commit `0fb907b6e16a82ead6d691d1de2eef6299c71e9a`, weights revision `a7936f7bea20ec3b9de809583712b40693071819`.

ADR-204 already defines how a generative model may sit beside worldgraph. PAN 2 fits that contract with three gaps: the model enum had no PAN 2 entry, the local-weights providers could not be marked as running on a remote host, and nothing turned a worldgraph scene into the caption format PAN 2 expects.

## Decision

### 1. PAN 2 is an ADR-204 external provider

`ExternalModelKind::Pan2` is added to `wifi-densepose-worldmodel` with an Apache-2.0 `LicensePolicy` whose notice names the Qwen3.5 and Wan 2.2 components. Adding an enum variant is a breaking change for exhaustive matches, so the crate moves to 0.4.0.

`ExternalModelConfig::build_sidecar` accepts two placements for PAN 2:

- **Local.** `hosted = false` and a weights path that exists on this machine.
- **Hosted.** `hosted = true` and no weights path. A rented GPU host is a third-party processor under ADR-204 §5, so every `SceneSeed` must carry `hosted_processing_approved = true` or the provider refuses it before the socket is used.

No credential setting is accepted in either placement.

### 2. The transport is the existing sidecar protocol

No new wire protocol is added. The GPU host runs `pan2-worker`, a Rust binary from the new `worldgraph-pan2` crate, which answers the ADR-204 newline-delimited JSON protocol on a Unix socket. A remote host is reached by forwarding that socket over SSH (`ssh -L local.sock:remote.sock`). The existing `ExternalSidecarProvider` is the client, unchanged.

Video bytes never cross the control socket. The worker writes files under a media root and returns one `FrameDescriptor` per file with its SHA-256 and size. The operator copies the media directory on a separate channel; the client accepts a file only after its size and hash match the descriptor.

### 3. Upstream code runs unmodified; the glue is Rust

`pan2-worker` starts the upstream `generate.py` as a child process with the released sampler settings (50 steps, flow shift 9, guidance 2.5, bf16) and one prompt record. No model code is vendored, ported, or patched. The only deviation from the upstream launcher is the output encoding: `yuv420p` at CRF 20 instead of `yuv444p` at CRF 8, so browsers can play the clip that was hashed.

Each step starts a new process, so each clip pays the model load. That is acceptable for a provider that produces a handful of clips; a resident server (upstream documents vLLM and Diffusers paths) is future work.

### 4. A deterministic compiler writes the caption

PAN 2 is conditioned on a JSON caption with seven keys in a fixed order. `worldgraph_pan2::compile` builds it from the two values the sidecar protocol already carries:

| Session input | Caption field |
| --- | --- |
| `SceneSeed.prompt` | start of `init_frame_visual_description` |
| `SceneSeed.scene` primitives | a layout sentence appended to it (class, side, depth, width) |
| `SceneSeed.metadata["pan2.*"]` | style, lighting, viewpoint, subjects, conditioning image |
| `ActionChunk.samples` | clip duration and `camera_motion` tags |
| `ActionChunk.metadata["pan2.event.N" / "pan2.act.N"]` | timed events and subject actions |

`RolloutPlan` is the typed front end that writes those keys. The same compiler runs on the client and inside the worker, and the client rejects a rollout whose caption hash differs from the one it compiled.

The compiler does not call a language model. Upstream recommends an LLM "conceptual reasoner" to expand free text into this format; here the caller supplies the scene and actions in structured form, and the compiler only arranges them. The result is reproducible, and less richly described than an LLM rewrite would be.

Limits enforced before anything is sent: 1 to 20 seconds, at most one decimal place in every time, contiguous events, camera intervals covering each event, actions inside one event, at most 8 subjects, 200 words per paragraph, and 6,000 bytes per caption. The byte limit stands in for the text encoder's 1,480-token soft limit, which this crate does not measure.

### 5. A rollout is not a capture and not evidence

- A rollout has its own bundle format, `worldgraph.simulated.rollout` version 1 (`rollout.json`, the clip, the caption, an optional first frame). It is not an ADR-206 capture bundle and RuLab does not open it in the capture player.
- RuLab shows a rollout in a separate panel under a permanent banner: `SIMULATED · MODEL PREDICTION · NOT A CAPTURE`. The browser re-hashes the clip before playing it.
- The only graph write is one `SemanticState` with confidence 0, a statement that begins `SIMULATED rollout`, and provenance naming the model, checkpoint, runtime, seed, prompt hash, source snapshot and privacy decision. No room, person, object or event node is created or changed.
- The worker reports confidence 0. The video cannot be read back as a measurement of the space, and no metric scale or camera calibration is claimed for it.

### 6. Simulated envelopes get their own API

`worldgraph-stream` gains `POST /v1/sim/envelopes`, `GET /v1/sim/envelopes` and `GET /v1/sim/sessions`. They use the same bearer validation as the twin routes, hold a bounded in-memory store, accept descriptors and provenance only, and share no state with the twin stream. Posting a simulated envelope to `/v1/twin/envelopes` is rejected, and the reverse.

### 7. Cognitum Spaces receives a labelled simulation, not media

Spaces stores small semantic JSON and rejects recording fields by name. A rollout is published as one `POST /v1/spatial/simulations` body (cognitum-one/api ADR-107): `simulationType: "video.rollout"`, `confidence: 0`, the clip's SHA-256 and size, a locator for where the operator hosts the clip, and the model provenance (`model`, `provider`, `generationSeed`, `sourceSnapshotHash`; the rest of the run record goes in `attributes`). A simulation is its own kind, never an event, so it cannot appear in the observed event log or in a space snapshot. The server stamps `simulated: true`, and writing needs the `spaces:simulate` permission, which `spaces:write` does not grant. `worldgraph_pan2::spaces::validate_simulation` mirrors the handler's limits as a local preflight; the server stays the authority.

The first version of this ADR published a `simulation.rollout` event to `/v1/spatial/events`. That worked against the handler's schema but put predictions in the observation log, so it was replaced.

Publishing is a separate, explicit step (`pan2-rollout publish`, behind the `spaces-http` feature). Nothing in the pipeline sends to Spaces on its own. The ADR-107 routes are implemented on a local branch of the API repository: not merged, not deployed, and the one new Firestore index is not applied, so these routes do not exist in production yet.

### 8. Spaces records can seed a rollout

`worldgraph_pan2::spaces_scene` turns the records of one space (site, space, zones, entities, events) into a `RolloutPlan`. It reads either this crate's snapshot file or a `GET /v1/spatial/snapshots/{spaceId}` response. For a response it recomputes the canonical-JSON hash of `data` and refuses the snapshot if it differs from `snapshotHash`; that hash becomes the plan's `source_snapshot_hash`, so a rollout names the exact Spaces data it was built from. Layout comes from each record's validated `placement` (`centerM`, `sizeM`), falling back to the free-form `attributes` of the same names for data written before ADR-107. Appearance, `class`, event narrative and camera still come from `attributes`. `physics` is validated, stored and served by the API but is not used in the caption: PAN 2 takes text, and a number such as a mass cannot be conveyed to it reliably. Events are ordered by `eventSequence` and share the clip evenly; their real timestamps are not replayed. A person or track entity that is not `identityMode: "anonymous"` is dropped and counted as a redaction.

The resulting clip dramatizes a recorded sequence. It is not a recording of it.

## Consequences

- worldgraph can ask "what might happen next" of a real, openly licensed world model without weakening the rule that sensed state is authoritative.
- Running it needs a GPU with about 140 GB of memory. The measured cost and time per clip are in the run record; they are for one configuration and are not a general benchmark.
- The caption compiler covers camera motion, timed events and subject actions. It does not express dexterous manipulation, and upstream states that text actions are coarse.
- A 2D clip is not a 3D or 4D asset. Turning a rollout into Gaussian frames would need a separate reconstruction step, a new capture version, and its own ADR. It is out of scope here.
- The Rust-only rule holds for everything in this repository. The upstream Python runs as an unmodified external process on the GPU host, the same boundary ADR-204 set for every external provider.

## Not done

- No rollout has been published to the production Spaces API, and the `api` service was not deployed. Its ADR-107 changes exist only on a local branch.
- No crate or npm package was published.
- The token count of compiled captions was not measured with the Qwen3.5 tokenizer.
- No comparison against other providers (Wan 2.2, Oasis) was run.
