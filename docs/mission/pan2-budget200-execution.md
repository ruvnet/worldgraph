# PAN2 GPU execution authorization and admission

The user authorized implementation and an end to end GPU run within USD 200. This supersedes the cost plan's proposed USD 60 plus USD 180 stage caps. It does not authorize exceeding USD 200.

## Allocation

Reserve USD 50 for setup, storage, transfer, idle billing, failed attempts and shutdown margin. Admit at most USD 150 estimated compute. Within that compute allowance, stop the mechanical smoke phase at USD 40 and require its integrity and GPU completion gates before using the remaining USD 110 for representative sampling. Refresh the exact instance rate and remaining actual budget before each phase. These are allocations within one ceiling, not additional budgets.

metaharness.budget200.example.json sets budget_usd 200 and declared overhead 50. Its hourly_usd is deliberately zero so planning refuses until the operator substitutes the actual quoted instance rate. It retains six unique BF16, INT8 and INT4 original and edited variants. The budget controller is a local scheduling estimate, not a guarantee against independently continuing Vast rental bills. Live admission also requires a verified lifecycle stop mechanism and billing monitor appropriate to the selected instance. Existing shared GPU work must not be interrupted or destroyed.

## Actual admission attempt

Software Factory command execution succeeded. A read only Vast preflight was executed there. It exited 2 with VAST_API_KEY_NOT_IN_EXECUTION_ENVIRONMENT before making any Vast API request. The primary desktop and a login shell also did not receive that credential. ruOS reports the credential name present in its vault, but its exposed tools have no operation to bind an existing vault entry to a selected desktop executor. Values were not requested, printed, copied into commands or committed.

No instance was rented, started, stopped or changed. New Vast spend initiated by this attempt is USD 0; existing account billing was not queried and is unknown. GPU E2E is not started. This admission failure is not a quantization benchmark or an inference result.

## Unblock and execute

1. Make the existing VAST_API_KEY available to Software Factory via the approved ruOS secret injection mechanism. Do not paste it in chat, scripts, logs or PRs. This may require the ruOS operator because the current plugin only exposes secret store, list names and delete.
2. Run python -m pan2kit.vast_preflight --output experiments/vast-admission.json from tools/pan2-vast. It only lists instance metadata, refuses credential forwarding redirects and does not return endpoint or secret fields.
3. Select the user's existing suitable GPU, verify authorized SSH access and host identity, actual rate, RAM, disk and CUDA compatibility. Keep the API key on the controller, not on a rented GPU. No existing instance connection or SSH credential has been verified yet.
4. Bind the lifecycle and billing stop conditions to the selected experiment resources before consuming compute. Avoid relying on the ruOS desktop autosleep schedule as a financial control.
5. Fill the example config with actual rate, paths and immutable model assets. Run the metaharness smoke suite with budget_usd 90 and overhead 50, limiting estimated compute to USD 40. Count all costs against the USD 200 total.
6. After successful smoke evidence, recompute remaining budget from actual bills. Create a separate full resolution pilot plan with that remaining budget, retaining the unspent overhead reserve. Do not add a fresh USD 200 allowance. Stop on failure, timeout, integrity change or exhaustion. Retain rejected outputs and logs.
7. Evaluate actual allocated bills and blinded output bound reviews. A small pilot can be mechanically complete but statistically inconclusive. Require the existing cost and quality gates before claiming savings. Physical forecast promotion remains false.

## Evidence

The Software Factory admission receipt is recorded as a redacted JSON object beside this document. Four new CPU tests cover missing credential refusal without network access, inventory field filtering, redirect refusal and nonleaking remote errors. They pass locally. Previous GPU and accuracy evidence remains pending.
