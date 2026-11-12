# ADR 209: Bounded PAN2 quantization metaharness

Status: implemented local controller; 37 kit tests pass on CPU. First GPU evidence (H200, RTX 5090) is recorded below: INT8 is usable, per-row INT4 is not. Group-wise INT4 and the quality gate are implemented; their GPU results are pending. Economic evidence pending.

## Decision

Add a local Python experiment controller beside the existing PAN2 worker. It implements plan, run and evaluate commands and a single variant diagnostic path. It reuses native PAN2 and the pinned Rust ruv-FANN WSP editor. It does not depend on an external MetaHarness service, search for beneficial weight edits, rent GPUs or promote models.

ADR 207 keeps observations separate from generated hypotheses. That boundary is unchanged. The legacy four variant matrix remains available, but running it twice repeats two BF16 controls and cannot test hardware that cannot fit BF16.

| Alternative | Cost and latency | Decision |
| :--- | :--- | :--- |
| Two legacy matrices | Eight worker launches per case | Retained for compatibility |
| Local quantization controller | Six unique variants, reusable completed evidence | Selected for bounded single machine experiments |
| Automatic cloud search and promotion | Unknown spend and unvalidated model outcomes | Excluded from this delivery |

Six instead of eight launches removes 25% of scheduled jobs. This is not a measured 25% runtime or cost saving.

## Input and execution contracts

A versioned config binds pinned source, canonical checkpoint hashes, prompt files, seeds, settings, training configuration, VAE content and encoder snapshot revisions. Limits are 12 variants, 100 prompts, 16 seeds, 512 jobs and one day per worker. Only BF16, INT8 and INT4 modes are admitted. No shell command text comes from the config. IDs cannot traverse paths.

Case hashes include checkpoint and workload identity, excluding precision and hardware so matching cases can be compared across representations and machines. Snapshot revision identities exclude machine specific paths. The worker verifies the offline Qwen main cache selects the declared snapshot revision; mismatch rejects inference. A seeded shuffle controls order. Quantized only plans and single trials do not implicitly schedule a BF16 control.

States are running, completed, budget_stopped, failed and interrupted. Attempts are recorded before launch, timeout kills the worker process group, and any failure stops the suite. A local exclusive lock prevents concurrent resumes against one output. Scheduling reserves timeout times quoted hourly rate before launch, including declared overhead. This is an estimated scheduling limit, not a financial cap on an independently billing Vast rental.

Resume requires identical plan, source inputs, successful trial hashes and output hashes. Failed or interrupted evidence cannot be silently reused or retried. A budget change requires a new plan and directory. Prior failed spending still belongs in actual cost accounting. Inputs are rehashed after a suite; integrity failure rejects the run. There is no destructive cleanup, automatic retry or provider API.

## Optimization and measurement

Packed values and scales are preallocated and filled in bounded chunks, removing packed chunk lists and concatenation copies. Target discovery retains module and parameter names rather than all original floating tensors, allowing converted matrices to release source references promptly. There is no dense reconstruction cache. CPU tests preserve quantization and reload correctness; peak CPU and GPU performance improvements remain unmeasured.

The controller eliminates duplicate semantic jobs, avoids repeated BF16 controls across bit widths, verifies completed artifacts before reuse and hashes each distinct input once per check. Worker instrumentation separates checkpoint load, CPU quantization, synchronized full pipeline and total worker time. Full pipeline includes encoder and decoder, not just denoising. CUDA allocator peaks and host RSS remain distinct from total device memory, which still needs operator NVML evidence.

## Evidence and decision gates

Evaluation requires completed suite evidence, unchanged trial and video digests, exact paired case identities, a BF16 reference, a quantized candidate, finite actual allocated bills and output bound reviews. Reviews, invoices and worker receipts remain operator assertions, not remote attestations. Hashes bind content without proving honest review, actual GPU execution or complete external spending.

Cost per accepted output includes selected attempt charges and allocated setup, idle, storage, transfer and previous failure costs. Zero accepted outputs reject. Additional critical failures or less than 30% measured savings reject. Quality requires at least 30 matched cases and a one sided 95% Wilson upper bound no greater than 5% for newly rejected cases; improvements elsewhere do not offset regressions. Small samples return inconclusive. Correlated prompts and seeds can invalidate independence assumptions, so a diverse held out suite and scenario family review remain necessary.

