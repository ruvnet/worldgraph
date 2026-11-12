#!/usr/bin/env bash
# Start a PAN2 serverless worker on a Vast instance: environment, weights, model server, then Vast's PyWorker.
# Idempotent: a cold worker that restarts skips everything already on its disk.
# Settings (template env): PAN2_BITS (0|4|8, default 4), PAN2_ATTN (fa4|sdpa, default fa4), PAN2_PORT.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${WORKSPACE_DIR:-/workspace}"
export MODEL_LOG="${MODEL_LOG:-$W/pan2-server.log}" PAN2_PORT="${PAN2_PORT:-18300}"
PYWORKER_COMMIT=f1754c25680450ee57cea0fa09583404e2484bf1
mkdir -p "$W"; : > "$MODEL_LOG"  # a restarted worker must not see an old ready line
fail() { echo "PAN2_SETUP_FAILED $*" | tee -a "$MODEL_LOG"; }
step() { printf '[%s] === %s ===\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$MODEL_LOG"; }

setup_and_serve() {
  cd "$KIT"
  if [ ! -f "$W/.pan2-env-ready" ]; then
    step "system packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq git build-essential curl ca-certificates ffmpeg jq >/dev/null
    step "python environment"
    [ -x "$W/conda/bin/conda" ] || { curl -fsSL -o /tmp/mf.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh; bash /tmp/mf.sh -b -p "$W/conda" >/dev/null; }
    source "$W/conda/etc/profile.d/conda.sh"
    conda env list | grep -q pan2-wsp || conda create -n pan2-wsp python=3.14 -y >/dev/null
    conda activate pan2-wsp
    bash bootstrap.sh
    touch "$W/.pan2-env-ready"
  else
    source "$W/conda/etc/profile.d/conda.sh"; conda activate pan2-wsp
  fi
  export HF_HOME="$KIT/hf-cache"
  if [ ! -f models/paths.json ]; then
    step "model weights"
    python prepare_models.py --repo PAN2 --dest models
  fi
  local vae; vae=$(python -c "import json; print(json.load(open('models/paths.json'))['vae'])")
  step "model server (bits=${PAN2_BITS:-4} attention=${PAN2_ATTN:-fa4})"
  HF_HUB_OFFLINE=1 PYTHONPATH="$KIT" exec python -m torch.distributed.run --standalone --nproc_per_node=1 \
    --module pan2kit.serve --repo "$KIT/PAN2" --bits "${PAN2_BITS:-4}" --attn "${PAN2_ATTN:-fa4}" \
    --port "$PAN2_PORT" --workdir "$W/pan2-serve" \
    --checkpoint_path "$KIT/models/base" --wan_vae_checkpoint "$vae" --dtype bf16 \
    --offload models --offload_prefetch false --compile false \
    --prompt warmup --seed 42 --output_path "$W/pan2-serve/warmup.mp4" \
    --video_length 9 --video_height 256 --video_width 448 --num_inference_steps 4 \
    --training_config "$KIT/PAN2/config/sft_29B_720p.yaml"
}

( setup_and_serve >> "$MODEL_LOG" 2>&1 || fail "exit $?" ) &

if [ "${PAN2_NO_PYWORKER:-}" = "1" ]; then wait; exit 0; fi
# Vast's PyWorker: pinned checkout plus our worker definition, launched by their own start script.
S="$W/vast-pyworker"
if [ ! -d "$S/.git" ]; then
  git clone -q https://github.com/vast-ai/pyworker "$S"
  git -C "$S" checkout -q "$PYWORKER_COMMIT"
fi
mkdir -p "$S/workers/pan2"; : > "$S/workers/pan2/__init__.py"; cp "$KIT/serverless/worker.py" "$S/workers/pan2/worker.py"
export BACKEND=pan2
exec bash "$S/start_server.sh"
