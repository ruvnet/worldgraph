# PAN2 quantization cost validation plan

## Decision and objective

Measure cost per accepted output before selecting smaller GPU hardware. Start with the existing H200 setup, test INT8, then INT4, and only then trial smaller GPUs. No savings or deployment readiness is claimed until real GPU evidence passes the gates below.

Inputs: pinned PAN2 source and checkpoint revisions, original and WSP edited native checkpoints, one fixed held out prompt suite, seeds, actual instance invoices and the runner receipts.
Outputs: measured storage, host RAM, GPU memory, latency, acceptance rates, total cost and a reproducible decision record.
Assumptions: a single Linux NVIDIA GPU, compatible CUDA kernels, model offloading, and a user operated Vast account. This plan does not provision or authorize a rental.

## Expected storage versus actual cost

For an approximately 29 billion parameter transformer, theoretical payloads are 58 GB BF16, 29 GB INT8 and 14.5 GB INT4. These are decimal GB, not GiB. The current adapter covers selected block matrices, adds row scales, and leaves other weights unchanged. Encoder, VAE, buffers, activations and temporary BF16 reconstruction remain additional costs.

The planned storage reductions of approximately 50% and 75% apply to covered matrices. They do not establish equivalent VRAM, disk footprint, runtime or dollar reductions. Original and edited canonical checkpoints remain on disk. The current WSP workflow copies a full checkpoint for an edit.

## Trial sequence

| Stage | Inputs and action | Evidence and exit gate |
| :--- | :--- | :--- |
| 0. Freeze | Record repository, package, model, patch and prompt hashes; actual GPU variant, driver, CUDA, RAM and disk; quoted rate and storage terms | Six CPU tests pass, source identity is fixed, enough local capacity exists |
| 1. Mechanical GPU check | On H200, run the documented INT8 four variant smoke matrix, then INT4 with new output directories | All workers produce valid outputs and receipts, source hashes remain unchanged, exact rollback passes, no nonfinite outputs or crashes |
| 2. Representative pilot | Use full target dimensions, frames and sampling steps; two prompts and three fixed seeds; both four variant matrices | Measure cost and duration before scaling; report failures, quality decisions and each memory peak |
| 3. Hardware descent | Trial RTX PRO 6000 Blackwell 96 GB, then H100 80 GB if economical, then RTX 5090 32 GB only after measured headroom suggests fit | Exact GPU and kernel compatibility, successful full workload, at least 10% total VRAM headroom measured with NVML, and no unacceptable host swapping |
| 4. Held out evaluation | Ten preregistered prompts, three fixed seeds, original and edited BF16, INT8 and INT4; run matching baseline controls on each candidate GPU | Quality gate and cost gate pass on the same workload; retain every attempt and invoice |
| 5. Review | Commit aggregate results and small provenance files, link large artifacts by immutable digest | Explicit selection or rejection; no automatic model promotion or graph ingestion |

The current matrix starts a fresh process for each variant, runs BF16 first, stops at the first failure, and accepts one prompt per invocation. Both bit widths therefore execute eight workers per prompt and seed, with duplicate BF16 controls. Budget for actual executions, not six distinct variants. A smaller GPU that cannot run the BF16 control cannot complete the current matrix. Use the implemented quantization metaharness for a single variant or quantized only suite, retaining H200 baseline evidence and documenting the cross hardware comparison. The legacy matrix remains unchanged. Never relabel a skipped baseline as passed.

Keep production settings fixed between variants. Exclude packed export from timing comparisons. Record cold process loading, quantization, end to end generation and billing separately. The current elapsed receipt includes construction and loading; the worker now records synchronized full pipeline time plus load and quantization phases, but this is not a denoising only benchmark. Use NVML sampling for total GPU use because PyTorch allocator peaks exclude other allocations. Record whether caches were warm. The present fixed order can introduce bias; the metaharness implements seeded order randomization, while the legacy matrix retains fixed order. Use counterbalanced repetitions before drawing small latency conclusions.

## Quality and integrity gates

1. Preserve canonical hashes and pass byte exact Rust WSP rollback. Reject malformed exports, schema mismatches and source changes.
2. Compare base INT8 and base INT4 against base BF16. Separately compare edited INT8 and edited INT4 against edited BF16. Assess the WSP edit against original BF16 as its own experiment. Quantization preservation does not prove the edit is beneficial.
3. Before looking at outputs, fix a rubric for object persistence, temporal continuity, action adherence and prohibited task failures. Use blinded paired review with the same prompts and seeds. Use identical decoder and output settings. Do not use video hash equality as a quality metric.
4. Proposed pilot tolerance: quantized acceptance rate no more than five percentage points below its BF16 reference, with zero additional predefined critical failures. These are proposed engineering gates, not established model guarantees. With only 30 prompt and seed cases, report paired uncertainty and treat an inconclusive interval as requiring more data rather than proof of equivalence.
5. For physical decisions, require calibrated ground truth, a validated metric extractor, task specific position and collision tolerances, and comparison with a simple baseline. These prerequisites are not supplied by the current kit. Until available, label only visual and mechanical acceptance; physical forecast promotion stays blocked.

