# PAN2 Vast GPU and WSP kit

Run controlled BF16, INT8 or packed INT4 experiments on your own Linux NVIDIA machine. WSP edits canonical native BF16 Safetensors with the pinned Rust editor. Python orchestrates PAN2 and reconstructs BF16 matrices from integer storage for its fused kernels.

This is an experimental integration. CPU tests passed. Full PAN2 GPU inference, image quality, physical accuracy, speed and VRAM fit have not been validated by this kit's author. A small arbitrary WSP edit is a mechanical test, not an improvement.

## 1. Machine and environment

Start with an H200 141 GB, 256 GB host RAM and at least 500 GB free persistent disk. One TB gives more room for downloaded, converted, edited and exported weights. These are conservative experiment provisioning suggestions, not measured minimums. Other GPUs must support BF16 and the pinned PAN2 CUDA kernels. A 24 GB card is not promised to fit.

Use the CUDA 13.2 compatible driver and environment described by upstream. The kit does not install drivers, start GPU rentals or configure network services.

Unzip this directory on the GPU machine and enter it. Use an existing conda installation:

```bash
conda create -n pan2-wsp python=3.14 -y
conda activate pan2-wsp
bash bootstrap.sh
```

Bootstrap clones the exact upstream source, installs its documented torch, FA4 and Quack stack, records pip freeze, runs preflight and tests. If installation fails, consult the pinned upstream environment documentation. Do not silently substitute kernel versions.

```bash
python -m pan2kit doctor --repo PAN2
python -m unittest discover -s tests -v
```

The CPU test environment used during development was torch 2.11.0+cpu and safetensors 0.8.0. GPU bootstrap uses upstream torch 2.12.1. Dependency resolution beyond explicitly pinned packages is recorded in environment-installed.txt, not a complete prevalidated lockfile.

## 2. Download and convert weights

Downloads are explicit and large. Authenticate with Hugging Face first if required by your account. The script records actual snapshot revisions. It downloads the PAN2 transformer, Qwen encoder and Wan VAE, then uses the pinned upstream converter to create the native checkpoint.

```bash
export HF_HOME="$PWD/hf-cache"
python prepare_models.py --repo PAN2 --dest models
cat models/paths.json
```

Keep HF_HOME the same for every run. Inference runs with HF_HUB_OFFLINE=1 so cached encoder assets do not update silently. Keep models/downloads.json, paths.json and environment-installed.txt with the experiment. Download revisions are resolved on your machine and recorded; this ZIP contains no model weights.

## 3. Build the Rust WSP editor

Install a Rust toolchain with Cargo if your machine does not already have one. The build uses pinned source but resolves its Cargo dependencies on your machine. Retain its generated Cargo.lock.

```bash
python -m pan2kit build-wsp --dest wsp-source
export WSP_BIN="$PWD/wsp-source/crates/wsp-tensor/target/release/ruv-fann-wsp-tensor"
"$WSP_BIN" inspect models/base/transformer/model.safetensors
```

Select an inspected floating tensor and a valid flat index. This example selects the first native block matrix and adds 0.01 to its first weight. It deliberately makes no quality claim:

```bash
TENSOR=$(python -c "from safetensors import safe_open; f=safe_open('models/base/transformer/model.safetensors',framework='pt'); print(next(k for k in f.keys() if k.startswith('blocks.') and len(f.get_slice(k).get_shape())==2))")
python make_patch.py --base models/base/transformer/model.safetensors \
  --tensor "$TENSOR" --index 0 --delta 0.01 --output patch.json
python -m pan2kit edit --binary "$WSP_BIN" \
  --base models/base/transformer/model.safetensors \
  --output models/edited/transformer/model.safetensors --patch patch.json
```

The Rust editor checks the source SHA256, enforces bounded finite changes, preserves source bytes, refuses an existing destination, and writes a receipt. Editing a 58 GB checkpoint still requires copying that file. It is not an in place edit or a weight training algorithm.

To produce and verify a rollback copy:

```bash
"$WSP_BIN" rollback models/edited/transformer/model.safetensors \
  models/rolled-back.safetensors \
  models/edited/transformer/model.safetensors.receipt.json
cmp models/base/transformer/model.safetensors models/rolled-back.safetensors
```

## 4. Run the four variants

Use the VAE snapshot path printed in models/paths.json:

```bash
VAE_PATH=$(python -c "import json; print(json.load(open('models/paths.json'))['vae'])")
python -m pan2kit matrix --repo PAN2 \
  --base models/base --edited models/edited \
  --vae "$VAE_PATH" --prompt-file prompt.txt \
  --bits 8 --output results-int8
```

