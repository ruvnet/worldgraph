#!/usr/bin/env bash
# Start a PAN2 serverless worker on a Vast instance: environment, weights, model server, then Vast's PyWorker.
# Idempotent: a cold worker that restarts skips everything already on its disk.
# Settings (template env): PAN2_BITS (0|4|8, default 8), PAN2_GROUP (scale group, default 0 = per row),
# PAN2_INT8 (comma list of matrix-name fragments kept at 8 bits when PAN2_BITS=4), PAN2_ATTN (fa4|sdpa, default fa4),
# PAN2_QUANT_STATE (load a saved quantized state instead of reading the BF16 checkpoint), PAN2_EXPORT_QUANT (write one),
# PAN2_PORT, PAN2_MAX_FRAMES / PAN2_MAX_PIXELS / PAN2_MAX_STEPS (request caps; defaults are the smoke size).
#
# Two logs, on purpose. Vast's PyWorker watches MODEL_LOG for the server's ready line, so only progress
# markers and the server's own output go there. Everything else (installs, the kit's unit tests, which
# print that same ready line) goes to the setup log.
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${WORKSPACE_DIR:-/workspace}"
export MODEL_LOG="${MODEL_LOG:-$W/pan2-server.log}" PAN2_PORT="${PAN2_PORT:-18300}"
SETUP_LOG="$W/pan2-setup.log"
PYWORKER_COMMIT=f1754c25680450ee57cea0fa09583404e2484bf1
mkdir -p "$W"
step() { printf '[%s] === %s ===\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$MODEL_LOG" >> "$SETUP_LOG"; }

setup() {
  set -e
  cd "$KIT"
  if [ ! -f "$W/.pan2-env-ready" ]; then
    step "system packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq git build-essential curl ca-certificates ffmpeg jq >/dev/null
    step "python environment"
    if [ ! -x "$W/conda/bin/conda" ]; then
      curl -fsSL -o /tmp/mf.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
      bash /tmp/mf.sh -b -p "$W/conda" >/dev/null
    fi
    set +u; source "$W/conda/etc/profile.d/conda.sh"
    conda env list | grep -q pan2-wsp || conda create -n pan2-wsp python=3.14 -y >/dev/null
    conda activate pan2-wsp; set -u
    bash bootstrap.sh
    touch "$W/.pan2-env-ready"
  fi
  if [ ! -f models/paths.json ]; then
    step "model weights"
    set +u; source "$W/conda/etc/profile.d/conda.sh"; conda activate pan2-wsp; set -u
    HF_HOME="$KIT/hf-cache" python prepare_models.py --repo PAN2 --dest models  # resumes a partial download
  fi
  test -s models/paths.json
}

serve() {
  cd "$KIT"
  set +u; source "$W/conda/etc/profile.d/conda.sh"; conda activate pan2-wsp; set -u
  local vae; vae=$(python -c "import json; print(json.load(open('models/paths.json'))['vae'])")
  [ -d "$vae" ] || { echo "VAE snapshot directory is missing: $vae"; return 1; }
  step "model server (bits=${PAN2_BITS:-8} attention=${PAN2_ATTN:-fa4})"
  HF_HOME="$KIT/hf-cache" HF_HUB_OFFLINE=1 PYTHONPATH="$KIT" python -m torch.distributed.run --standalone --nproc_per_node=1 \
    --module pan2kit.serve --repo "$KIT/PAN2" --bits "${PAN2_BITS:-8}" --group "${PAN2_GROUP:-0}" --int8 "${PAN2_INT8:-}" --attn "${PAN2_ATTN:-fa4}" \
    --max-frames "${PAN2_MAX_FRAMES:-9}" --max-pixels "${PAN2_MAX_PIXELS:-114688}" --max-steps "${PAN2_MAX_STEPS:-4}" \
    ${PAN2_QUANT_STATE:+--quant-state "$PAN2_QUANT_STATE"} ${PAN2_EXPORT_QUANT:+--export-quant "$PAN2_EXPORT_QUANT"} \
    --port "$PAN2_PORT" --workdir "$W/pan2-serve" \
    --checkpoint_path "$KIT/models/base" --wan_vae_checkpoint "$vae" --dtype bf16 \
    --offload models --offload_prefetch false --compile false \
    --prompt warmup --seed 42 --output_path "$W/pan2-serve/warmup.mp4" \
    --video_length 9 --video_height 256 --video_width 448 --num_inference_steps 4 \
    --training_config "$KIT/PAN2/config/sft_29B_720p.yaml" >> "$MODEL_LOG" 2>&1
}

run_model() {
  # One model process per instance: a second start.sh on the same boot leaves the running one alone.
  exec 9> "$W/.pan2-start.lock"
  flock -n 9 || { echo "[$(date -u +%FT%TZ)] setup or server already running; not starting another" >> "$SETUP_LOG"; return 0; }
  : > "$MODEL_LOG"  # a restarted worker must not see an old ready line
  # Not written as `( setup ) || ...`: bash ignores `set -e` inside the left side of an || list.
  local rc
  ( setup ) >> "$SETUP_LOG" 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then echo "PAN2_SETUP_FAILED setup exit $rc; see $SETUP_LOG" | tee -a "$SETUP_LOG" >> "$MODEL_LOG"; return 1; fi
  ( set -e; serve ) >> "$SETUP_LOG" 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then echo "PAN2_SETUP_FAILED server exit $rc" | tee -a "$SETUP_LOG" >> "$MODEL_LOG"; return 1; fi
}

: >> "$MODEL_LOG"
run_model &

if [ "${PAN2_NO_PYWORKER:-}" = "1" ]; then wait; exit 0; fi
# Vast's PyWorker: pinned checkout plus our worker definition, launched by their own start script.
S="$W/vast-pyworker"
if [ ! -d "$S/.git" ]; then
  command -v git >/dev/null || { apt-get update -qq; apt-get install -y -qq git >/dev/null; }
  git clone -q https://github.com/vast-ai/pyworker "$S" && git -C "$S" checkout -q "$PYWORKER_COMMIT"
fi
mkdir -p "$S/workers/pan2"; : > "$S/workers/pan2/__init__.py"; cp "$KIT/serverless/worker.py" "$S/workers/pan2/worker.py"
export BACKEND=pan2
exec bash "$S/start_server.sh"