Do not tune quantization or WSP edits on the held out suite. Separate development prompts and preserve rejected candidates.

## Cost accounting and break even

Use actual billed USD totals, including failed attempts and retries:

```text
cost_per_accepted_output =
  (compute + storage + transfer + amortized_setup_cost) / accepted_outputs

steady_compute_ratio =
  (candidate_hourly_rate / baseline_hourly_rate)
  * (candidate_seconds_per_attempt / baseline_seconds_per_attempt)
  * (baseline_acceptance_rate / candidate_acceptance_rate)

saving_fraction = 1 - candidate_total_cost_per_accepted / baseline_total_cost_per_accepted
```

If no output is accepted, report cost per accepted output as undefined and fail the gate. Include setup once in the experiment total; for deployment projections state the number of outputs over which setup is amortized. Report persistent storage costs separately, including charges while GPU compute is stopped.

Illustrative rate arithmetic from the earlier discussion follows. These USD values are examples from a retrieved Vast table with a stale update marker, not current bookable quotes. Refresh actual offers before a trial.

| Example GPU | Example USD per hour | Compute cost for 100 occupied hours | Equal acceptance break even slowdown versus H200 |
| :--- | ---: | ---: | ---: |
| H200 141 GB | 5.37 | 537 | 1.00 times |
| RTX PRO 6000 workstation 96 GB | 1.60 | 160 | 3.36 times |
| RTX 5090 32 GB | 0.77 | 77 | 6.97 times |

The 70.2% and 85.7% hourly reductions assume equal runtime and acceptance. For example, an RTX PRO 6000 taking twice as long costs 0.596 times the H200 compute cost per accepted output at equal acceptance, a 40.4% reduction. At four times as long it costs 1.192 times as much, a 19.2% increase. Storage, transfer and setup can change that result.

Source for illustrative rates: https://vast.ai/article/how-much-does-it-cost-to-rent-a-gpu-in-the-cloud-live-pricing-guide

## Budget and stop conditions

Proposed first approval boundary is USD 60 for mechanical checks and a further USD 180 for the representative pilot, including billed setup, storage and transfer. These are proposed caps, not authorized spend or completion estimates. Use the actual offer and measured pilot duration to estimate the held out suite before starting it. The user's separate GPU operation controls execution.

Stop when a cap is reached, a worker times out, source integrity fails, CUDA kernels are incompatible, outputs are nonfinite, or host or device memory is exhausted. Preserve failure logs. Resolve a failed stage before advancing. Do not buy a workstation from theoretical payload estimates.

## Results and decision record

For each attempt retain: case ID, prompt hash, seed, GPU model and VRAM, source and checkpoint hashes, WSP receipt hash, bit width, source byte coverage, retained parameter bytes, peak allocated and reserved bytes, NVML peak, host peak RSS, cold setup and generation durations, actual billed cost, output digest, rubric outcome, reviewer and failure reason. Current receipts provide only part of this list; instrumentation and blinded scoring remain planned work.

Decision target: at least 30% lower measured cost per accepted output, with the preregistered quality gate satisfied and all integrity gates passing. This is a project target, not a predicted result. Select the cheapest validated hardware and precision combination. Keep BF16 available for rollback. WorldGraph observations stay unchanged.

Acceptance test: reproduce the held out comparison from pinned inputs, verify source hashes and exact rollback, and independently recompute at least a 30% cost reduction from all billed attempts and accepted outcomes. If physical calibration is missing, the decision applies only to generation experiments.

## Implemented controller

[ADR 208](../adr/208-pan2-quantization-metaharness.md) and the [usage guide](../../tools/pan2-vast/METAHARNESS.md) describe the implemented local controller. It schedules six unique variants, supports quantized only runs and validated resume, reserves estimated cost before launch, and evaluates actual allocated bills plus output bound reviews. The decision gate requires at least 30% cost reduction and a one sided 95% upper bound no greater than 5% on newly rejected cases, with zero additional critical failures. Thirty samples may still be inconclusive. Estimates do not cap independently running rental bills. GPU, NVML, invoice and blinded quality evidence remain pending.

