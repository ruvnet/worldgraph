
| `spaces_scene` | Builds a plan from Cognitum Spaces records (site, space, zones, entities, events) |# worldgraph-pan2

PAN 2 as a simulated-rollout provider for worldgraph. Decision record: [ADR 207](../docs/adr/207-pan2-simulated-rollout-provider.md).

[PAN 2](https://github.com/ifm-ai/PAN2) is an Apache-2.0 video world model from MBZUAI's Institute of Foundation Models. You describe a scene and some timed actions; it renders a clip of what might happen next. This crate lets worldgraph ask that question while keeping the rule from [ADR-204](../docs/adr/ADR-204-rust-generative-world-model-runtime.md): the sensed graph is authoritative, and generated pixels are explicitly simulated output.

A rollout is a prediction. It is never labelled as a capture or an observation, and the confidence recorded for it is always zero.

## What is in the crate

| Module | Purpose |
| --- | --- |
| `plan` | `RolloutPlan`: a typed, JSON-serializable request for one clip |
| `compile`, `caption`, `layout` | Deterministic compiler from the ADR-204 session inputs to PAN 2's structured caption |
| `worker`, `renderer` | GPU-side sidecar that speaks the ADR-204 protocol and runs the unmodified upstream `generate.py` |
| `media` | SHA-256 and size verification for files copied from the GPU host |
| `bundle` | The `worldgraph.simulated.rollout` bundle that RuLab plays |
| `projection` | Records a rollout as one zero-confidence `SemanticState` |
| `spaces` | Builds and preflights a Cognitum Spaces `simulation.rollout` event |
| `pipeline` | The end-to-end client flow |

Two binaries: `pan2-worker` (runs on the GPU host) and `pan2-rollout` (runs on your machine).

No model code is vendored or reimplemented. The model runs as an external process on a host you provision.

## Try it without a GPU

```bash
# Compile a plan into the caption PAN 2 would receive
cargo run -p worldgraph-pan2 --bin pan2-rollout -- caption worldgraph-pan2/examples/plans/rf-door.json

# Whole pipeline over a real Unix socket, with the renderer faked
cargo test -p worldgraph-pan2

# Control-plane overhead (not model speed)
cargo bench -p worldgraph-pan2
```

## Run it for real

You need one GPU with about 140 GB of memory (the measured run used one H200), 350 GB of disk, and a driver that supports CUDA 13.2.

On the GPU host, install upstream and fetch the weights (about 110 GB of downloads):

```bash
PAN2_COMMIT=0fb907b6e16a82ead6d691d1de2eef6299c71e9a \
PAN2_REVISION=a7936f7bea20ec3b9de809583712b40693071819 \
bash scripts/pan2/remote-setup.sh
```

Build the worker as a static binary, copy it over, and start it there:

```bash
cargo build --release -p worldgraph-pan2 --bin pan2-worker --target x86_64-unknown-linux-musl

W=/workspace/pan2
$W/bin/pan2-worker --socket $W/pan2.sock --media-root $W/media --image-root $W/images \
  --pan-root $W/PAN2 --torchrun $W/conda/envs/pan2-h200/bin/torchrun \
  --checkpoint $W/native/transformer \
  --model-revision a7936f7bea20ec3b9de809583712b40693071819 \
  --runtime-commit 0fb907b6e16a82ead6d691d1de2eef6299c71e9a
```

On your machine, forward the socket, generate, copy the media, and accept:

```bash
ssh -N -L /tmp/pan2.sock:/workspace/pan2/pan2.sock root@GPU_HOST &

pan2-rollout generate --plan plan.json --socket /tmp/pan2.sock --hosted --accept-terms --out envelope.json
rsync -a root@GPU_HOST:/workspace/pan2/media/ ./media/
pan2-rollout accept --plan plan.json --envelope envelope.json --media-root ./media --out ./rollouts/rf-door
pan2-rollout verify ./rollouts/rf-door
```

`--hosted` marks the GPU host as a third-party processor. The plan must then say `"hosted_processing_approved": true`, or the provider refuses it before anything leaves your machine. Use `--weights <dir>` instead when the worker runs inside your own trust boundary.

`accept` writes nothing unless every file matches the hash in the envelope and the caption the worker rendered is byte-identical to the one compiled locally.

## Writing a plan

```json
{
  "name": "RF door opens",
  "source_snapshot_hash": "sha256:...",
  "source_stream_epoch": 1,
  "generation_seed": 123,
  "projection_id": "rulab-public-demo",
  "hosted_processing_approved": true,
  "duration_sec": 5,
  "first_frame": "A clean research lab with a closed grey shielded door in the far wall.",
  "scene": [{ "kind": "box", "center_m": [0, 5, 1.05], "size_m": [1.1, 2.1, 0.1], "class": "shielded_door" }],
  "subjects": [{ "name": "Shielded door", "attribute": "Grey steel RF door with a recessed handle." }],
  "events": [{ "until_sec": 5, "description": "The door swings inward until it stands fully open." }],
  "actions": [{ "from_sec": 1, "to_sec": 4.5, "subject": 1, "action": "swings inward until fully open." }],
  "camera": [{ "at_sec": 1, "translation": [0, 0.4, 0] }]
}
```

- `scene` uses the sanitized primitives from ADR-204. They become one layout sentence, described as seen from the south looking north: east is right, north is far.
- `camera` keys hold until the next key. `translation` is `[right, forward, up]`, `rotation` is `[yaw-left, pitch-up, roll-clockwise]`; a value above 0.05 selects the matching PAN 2 camera tag.
- Times use at most one decimal place. Events run back to back from zero. An action must fit inside one event.
- Add `"image": { "file": "first.png", "sha256": "..." }` for image-to-video. Copy that file into the worker's `--image-root` first; the worker refuses a missing or different image.

Unknown fields are rejected.

## From Cognitum Spaces records

```bash
pan2-rollout from-spaces --snapshot worldgraph-pan2/examples/spaces/warehouse-amr.json \\
  --duration 20 --approve-hosted --out plan.json
```

A snapshot holds the `data` records the Spaces API returns for one space: `site`, `space`, `zones`, `entities` and `events`. Spaces has no geometry fields, so the converter reads these from each record's `attributes`:

- space: `description`, `lighting`, `view`
- zone or entity: `centerM` and `sizeM` (`[x, y, z]` in metres), `class`
- entity: `appearance` (makes it a tracked subject)
- event: `entityId`, `narrative`, `action`

Events are ordered by `eventSequence` and share the clip evenly. People must be `identityMode: "anonymous"` or they are left out. The plan's `source_snapshot_hash` is the SHA-256 of the snapshot. Two examples are in `examples/spaces/`.

## Limits worth knowing

- The compiler arranges what you give it. It does not call a language model, so captions are plainer than the LLM-rewritten ones upstream recommends.
- The 6,000-byte caption limit is a stand-in for the text encoder's token limit, which is not measured here.
- Every step starts a new `generate.py` process and reloads the model.
- The output is 2D video. It carries no metric scale, camera calibration, or 3D structure.
- Upstream's model card lists the model's own limits: long plans often miss a step, appearance drifts between clips, and text actions are coarse.

## Licence

This crate is MIT OR Apache-2.0. PAN 2's code and weights are Apache-2.0 from MBZUAI; the Qwen3.5 text encoder and Wan 2.2 VAE carry their own licences. Keep upstream's `NOTICE` and `THIRD_PARTY_LICENSES` with anything you redistribute.