This runs original BF16, edited BF16, original INT8 and edited INT8 in four fresh single GPU processes, with the same prompt, seed, dimensions and sampler settings. Each has a log, video, upstream settings and measurement receipt. matrix.json records hashes and results. Any failed variant stops the matrix. Existing result directories are refused.

The default 9 frames, 256 by 448 and 4 steps are a cheap mechanical smoke test. They cannot assess model quality. For a meaningful follow up, use a new directory and upstream sampling defaults:

```bash
python -m pan2kit matrix --repo PAN2 \
  --base models/base --edited models/edited \
  --vae "$VAE_PATH" --prompt-file prompt.txt \
  --bits 8 --frames 241 --height 704 --width 1248 --steps 50 \
  --timeout 14400 --output results-int8-full
```

Repeat with --bits 4 and a new output directory to test INT4. Start with INT8 because it introduces less rounding error. The matrix currently accepts one text prompt per invocation. For a held out suite, run one fresh matrix per prompt and seed; preserve all results, including failures.

All variants use model offload, BF16 compute, compile disabled and prefetch disabled. The quantized variants construct and load canonical weights on CPU, then replace block matrices with integer storage before moving the transformer to CUDA. This avoids a full BF16 GPU load before quantization, but CPU load and conversion still need substantial RAM.

## 5. Optional packed weight export

With export enabled, elapsed time includes export and hashing; benchmark without it for timing comparisons. Add --save-quant to matrix to save a Safetensors runtime state for each quantized variant. These files use pan2kit.quant-state/1. They are not native PAN2 checkpoints and cannot be loaded by upstream generate.py or edited with WSP.

For an already constructed matching native transformer on CPU:

```python
from pan2kit.quant import load_quantized
report = load_quantized(transformer, 'results-int8/base_quant/quantized.safetensors')
```

Loading constructs matching parametrizations and strictly restores packed tensors. It does not remove the CPU model construction requirement. Runtime exports carry schema and bit width; preserve the matching matrix manifest and source revision. Do not call .to(dtype=...) after quantization or use global parametrization caching. Device moves alone are supported by the design.

## What the optimization does

| Component | Storage | Compute |
| :--- | :--- | :--- |
| Native block matrices | Symmetric per row INT8 or packed INT4, FP32 row scales | Dense BF16 reconstructed on each access |
| Biases, norms, other matrices | Original precision | Original kernels |
| Qwen and VAE | Original precision, model offload | Original kernels |

Ideal covered matrix payload is about half of BF16 for INT8 and one quarter for INT4, plus row scales. Actual coverage and retained parameter bytes appear in each quantization receipt. These figures exclude buffers, activations, allocator overhead and transient dense reconstructed matrices. Reconstruction can make inference slower. No integer CUDA compute kernel is supplied. Original BF16 files remain on disk.

## Acceptance and WorldGraph boundary

Accept the mechanical integration only when all CPU tests pass, four GPU variants complete, source hashes remain unchanged, rollback matches byte for byte, and packed variants show lower retained parameter storage. Compare measured peak allocated and reserved GPU memory and wall time; do not infer them from weight payload.

Before promotion, evaluate a held out prompt suite with your task specific tolerances for temporal consistency, object persistence, physical constraints and downstream action decisions. Keep quality_validation pending until those checks are recorded. A rendered plausible bounce is not calibrated physical simulation.

This kit produces model experiment artifacts. It does not publish inferred positions or forces into WorldGraph, mutate RuView observations, or supply a calibrated state extractor. Carry accepted hypotheses into the existing forecast branch integration only after its extractor and metric validation are implemented.

## Cost and hardware validation plan

See the [staged quantization cost plan](../../docs/mission/pan2-quantization-cost-plan.md) for hardware trials, proposed spending caps, quality gates, break even calculations, required instrumentation and cost per accepted output. Savings remain unmeasured. The legacy matrix requires BF16 on each GPU. The new [quantization metaharness](METAHARNESS.md) supports quantized only plans, single trials, seeded scheduling, validated resume, cost allowances and output bound quality decisions. See [ADR 208](../../docs/adr/208-pan2-quantization-metaharness.md).

## Source provenance

PAN2 source: https://github.com/ifm-ai/PAN2/tree/0fb907b6e16a82ead6d691d1de2eef6299c71e9a

Upstream environment: https://github.com/ifm-ai/PAN2/blob/0fb907b6e16a82ead6d691d1de2eef6299c71e9a/docs/environment.md

WSP editor: https://github.com/ruvnet/ruv-FANN/tree/812695581339bfae5b7e615d0866fa855b2f26c1/crates/wsp-tensor

No upstream source or weights are redistributed here. Retain original licenses and notices for separately downloaded components.

