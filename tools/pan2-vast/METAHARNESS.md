# Quantization metaharness

A local experiment controller for the existing PAN2 worker. It plans, runs and evaluates experiments; it does not rent hardware, tune model weights automatically or promote a checkpoint. It has no dependency on an external MetaHarness service or claim to remote execution attestation.

## Prepare a bounded experiment

Complete the main README setup and WSP steps first. Work from tools/pan2-vast. Copy metaharness.example.json to metaharness.local.json. Set the actual VAE snapshot path, quoted hourly price and a budget that includes an allowance for setup, storage and transfers. Paths are relative to the config file, not the shell directory. The supplied price is illustrative.

```bash
mkdir -p experiments
python -m pan2kit.metaharness plan \
  --config metaharness.local.json --output experiments/h200-plan.json
python -m pan2kit.metaharness run \
  --plan experiments/h200-plan.json --output experiments/h200
```

The plan hashes checkpoints once per distinct file, binds prompts, training configuration, VAE file content and encoder snapshot revisions, and uses a seeded shuffled order. The example executes six unique variants instead of the legacy matrices' eight executions per case. This removes two duplicate BF16 controls, a 25% reduction in scheduled jobs, not a measured 25% reduction in cost or runtime.

Each fresh worker records checkpoint loading, CPU quantization, synchronized pipeline time, total worker time, allocated and reserved CUDA peaks and host peak RSS. Pipeline time includes encoding, denoising and decoding; it is not denoising only. Total GPU use from NVML and independent driver inventory remain operator collected evidence.

Quantization preallocates packed storage and row scales, fills them in bounded chunks and releases each source matrix reference after parametrization. These changes remove concatenation copies and the list retaining all original weights. CPU correctness tests verify the resulting storage and outputs. Peak CPU savings and GPU performance remain unmeasured.

The controller reserves timeout times hourly rate before a launch. It stops before scheduling work beyond the remaining estimated allowance and stops at any worker failure. A local lock prevents concurrent runs against one output directory. It never deletes failed evidence or retries automatically. Elapsed time and the quoted rate are estimates; they are not an invoice. A running Vast rental can continue billing after this controller stops. Setup, idle time, storage and transfer must be included in the final actual bill.

```bash
python -m pan2kit.metaharness run \
  --plan experiments/h200-plan.json --output experiments/h200 --resume
```

Resume requires the identical plan, unchanged inputs, and unchanged successful output and trial hashes. Completed work is reused. Failed or interrupted suites require a new directory after the cause is resolved. A budget stopped suite can resume with its original budget, but a changed budget requires a new plan and directory; do not erase previously billed costs from the comparison.

## Smaller GPU trials

Create a second config with only base_int8 or base_int4 in variants and the same prompt, seed, checkpoint, asset revisions and generation settings. A quantized only run does not try to load BF16 on the smaller GPU. Match its case hashes with the H200 BF16 evidence. Copy original asset revision receipts between machines, or use equivalent revision entries; absolute snapshot paths are excluded from comparison identity. Local VAE bytes and canonical checkpoint hashes must still match.

For a single job from a generated plan:

```bash
python -m pan2kit.trial --plan experiments/h200-plan.json \
  --job-id base_int4_bounce_42 --output experiments/one-int4
```

This diagnostic path verifies pinned source and input hashes but is outside the suite budget ledger. Use the controller's run command for a budgeted comparison. It does not masquerade as a completed six variant suite.

## Bind quality reviews and actual bills

Create reviews.local.json with this shape, using actual job IDs and output hashes from each run. A reviewer should score blinded outputs against a rubric fixed before seeing candidates. Hash binding prevents accidental stale review reuse; it does not prove a review is honest or blinded.

```json
{
  "baseline": {
    "base_bf16_bounce_42": {"output_sha256": "REPLACE", "accepted": true, "critical_failure": false, "reviewer": "reviewer_id"}
  },
  "candidate": {
    "base_int4_bounce_42": {"output_sha256": "REPLACE", "accepted": true, "critical_failure": false, "reviewer": "reviewer_id"}
  }
}
```

Create billing.local.json. trial amounts are actual allocated compute and retry costs for every selected job. shared_usd includes the comparison's entire allocated setup, storage, transfer and idle allowance, once per side. Retain invoices privately. No bill is inferred from a weight size or advertised hourly discount. Include costs from prior failed suites as shared overhead or documented trial allocation; the harness cannot discover omitted external spending.

```json
{
  "baseline": {"shared_usd": 0, "trials_usd": {"base_bf16_bounce_42": 1}},
  "candidate": {"shared_usd": 0, "trials_usd": {"base_int4_bounce_42": 0.5}}
}
```

```bash
python -m pan2kit.metaharness evaluate \
  --baseline experiments/h200 --candidate experiments/smaller-gpu \
  --base-variant base_bf16 --candidate-variant base_int4 \
  --reviews reviews.local.json --billing billing.local.json \
  --output experiments/decision.json
```

The evaluator verifies complete suite evidence, trial and video hashes, exact paired workload identities, BF16 reference and quantized candidate precision, finite nonnegative costs and output bound reviews. It separately compares original and edited checkpoints; a checkpoint mismatch cannot be passed off as quantization preservation.

A recommendation of accepted_for_generation requires at least 30 matched cases, at least 30% lower actual cost per accepted output, no additional critical failure and a one sided 95% Wilson upper bound of at most 5% for newly rejected cases. The bound gives no credit for gains elsewhere. Thirty cases with no new rejection are still inconclusive; approximately 52 zero regression cases are needed for that bound, and more if regressions occur. Independent case assumptions matter: correlated seeds and prompts can overstate evidence, so use a diverse held out suite and review uncertainty by scenario family before deployment.

The evaluator returns a nonzero exit code for rejection or inconclusive evidence. It writes a decision file with plan, billing and review hashes, and always records automatic_promotion false and physical_promotion_allowed false. The machine result is a generation experiment recommendation. Hardware headroom, exact WSP rollback, physical calibration and task safety checks remain separate required evidence. Human approval of deployment remains outside this controller.

## Run acceptance tests

```bash
python -m unittest discover -s tests -v
```

CPU tests cover scheduling, quantized only commands, budget refusal, failure and timeout handling, immutable inputs, cached artifact tampering, actual cost gates, small sample inconclusiveness and output bound reviews, as well as the quantizer's numeric and packed file checks. GPU inference, memory fit, kernel compatibility and quality remain pending your separate machine run.
