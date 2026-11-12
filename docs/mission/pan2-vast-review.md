# PAN2 Vast GPU experiment delivery

Adds an optional standalone runner under tools/pan2-vast for separately operated GPU machines. This follows the structured physical adapter merged in PR #18. It does not change the Rust adapter or its observation and hypothesis boundaries.

Inputs are a pinned upstream PAN2 checkout, downloaded encoder and VAE assets, native original and WSP edited checkpoints, and a fixed text prompt. Outputs are four isolated generation runs, provenance hashes, logs, output videos, memory and timing receipts, and optional packed runtime states. No weights or generated videos are committed.

Native PAN2 uses raw block parameters with custom fused kernels. The adapter uses PyTorch parametrizations to retain block matrices as per row INT8 or packed INT4 and reconstruct dense BF16 on access. It supplies no integer compute kernels. Encoder, VAE, activations and other parameters remain unquantized. Retained parameter storage is measured separately from GPU peaks. Full PAN2 compatibility and speed remain open GPU acceptance gates.

WSP source is pinned to ruvnet/ruv-FANN commit 812695581339bfae5b7e615d0866fa855b2f26c1. The Rust tool edits canonical Safetensors after checking source hashes and emits exact rollback receipts. The demonstration patch is not a learned improvement. Packed runtime states use a separate schema and are not accepted as native checkpoints.

Validation performed on ruOS with torch 2.11.0+cpu and safetensors 0.8.0: six unittest methods passed, including both bit widths, odd widths, zero rows, finite checks, duplicate rejection, excluded tensor preservation, storage reduction, strict Safetensors roundtrip, and mocked four process orchestration. Python compilation and shell syntax passed. CI repeats these CPU checks without downloading PAN2 weights or renting a GPU.

Pending: execute the documented four variant matrix on the user's Vast GPU, verify exact source preservation and rollback, measure GPU peaks and wall time, and assess held out quality with task specific tolerances. Bootstrap follows the pinned upstream Python 3.14 and CUDA 13.2 stack, while CPU tests used torch 2.11.0. No GPU compatibility claim follows from those CPU results.

A calibrated video to metric extractor is still required before forecasts enter WorldGraph. The runner has no graph mutation, model promotion, actuator, cloud endpoint or automatic rental path.

## Quantization metaharness follow up

ADR 209 implements bounded planning, seeded six variant scheduling, quantized only trials, validated resume, per worker timeout cleanup, soft cost reservations and output bound actual cost and quality evaluation. The quantizer preallocates packed storage and releases source references by matrix. All 13 CPU tests passed on ruOS with torch 2.11.0+cpu and safetensors 0.8.0. Seven new tests cover failure, budget, resume integrity, cost gates, 100 paired cases and inconclusive small samples. GPU measurements, physical extraction and savings remain pending.