A passing decision is a generation experiment recommendation. It always records automatic_promotion false and physical_promotion_allowed false. Hardware headroom, exact WSP rollback and blinded review remain independent gates. Calibrated metric extraction and physical ground truth remain required by ADR 207. No graph observation, snapshot schema, actuator or inference endpoint changes.

## Acceptance and rollback

| Requirement | Evidence |
| :--- | :--- |
| Quantized only hardware trials | Single variant command and schedule tests |
| Bounded execution | Budget refusal, worker failure and timeout cleanup tests |
| Immutable reuse | Resume, source mutation and output tampering tests |
| Actual cost and conservative quality | Paired 100 case fixture, expensive candidate rejection, critical failure rejection and small sample tests |
| Numeric and packed storage correctness | INT8, INT4, zero rows, odd width and strict Safetensors roundtrip tests |
| Hardware benefit | Pending user operated GPU trials and actual bills |

Run python -m unittest discover -s tests -v from tools/pan2-vast. All 13 tests pass with CPU PyTorch. No live PAN2 GPU, quality or dollar savings claim follows. Rollback removes the optional controller and uses the legacy matrix; canonical BF16 files and Rust WSP rollback receipts remain available.

## Update 2026-11-12: first GPU evidence and what it changed

One prompt, seed 42, 9 frames at 256x448, 4 steps. A smoke test, not the 30-case evaluation. Similarity is to the BF16 clip made on an H200.

| Variant | Hardware | Result |
| :--- | :--- | :--- |
| INT8 per row | H200, FA4 | SSIM 0.914, PSNR 27.5 dB, passes the gate |
| INT4 per row | H200, FA4 | SSIM 0.591, PSNR 13.2 dB, noise from the first frame, fails the gate |
| INT4 per row, base and edited | H200 | Identical clips, so the WSP edit had no visible effect |
| INT4 per row | RTX 5090, SDPA | Completes; peak 17.19 GB; clip matches the H200 INT4 clip (SSIM 0.952), so it is equally noise |
| INT8 per row | RTX 5090, SDPA | Server ready in about 175 s; 31.8 GB of 32 GB in use; clip matches the H200 INT8 clip (SSIM 0.932) |
| BF16 | H200 | Rough at the smoke size, so the smoke size itself limits quality |

Decisions taken:

1. **Unsupported GPU fallback.** Upstream attention uses FlashAttention-4 CuTe kernels that fail on sm120 ("launch shared memory exceeds current GPU"). An opt-in `--attn sdpa` backend replaces the three entry points at runtime. The pinned PAN2 checkout stays unmodified, the receipt records the backend, and the setting is part of case identity.
2. **Per-row INT4 is rejected.** One scale per 4096 wide row lets a single outlier destroy the row. Added `--group N` (one scale per N columns) and `--int8 name,...` (keep named matrices at 8 bits). Saved quantized state moves to schema `quant-state/2` and records both settings. On outlier heavy synthetic weights error falls as the group shrinks (CPU tests). Real model results are pending.
3. **Quality gate.** `python -m pan2kit gate` compares a clip with the BF16 clip by SSIM and PSNR and fails below 0.85 or 24 dB. The thresholds sit between the measured INT8 and INT4 results. It stops obviously broken variants early; it is similarity for one case, not perceptual or physical validation. The 30 case evaluator remains the decision gate.
4. **Metaharness gap.** `group` and `int8` are not yet variant fields in the plan, so two INT4 variants of one case would collide in the evaluator's (case, bits) pairing. Until that is fixed, group sweeps run through the worker directly.

Pending: group-wise INT4 and mixed precision results on a 5090, the larger size runs (17 frames, 480x832) that INT4's memory headroom might allow, and the 30 case evaluation.

See [ADR 210](210-pan2-serverless-service.md), [usage](../../tools/pan2-vast/METAHARNESS.md), [cost plan](../mission/pan2-quantization-cost-plan.md) and [ADR 207](207-pan2-physical-hypotheses.md).
